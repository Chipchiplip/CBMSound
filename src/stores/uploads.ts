import { create } from 'zustand'
import { appError, type AppError, type DriveTrack, type UploadJob, isAudioFile } from '../types'
import { generateDriveFileId } from '../services/drive'
import { uploadFileResumable } from '../services/upload'
import { getSessionGeneration, isSessionCurrent, subscribeSessionReset } from '../services/session'
import { useLibraryStore } from './library'
import { readMetadataFromFile } from '../services/audioMetadata'
import { canRetryUploadJob } from '../utils/uploadPresentation'
export { canRetryUploadJob, formatBytes, uploadEtaText, uploadProgress } from '../utils/uploadPresentation'

interface UploadState {
  jobs: UploadJob[]
  processing: boolean
  duplicatePolicy: 'keep' | 'skip'
  setDuplicatePolicy: (policy: 'keep' | 'skip') => void
  addFiles: (files: File[]) => void
  start: () => Promise<void>
  retry: (id: string) => void
  cancel: (id: string) => void
  cancelAll: () => void
  reset: () => void
  remove: (id: string) => void
  clearCompleted: () => void
}

interface JobContext { generation: number; userId: string; folderId: string }
const controllers = new Map<string, AbortController>()
const contexts = new Map<string, JobContext>()
let processingRun = 0

function describe(error: unknown): AppError {
  if (error instanceof Error) return Object.assign(error, { retryable: Boolean((error as { retryable?: boolean }).retryable) })
  return appError('Upload thất bại. Hãy thử lại.', { retryable: true })
}

function uniqueDriveName(name: string, existing: Set<string>): string {
  if (!existing.has(name.toLocaleLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let index = 2
  while (existing.has(`${stem} (${index})${ext}`.toLocaleLowerCase())) index++
  return `${stem} (${index})${ext}`
}

function currentContext(): JobContext | undefined {
  const { user, folder } = useLibraryStore.getState()
  if (!user?.permissionId || !folder) return undefined
  return { generation: getSessionGeneration(), userId: user.permissionId, folderId: folder.folderId }
}

function matchesContext(context: JobContext): boolean {
  const current = currentContext()
  return isSessionCurrent(context.generation) && Boolean(current && current.userId === context.userId && current.folderId === context.folderId)
}

function retryWait(attempt: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(appError('Upload đã bị hủy.', { reason: 'uploadCancelled' })); return }
    const abort = () => { globalThis.clearTimeout(timer); reject(appError('Upload đã bị hủy.', { reason: 'uploadCancelled' })) }
    const timer = globalThis.setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, Math.min(30000, 500 * 2 ** attempt) + Math.random() * 700)
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function generateId(signal: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw appError('Upload đã bị hủy.', { reason: 'uploadCancelled' })
    try { return await generateDriveFileId() }
    catch (error) {
      if (!(error as AppError).retryable || attempt >= 5) throw error
      await retryWait(attempt, signal)
    }
  }
}

const runnable = (job: UploadJob) => job.state === 'queued' || job.state === 'paused' || job.state === 'needsAuth'

