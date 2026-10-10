import type { AppError, DriveTrack, UploadJob, UploadResumeState } from '../types'
import { appError, isAudioFile } from '../types'
import { getTokenState, getValidToken, invalidateAccessToken } from './auth'
import { getFileMetadata } from './drive'

const API = 'https://www.googleapis.com/upload/drive/v3/files'
const CHUNK_BYTES = 8 * 1024 * 1024
const MAX_RETRIES = 5

export interface UploadCallbacks {
  onProgress: (sentBytes: number, confirmedBytes: number) => void
  onState: (state: UploadJob['state']) => void
  onResume?: (resume: UploadResumeState) => void
  resume?: UploadResumeState
  signal?: AbortSignal
}

interface XhrResult { status: number; body: string; headers: Headers }
type UploadError = AppError & { retryAfterMs?: number }
type SessionStatus = { offset: number } | { completed: DriveTrack } | { expired: true }

function cancelled(): AppError {
  return appError('Upload đã bị hủy.', { reason: 'uploadCancelled' })
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled()
}

function assertSessionUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.googleapis.com' || !parsed.pathname.startsWith('/upload/drive/v3/files')) {
    throw appError('Google Drive trả về URL upload không an toàn.')
  }
  return url
}

function xhrRequest(url: string, options: {
  method: string; headers?: Record<string, string>; body?: Blob | string; signal?: AbortSignal; onUpload?: (loaded: number) => void
}): Promise<XhrResult> {
  assertActive(options.signal)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(options.method, url, true)
    xhr.timeout = 120000
    xhr.responseType = 'text'
    for (const [key, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(key, value)
    if (options.onUpload) xhr.upload.onprogress = (event) => {
      if (!options.signal?.aborted) options.onUpload?.(event.loaded)
    }
    const abort = () => xhr.abort()
    const cleanup = () => options.signal?.removeEventListener('abort', abort)
    options.signal?.addEventListener('abort', abort, { once: true })
    xhr.onload = () => {
      cleanup()
      if (options.signal?.aborted) { reject(cancelled()); return }
      const headers = new Headers()
      for (const name of ['Location', 'Range', 'Retry-After']) {
        const value = xhr.getResponseHeader(name)
        if (value) headers.set(name, value)
      }
      resolve({ status: xhr.status, body: xhr.responseText || '', headers })
    }
    xhr.onerror = () => { cleanup(); reject(appError('Kết nối upload bị gián đoạn.', { retryable: true })) }
    xhr.ontimeout = () => { cleanup(); reject(appError('Upload bị quá thời gian chờ.', { retryable: true })) }
    xhr.onabort = () => { cleanup(); reject(cancelled()) }
    if (options.signal?.aborted) { cleanup(); reject(cancelled()); return }
    xhr.send(options.body ?? null)
  })
}

function responseError(result: XhrResult, token?: string): UploadError {
  let message = `Google Drive trả về lỗi HTTP ${result.status}.`
  let reason: string | undefined
  try {
    const data = JSON.parse(result.body) as { error?: { message?: string; errors?: Array<{ reason?: string }> } }
    message = data.error?.message || message
    reason = data.error?.errors?.[0]?.reason
  } catch { /* Network gateways sometimes return a plain-text body. */ }
  const rateLimited = reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'sharingRateLimitExceeded'
  let recovery: string | undefined
  if (reason === 'storageQuotaExceeded') { message = 'Google Drive đã hết dung lượng.'; recovery = 'Giải phóng dung lượng Drive rồi thử lại; phiên upload được giữ trong tab này.' }
  else if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') { message = 'Google Drive đã đạt giới hạn quota upload.'; recovery = 'Kiểm tra quota của dự án Google Cloud rồi thử lại sau.' }
  else if (rateLimited || result.status === 429) message = 'Google Drive đang giới hạn tốc độ upload. Ứng dụng sẽ thử lại.'
  else if (result.status === 401) {
    invalidateAccessToken(token)
    message = 'Phiên Google đã hết hạn khi upload.'
    recovery = 'Bấm Kết nối lại Google; phiên upload và byte đã xác nhận được giữ trong tab này.'
  } else if (result.status === 403) {
    message = reason === 'appNotAuthorizedToFile' ? 'Ứng dụng chưa được cấp quyền sử dụng thư mục này.' : 'Google Drive từ chối quyền upload vào thư mục này.'
    recovery = 'Kiểm tra quyền thư mục và tài khoản Google đang kết nối.'
  }
  const currentToken = result.status === 401 ? getTokenState()?.accessToken : undefined
  const renewedToken = Boolean(token && currentToken && currentToken !== token)
  const retryAfter = result.headers.get('Retry-After')
  const retryAfterMs = retryAfter
    ? /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())
    : undefined
  return Object.assign(appError(message, {
    status: result.status, reason, recovery, retryable: result.status === 429 || result.status >= 500 || rateLimited || renewedToken,
  }), { retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined })
}

