import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appError, type DriveTrack } from '../types'
import { uploadFileResumable, type UploadCallbacks } from '../services/upload'
import { generateDriveFileId } from '../services/drive'
import { readMetadataFromFile } from '../services/audioMetadata'
import { invalidateSession } from '../services/session'
import { canRetryUploadJob, useUploadStore } from './uploads'

const library = vi.hoisted(() => ({
  user: { permissionId: 'owner-a' },
  folder: { folderId: 'folder-a', ownedByMe: true, canAddChildren: true },
  tracks: [] as DriveTrack[],
  addTrack: vi.fn(),
  setError: vi.fn(),
  listeners: new Set<() => void>(),
}))
vi.mock('./library', () => ({ useLibraryStore: {
  getState: () => library,
  subscribe: (listener: () => void) => { library.listeners.add(listener); return () => library.listeners.delete(listener) },
} }))
vi.mock('../services/drive', () => ({ generateDriveFileId: vi.fn() }))
vi.mock('../services/upload', () => ({ uploadFileResumable: vi.fn() }))
vi.mock('../services/audioMetadata', () => ({ readMetadataFromFile: vi.fn() }))

const track: DriveTrack = { id: 'stable-id', name: 'song.mp3', size: 16, mimeType: 'audio/mpeg', createdTime: '2026-01-01', modifiedTime: '2026-01-01' }
function file(name = 'song.mp3'): File { return new File([new Uint8Array(16)], name, { type: name.endsWith('.mp3') ? 'audio/mpeg' : 'text/plain' }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useUploadStore.getState().reset()
  useUploadStore.getState().setDuplicatePolicy('keep')
  library.user = { permissionId: 'owner-a' }
  library.folder = { folderId: 'folder-a', ownedByMe: true, canAddChildren: true }
  library.tracks = []
  library.addTrack.mockReset().mockResolvedValue(undefined)
  library.setError.mockReset()
  vi.mocked(generateDriveFileId).mockReset().mockResolvedValue('stable-id')
  vi.mocked(uploadFileResumable).mockReset().mockResolvedValue(track)
  vi.mocked(readMetadataFromFile).mockReset().mockResolvedValue({ artist: 'Artist' })
})