export const useUploadStore = create<UploadState>((set, get) => ({
  jobs: [],
  processing: false,
  duplicatePolicy: 'keep',
  setDuplicatePolicy: (duplicatePolicy) => set({ duplicatePolicy }),
  addFiles: (files) => {
    const context = currentContext()
    const jobs: UploadJob[] = files.map((file) => {
      const id = crypto.randomUUID()
      if (context) contexts.set(id, context)
      const valid = isAudioFile(file) && file.size > 0
      return {
        id, file, state: valid ? 'queued' : 'error', sentBytes: 0, confirmedBytes: 0, totalBytes: file.size,
        error: valid ? undefined : appError(file.size === 0 ? 'File nhạc rỗng, không có dữ liệu để upload.' : 'Ứng dụng nhận MP3, WAV, FLAC, AAC, M4A, OGG và các file audio khác.', { reason: 'invalidAudioFile' }),
      }
    })
    set((state) => ({ jobs: [...state.jobs, ...jobs] }))
  },

  start: async () => {
    if (get().processing) return
    const run = ++processingRun
    set({ processing: true })
    try {
      while (run === processingRun) {
        const job = get().jobs.find(runnable)
        if (!job) break
        const { folder } = useLibraryStore.getState()
        const context = contexts.get(job.id) || currentContext()
        if (!context || !matchesContext(context)) {
          set({ jobs: get().jobs.map((item) => item.id === job.id ? { ...item, state: 'error', error: appError('Tài khoản hoặc thư mục đã thay đổi. Chọn lại file trong thư viện hiện tại.', { reason: 'uploadContextChanged' }) } : item) })
          continue
        }
        if (!folder?.ownedByMe || !folder.canAddChildren) {
          set({ jobs: get().jobs.map((item) => item.id === job.id ? { ...item, state: 'error', error: appError('Chỉ chủ thư viện có quyền thêm file mới có thể upload nhạc.', { status: 403 }) } : item) })
          continue
        }
        if (!isAudioFile(job.file) || job.file.size === 0) {
          set({ jobs: get().jobs.map((item) => item.id === job.id ? { ...item, state: 'error', error: appError('File này không phải audio hợp lệ hoặc không có dữ liệu.', { reason: 'invalidAudioFile' }) } : item) })
          continue
        }
        contexts.set(job.id, context)
        const existingNames = new Set(useLibraryStore.getState().tracks.filter((track) => !track.unavailable).map((track) => track.name.toLocaleLowerCase()))
        if (!job.resume && get().duplicatePolicy === 'skip' && existingNames.has(job.file.name.toLocaleLowerCase())) {
          set({ jobs: get().jobs.map((item) => item.id === job.id ? { ...item, state: 'skipped', error: undefined } : item) })
          continue
        }
        const controller = new AbortController()
        controllers.set(job.id, controller)
        const active = () => run === processingRun && !controller.signal.aborted && matchesContext(context) && get().jobs.some((item) => item.id === job.id && item.state !== 'cancelled')
        const update = (patch: Partial<UploadJob>) => {
          if (active()) set({ jobs: get().jobs.map((item) => item.id === job.id ? { ...item, ...patch } : item) })
        }
        update({ state: 'uploading', error: undefined })
        try {
          const fileId = job.resume?.fileId || await generateId(controller.signal)
          if (!active()) continue
          const driveName = job.resume?.driveName || uniqueDriveName(job.file.name, existingNames)
          const resume = { ...job.resume, fileId, offset: job.resume?.offset || 0, driveName }
          update({ resume })
          const uploadFile = driveName === job.file.name ? job.file : new File([job.file], driveName, { type: job.file.type, lastModified: job.file.lastModified })
          const uploaded = await uploadFileResumable(uploadFile, context.folderId, fileId, {
            signal: controller.signal, resume,
            onResume: (next) => update({ resume: next }),
            onProgress: (sentBytes, confirmedBytes) => update({ sentBytes, confirmedBytes }),
            onState: (state) => update({ state }),
          })
          if (!active()) continue
          const track: DriveTrack = { ...uploaded, size: Number(uploaded.size), appManaged: true }
          // Drive completion is final even if local tags or IndexedDB fail afterward.
          // Publish the confirmed record before marking the job done: clearing a
          // completed job while tag parsing is pending must not hide its song.
          const published = useLibraryStore.getState().addTrack(track)
          update({ state: 'done', sentBytes: job.file.size, confirmedBytes: job.file.size, result: track, error: undefined })
          try { await published }
          catch (error) {
            if (active()) useLibraryStore.getState().setError(`File đã lưu lên Drive; chưa cập nhật được cache cục bộ: ${describe(error).message}. Bấm Đồng bộ để tải lại thư viện.`)
          }
          if (!active()) continue
          try {
            const metadata = await readMetadataFromFile(job.file)
            if (!active()) continue
            Object.assign(track, metadata, { metadataChecked: true })
            update({ result: track })
          } catch { /* Missing/unsupported tags never invalidate a completed upload. */ }
          if (!active()) continue
          try { await useLibraryStore.getState().addTrack(track) }
          catch (error) {
            if (active()) useLibraryStore.getState().setError(`File đã lưu lên Drive; chưa cập nhật được cache cục bộ: ${describe(error).message}. Bấm Đồng bộ để tải lại thư viện.`)
          }
        } catch (error) {
          const uploadError = describe(error)
          if (active()) {
            update({ state: uploadError.status === 401 ? 'needsAuth' : uploadError.reason === 'uploadCancelled' ? 'cancelled' : 'error', error: uploadError })
          }
          if (uploadError.status === 401) break
        } finally { controllers.delete(job.id) }
      }
    } finally {
      if (run === processingRun) set({ processing: false })
    }
  },

  retry: (id) => {
    const job = get().jobs.find((item) => item.id === id)
    if (!job || !canRetryUploadJob(job) || controllers.has(id)) return
    const context = contexts.get(id)
    if (context && !matchesContext(context)) {
      set({ jobs: get().jobs.map((item) => item.id === id ? { ...item, error: appError('Tài khoản hoặc thư mục đã thay đổi. Chọn lại file trong thư viện hiện tại.', { reason: 'uploadContextChanged' }) } : item) })
      return
    }
    set({ jobs: get().jobs.map((item) => item.id === id ? { ...item, state: 'queued', error: undefined } : item) })
    void get().start()
  },
  cancel: (id) => {
    controllers.get(id)?.abort()
    set({ jobs: get().jobs.map((job) => job.id === id && job.state !== 'done' && job.state !== 'skipped' ? { ...job, state: 'cancelled', error: undefined } : job) })
  },
  cancelAll: () => {
    for (const controller of controllers.values()) controller.abort()
    set({ jobs: get().jobs.map((job) => runnable(job) || job.state === 'uploading' || job.state === 'retrying' ? { ...job, state: 'cancelled', error: undefined } : job) })
  },
  reset: () => {
    ++processingRun
    for (const controller of controllers.values()) controller.abort()
    controllers.clear()
    contexts.clear()
    set({ jobs: [], processing: false })
  },
  remove: (id) => {
    controllers.get(id)?.abort()
    contexts.delete(id)
    set({ jobs: get().jobs.filter((job) => job.id !== id) })
  },
  clearCompleted: () => {
    const kept = get().jobs.filter((job) => job.state !== 'done' && job.state !== 'cancelled' && job.state !== 'skipped')
    const ids = new Set(kept.map((job) => job.id))
    for (const id of contexts.keys()) if (!ids.has(id)) contexts.delete(id)
    set({ jobs: kept })
  },
}))

subscribeSessionReset(() => useUploadStore.getState().reset())
useLibraryStore.subscribe(() => {
  for (const [id, controller] of controllers) {
    const context = contexts.get(id)
    if (context && !matchesContext(context)) {
      controller.abort()
      useUploadStore.getState().cancel(id)
    }
  }
})