async function retryDelay(attempt: number, signal?: AbortSignal, retryAfterMs = 0): Promise<void> {
  assertActive(signal)
  const ms = Math.min(300000, Math.max(retryAfterMs, Math.min(30000, 500 * 2 ** attempt) + Math.random() * 700))
  await new Promise<void>((resolve, reject) => {
    const abort = () => { globalThis.clearTimeout(timer); reject(cancelled()) }
    const timer = globalThis.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function retryRequest<T>(operation: () => Promise<T>, callbacks: UploadCallbacks): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    assertActive(callbacks.signal)
    try {
      const value = await operation()
      assertActive(callbacks.signal)
      return value
    } catch (cause) {
      assertActive(callbacks.signal)
      const error = cause as UploadError
      if (error.status === 401 && !error.retryable) callbacks.onState('needsAuth')
      if (!error.retryable || attempt >= MAX_RETRIES) throw cause
      callbacks.onState('retrying')
      await retryDelay(attempt, callbacks.signal, error.retryAfterMs)
    }
  }
}

function normalizeResponse(body: string, file: File, fileId: string): DriveTrack | undefined {
  try {
    const data = JSON.parse(body) as Partial<DriveTrack>
    const size = Number(data.size)
    if (data.id !== fileId || !Number.isFinite(size) || size !== file.size) return undefined
    return {
      id: fileId, name: data.name || file.name, mimeType: data.mimeType || file.type || 'application/octet-stream',
      size, createdTime: data.createdTime || '', modifiedTime: data.modifiedTime || '', appManaged: true,
    }
  } catch { return undefined }
}

async function confirmFile(file: File, fileId: string, callbacks: UploadCallbacks, allowMissing = false): Promise<DriveTrack | undefined> {
  try {
    const track = await retryRequest(() => getFileMetadata(fileId), callbacks)
    if (track.id !== fileId || Number(track.size) !== file.size) {
      throw appError('Drive chưa xác nhận đủ dữ liệu của file upload.', { retryable: true, recovery: 'Thử lại để kiểm tra phiên upload đang giữ trong tab này.' })
    }
    return track
  } catch (error) {
    if (allowMissing && (error as AppError).status === 404) return undefined
    throw error
  }
}

async function completedResponse(result: XhrResult, file: File, fileId: string, callbacks: UploadCallbacks): Promise<DriveTrack> {
  const track = normalizeResponse(result.body, file, fileId) || await confirmFile(file, fileId, callbacks)
  if (!track) throw appError('Drive chưa xác nhận file upload hoàn tất.', { retryable: true })
  return track
}

async function startSession(file: File, folderId: string, fileId: string, callbacks: UploadCallbacks): Promise<string | DriveTrack> {
  return retryRequest(async () => {
    const token = await getValidToken(undefined, false)
    assertActive(callbacks.signal)
    const result = await xhrRequest(`${API}?uploadType=resumable&fields=id,name,mimeType,size,createdTime,modifiedTime`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': file.type || 'application/octet-stream', 'X-Upload-Content-Length': String(file.size),
      },
      body: JSON.stringify({ id: fileId, name: file.name, mimeType: file.type || 'application/octet-stream', parents: [folderId], properties: { cbmSoundTrack: '1' } }),
      signal: callbacks.signal,
    })
    // Retrying a stable, pre-generated ID cannot create a second completed file.
    if (result.status === 409) {
      const completed = await confirmFile(file, fileId, callbacks, true)
      if (completed) return completed
      throw appError('Drive báo ID file đã tồn tại nhưng chưa xác nhận được file hoàn tất.', { status: 409, recovery: 'Đồng bộ thư viện rồi thử lại phiên upload này.' })
    }
    if (result.status < 200 || result.status >= 300) throw responseError(result, token)
    const location = result.headers.get('Location')
    if (!location) throw appError('Google Drive không trả về URL phiên resumable. Kiểm tra CORS của OAuth client.', { retryable: true })
    return assertSessionUrl(location)
  }, callbacks)
}

function confirmedOffset(result: XhrResult, size: number): number {
  const range = result.headers.get('Range')
  // No Range means Drive confirmed zero bytes, including after a chunk PUT.
  if (!range) return 0
  const match = range.match(/^bytes=0-(\d+)$/i)
  const offset = match ? Number(match[1]) + 1 : NaN
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
    throw appError('Không đọc được vị trí upload đã xác nhận của Google Drive.', { recovery: 'Giữ tab mở và thử lại để kiểm tra phiên upload.' })
  }
  return offset
}