describe('upload queue and account lifecycle', () => {
  it('does not retry an invalid or empty file', async () => {
    useUploadStore.getState().addFiles([file('document.txt'), new File([], 'empty.mp3', { type: 'audio/mpeg' })])
    for (const job of useUploadStore.getState().jobs) useUploadStore.getState().retry(job.id)
    await useUploadStore.getState().start()
    expect(useUploadStore.getState().jobs.every((job) => job.state === 'error')).toBe(true)
    expect(generateDriveFileId).not.toHaveBeenCalled()
    expect(uploadFileResumable).not.toHaveBeenCalled()
  })

  it('retries the same file ID and resumable session instead of creating a duplicate', async () => {
    vi.mocked(uploadFileResumable).mockImplementationOnce(async (_file, _folder, id, cb) => {
      cb.onResume?.({ fileId: id, sessionUrl: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=session', offset: 8, driveName: 'song.mp3' })
      cb.onProgress(16, 8)
      throw appError('Network lost', { retryable: true })
    })
    useUploadStore.getState().addFiles([file()])
    await useUploadStore.getState().start()
    const failed = useUploadStore.getState().jobs[0]
    expect(failed.state).toBe('error')
    expect(failed.resume?.offset).toBe(8)
    useUploadStore.getState().retry(failed.id)
    await vi.waitFor(() => expect(useUploadStore.getState().processing).toBe(false))
    expect(generateDriveFileId).toHaveBeenCalledTimes(1)
    expect(uploadFileResumable).toHaveBeenLastCalledWith(expect.any(File), 'folder-a', 'stable-id', expect.objectContaining({ resume: failed.resume }))
    expect(useUploadStore.getState().jobs[0].state).toBe('done')
  })

  it('pauses for authentication and preserves the upload until an explicit restart', async () => {
    vi.mocked(uploadFileResumable).mockRejectedValueOnce(appError('Expired', { status: 401 }))
    useUploadStore.getState().addFiles([file(), file('second.mp3')])
    await useUploadStore.getState().start()
    expect(useUploadStore.getState().jobs.map((job) => job.state)).toEqual(['needsAuth', 'queued'])
    expect(useUploadStore.getState().jobs[0].resume?.fileId).toBe('stable-id')
    expect(uploadFileResumable).toHaveBeenCalledTimes(1)
    await useUploadStore.getState().start()
    expect(useUploadStore.getState().jobs.every((job) => job.state === 'done')).toBe(true)
  })

  it('keeps Drive success final when local tag parsing and cache writes fail', async () => {
    vi.mocked(readMetadataFromFile).mockRejectedValue(new Error('Unsupported tags'))
    library.addTrack.mockRejectedValue(new Error('IndexedDB unavailable'))
    useUploadStore.getState().addFiles([file()])
    await useUploadStore.getState().start()
    expect(useUploadStore.getState().jobs[0]).toMatchObject({ state: 'done', result: { id: 'stable-id' }, confirmedBytes: 16 })
    expect(library.setError).toHaveBeenCalledWith(expect.stringContaining('File đã lưu lên Drive'))
  })

  it('publishes an app-managed track before the completed queue item can be cleared', async () => {
    const tags = deferred<{ artist: string }>()
    vi.mocked(readMetadataFromFile).mockReturnValue(tags.promise)
    useUploadStore.getState().addFiles([file()])
    const starting = useUploadStore.getState().start()
    await vi.waitFor(() => expect(useUploadStore.getState().jobs[0].state).toBe('done'))
    expect(library.addTrack).toHaveBeenCalledWith(expect.objectContaining({ id: 'stable-id', appManaged: true }))
    useUploadStore.getState().clearCompleted()
    tags.resolve({ artist: 'Delayed tags' })
    await starting
    expect(useUploadStore.getState().jobs).toEqual([])
    expect(library.addTrack).toHaveBeenCalledTimes(1)
  })

  it('lets the user resume the same stable ID after repairing a non-transient quota failure', async () => {
    vi.mocked(uploadFileResumable).mockRejectedValueOnce(appError('Drive full', { status: 403, reason: 'storageQuotaExceeded', retryable: false }))
    useUploadStore.getState().addFiles([file()])
    await useUploadStore.getState().start()
    const failed = useUploadStore.getState().jobs[0]
    expect(canRetryUploadJob(failed)).toBe(true)
    useUploadStore.getState().retry(failed.id)
    await vi.waitFor(() => expect(useUploadStore.getState().processing).toBe(false))
    expect(generateDriveFileId).toHaveBeenCalledTimes(1)
    expect(useUploadStore.getState().jobs[0].state).toBe('done')
  })

  it('cancelling a queued job does not abort another active job', async () => {
    const pending = deferred<DriveTrack>()
    vi.mocked(uploadFileResumable).mockReturnValueOnce(pending.promise)
    useUploadStore.getState().addFiles([file(), file('second.mp3')])
    const starting = useUploadStore.getState().start()
    await vi.waitFor(() => expect(uploadFileResumable).toHaveBeenCalledTimes(1))
    const cb = vi.mocked(uploadFileResumable).mock.calls[0][3]
    useUploadStore.getState().cancel(useUploadStore.getState().jobs[1].id)
    expect(cb.signal?.aborted).toBe(false)
    pending.resolve(track)
    await starting
    expect(useUploadStore.getState().jobs.map((job) => job.state)).toEqual(['done', 'cancelled'])
    expect(uploadFileResumable).toHaveBeenCalledTimes(1)
  })

  it('clears uploads on logout and blocks a stale completion from restoring account data', async () => {
    const pending = deferred<DriveTrack>()
    vi.mocked(uploadFileResumable).mockReturnValueOnce(pending.promise)
    useUploadStore.getState().addFiles([file()])
    const starting = useUploadStore.getState().start()
    await vi.waitFor(() => expect(uploadFileResumable).toHaveBeenCalledTimes(1))
    const cb = vi.mocked(uploadFileResumable).mock.calls[0][3]
    invalidateSession()
    expect(cb.signal?.aborted).toBe(true)
    expect(useUploadStore.getState().jobs).toEqual([])
    pending.resolve(track)
    await starting
    expect(useUploadStore.getState().jobs).toEqual([])
    expect(library.addTrack).not.toHaveBeenCalled()
  })

  it('aborts an active upload when the target folder changes', async () => {
    let cb: UploadCallbacks | undefined
    vi.mocked(uploadFileResumable).mockImplementationOnce((_file, _folder, _id, callbacks) => {
      cb = callbacks
      return new Promise((_resolve, reject) => callbacks.signal?.addEventListener('abort', () => reject(appError('Cancelled', { reason: 'uploadCancelled' }))))
    })
    useUploadStore.getState().addFiles([file()])
    const starting = useUploadStore.getState().start()
    await vi.waitFor(() => expect(cb).toBeDefined())
    library.folder = { ...library.folder, folderId: 'folder-b' }
    for (const listener of library.listeners) listener()
    await starting
    expect(cb?.signal?.aborted).toBe(true)
    expect(useUploadStore.getState().jobs[0].state).toBe('cancelled')
    expect(library.addTrack).not.toHaveBeenCalled()
  })

  it('skips duplicate names or preserves both with a suffix according to the selected policy', async () => {
    library.tracks = [track]
    useUploadStore.getState().setDuplicatePolicy('skip')
    useUploadStore.getState().addFiles([file()])
    await useUploadStore.getState().start()
    expect(useUploadStore.getState().jobs[0].state).toBe('skipped')
    expect(uploadFileResumable).not.toHaveBeenCalled()
    useUploadStore.getState().setDuplicatePolicy('keep')
    useUploadStore.getState().addFiles([file()])
    await useUploadStore.getState().start()
    expect(vi.mocked(uploadFileResumable).mock.calls[0][0].name).toBe('song (2).mp3')
  })
})