async function queryOffset(sessionUrl: string, file: File, fileId: string, callbacks: UploadCallbacks): Promise<SessionStatus> {
  return retryRequest(async () => {
    const token = await getValidToken(undefined, false)
    assertActive(callbacks.signal)
    const result = await xhrRequest(assertSessionUrl(sessionUrl), {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${file.size}` }, signal: callbacks.signal,
    })
    if (result.status === 200 || result.status === 201) return { completed: await completedResponse(result, file, fileId, callbacks) }
    if (result.status === 404 || result.status === 410) return { expired: true }
    if (result.status !== 308) throw responseError(result, token)
    return { offset: confirmedOffset(result, file.size) }
  }, callbacks)
}

export async function uploadFileResumable(file: File, folderId: string, fileId: string, callbacks: UploadCallbacks): Promise<DriveTrack> {
  assertActive(callbacks.signal)
  if (!isAudioFile(file)) throw appError('File này không phải audio được ứng dụng chấp nhận.', { reason: 'invalidAudioFile' })
  if (!file.size) throw appError('File nhạc rỗng, không có dữ liệu để upload.')
  let resume: UploadResumeState = { ...callbacks.resume, fileId, offset: callbacks.resume?.offset || 0, driveName: file.name }
  let highWater = resume.offset
  let stalls = 0
  let failures = 0
  const updateResume = (patch: Partial<UploadResumeState>) => {
    assertActive(callbacks.signal)
    resume = { ...resume, ...patch }
    callbacks.onResume?.({ ...resume })
  }
  const finish = (track: DriveTrack) => {
    updateResume({ offset: file.size })
    callbacks.onProgress(file.size, file.size)
    return track
  }
  const ensureSession = async (): Promise<DriveTrack | undefined> => {
    if (resume.sessionUrl) return undefined
    const result = await startSession(file, folderId, fileId, callbacks)
    if (typeof result !== 'string') return result
    updateResume({ sessionUrl: result, offset: 0 })
    return undefined
  }
  const reconcile = async (): Promise<DriveTrack | undefined> => {
    if (!resume.sessionUrl) return ensureSession()
    const status = await queryOffset(resume.sessionUrl, file, fileId, callbacks)
    if ('completed' in status) return status.completed
    if ('expired' in status) {
      // The session can disappear after completion; check the stable file ID.
      const completed = await confirmFile(file, fileId, callbacks, true)
      if (completed) return completed
      updateResume({ sessionUrl: undefined, offset: 0 })
      return ensureSession()
    }
    updateResume({ offset: status.offset })
    callbacks.onProgress(status.offset, status.offset)
    if (status.offset > highWater) { highWater = status.offset; stalls = 0; failures = 0 }
    return undefined
  }
  updateResume({})
  const alreadyComplete = resume.sessionUrl ? await reconcile() : await ensureSession()
  if (alreadyComplete) return finish(alreadyComplete)
  while (resume.offset < file.size) {
    assertActive(callbacks.signal)
    const offset = resume.offset
    const nextEnd = Math.min(offset + CHUNK_BYTES, file.size)
    callbacks.onState('uploading')
    try {
      const token = await getValidToken(undefined, false)
      assertActive(callbacks.signal)
      const result = await xhrRequest(resume.sessionUrl!, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type || 'application/octet-stream', 'Content-Range': `bytes ${offset}-${nextEnd - 1}/${file.size}` },
        body: file.slice(offset, nextEnd), signal: callbacks.signal,
        onUpload: (loaded) => callbacks.onProgress(Math.min(nextEnd, offset + loaded), offset),
      })
      if (result.status === 200 || result.status === 201) return finish(await completedResponse(result, file, fileId, callbacks))
      if (result.status === 308) {
        const position = confirmedOffset(result, file.size)
        updateResume({ offset: position })
        callbacks.onProgress(position, position)
        if (position > highWater) { highWater = position; stalls = 0; failures = 0 }
        else if (++stalls > MAX_RETRIES) throw appError('Drive không xác nhận thêm dữ liệu sau nhiều lần gửi.', { recovery: 'Kiểm tra kết nối và thử lại phiên upload trong tab này.', retryable: true })
        if (position <= offset) {
          callbacks.onState('retrying')
          await retryDelay(stalls - 1, callbacks.signal)
        }
        continue
      }
      if (result.status === 404 || result.status === 410) {
        if (++failures > MAX_RETRIES) throw responseError(result, token)
        callbacks.onState('retrying')
        const completed = await reconcile()
        if (completed) return finish(completed)
        continue
      }
      throw responseError(result, token)
    } catch (cause) {
      assertActive(callbacks.signal)
      const error = cause as UploadError
      if (error.status === 401 && !error.retryable) callbacks.onState('needsAuth')
      if (!error.retryable || ++failures > MAX_RETRIES || stalls > MAX_RETRIES) throw cause
      callbacks.onState('retrying')
      await retryDelay(failures - 1, callbacks.signal, error.retryAfterMs)
      const completed = await reconcile()
      if (completed) return finish(completed)
    }
  }
  // A full Range is insufficient until Drive confirms successful file creation.
  const confirmed = await confirmFile(file, fileId, callbacks)
  if (!confirmed) throw appError('Drive chưa xác nhận file upload hoàn tất.', { retryable: true })
  return finish(confirmed)
}

export function makeUploadId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID().replace(/-/g, '')
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
