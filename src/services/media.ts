import { appError, type AppError, type DriveTrack } from '../types'
import { getTokenState, invalidateAccessToken, subscribeToken } from './auth'
import { subscribeSessionReset } from './session'

const basePath = import.meta.env.BASE_URL || '/'
const mediaPrefix = `${basePath.replace(/\/$/, '')}/__cbm_media__/`
const MAX_FALLBACK_BYTES = 32 * 1024 * 1024
let registrationPromise: Promise<ServiceWorkerRegistration | undefined> | undefined
let registration: ServiceWorkerRegistration | undefined
let currentTracks: DriveTrack[] = []
let workerListenersAttached = false
let workerFailure: AppError | undefined
const authListeners = new Set<() => void>()

function isAppWorker(target: ServiceWorker | null | undefined): target is ServiceWorker {
  if (!target) return false
  const expected = new URL(`${basePath}sw.js`, location.href)
  const actual = new URL(target.scriptURL, location.href)
  return actual.origin === expected.origin && actual.pathname === expected.pathname
}

function worker(): ServiceWorker | undefined {
  if (isAppWorker(navigator.serviceWorker?.controller)) return navigator.serviceWorker.controller!
  if (isAppWorker(registration?.active)) return registration.active!
}

function waitForAppController(previous?: ServiceWorker): Promise<ServiceWorker | undefined> {
  return new Promise((resolve) => {
    const usable = () => {
      const controller = navigator.serviceWorker.controller
      return isAppWorker(controller) && controller !== previous ? controller : undefined
    }
    const finish = (controller?: ServiceWorker) => {
      window.clearTimeout(timeout)
      navigator.serviceWorker.removeEventListener('controllerchange', changed)
      resolve(controller)
    }
    const changed = () => { const controller = usable(); if (controller) finish(controller) }
    const timeout = window.setTimeout(() => finish(), 5000)
    navigator.serviceWorker.addEventListener('controllerchange', changed)
    changed()
  })
}

function attachWorkerListeners(): void {
  if (workerListenersAttached || !navigator.serviceWorker) return
  workerListenersAttached = true
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    if (!isAppWorker(event.source as ServiceWorker) || event.source !== navigator.serviceWorker.controller && event.source !== registration?.active) return
    if (event.data?.type === 'REQUEST_SESSION') void syncSession(event.source as ServiceWorker, event.data.requestId)
    if (event.data?.type === 'MEDIA_AUTH_REQUIRED') {
      const rejectedToken = event.data.rejectedToken as string | undefined
      if (!rejectedToken || rejectedToken !== getTokenState()?.accessToken) return
      invalidateAccessToken(rejectedToken)
      for (const listener of authListeners) listener()
    }
  })
  navigator.serviceWorker.addEventListener('controllerchange', () => { registrationPromise = undefined; void syncSession(worker()) })
  subscribeToken(() => { void syncSession(worker()) })
  subscribeSessionReset(clearMediaSession)
}

export async function registerMediaWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) {
    workerFailure = appError('Trình duyệt chưa hỗ trợ Service Worker để phát nhạc lớn. Hãy mở bằng Edge hoặc Chrome phiên bản hiện tại.', { reason: 'WORKER_UNAVAILABLE' })
    return undefined
  }
  if (!(location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    workerFailure = appError('Phát nhạc lớn cần HTTPS hoặc localhost. Hãy mở website bằng địa chỉ HTTPS hay http://localhost:5173/.', { reason: 'WORKER_INSECURE_ORIGIN' })
    return undefined
  }
  attachWorkerListeners()
  if (registrationPromise) return registrationPromise
  const attempt = (async () => {
    try {
      const registered = await navigator.serviceWorker.register(`${basePath}sw.js`, { type: 'module', scope: basePath, updateViaCache: 'none' })
      registration = registered
      let controller = await waitForAppController()
      if (!controller) throw appError('Service Worker CBM Sound chưa điều khiển trang. Nhấn F5 rồi đăng nhập lại để phát nhạc lớn.', { reason: 'WORKER_NOT_CONTROLLING' })
      if (!await syncSession(controller)) {
        const previous = controller
        await registered.update()
        controller = await waitForAppController(previous)
        if (!controller || !await syncSession(controller)) throw appError('Bộ phát nền đang dùng phiên bản cũ hoặc không phản hồi. Nhấn F5 rồi thử phát lại.', { reason: 'WORKER_PROTOCOL_MISMATCH' })
      }
      workerFailure = undefined
      return registered
    } catch (cause) {
      workerFailure = (cause as AppError)?.reason ? cause as AppError : appError('Không khởi động được Service Worker CBM Sound. Kiểm tra quyền website trong Edge rồi nhấn F5.', { reason: 'WORKER_REGISTRATION_FAILED' })
      return undefined
    }
  })()
  registrationPromise = attempt
  const result = await attempt
  // A delayed activation must be able to recover without a permanent failed promise.
  if (!result && registrationPromise === attempt) registrationPromise = undefined
  return result
}

export function setMediaManifest(tracks: DriveTrack[]): void {
  currentTracks = tracks
  void registerMediaWorker().then(() => syncSession(worker()))
}

async function syncSession(target: ServiceWorker | null | undefined, requestId?: string): Promise<boolean> {
  if (!isAppWorker(target)) return false
  const token = getTokenState()
  const message = token ? {
    type: 'SET_SESSION', requestId, token: token.accessToken, expiresAt: token.expiresAt,
    files: Object.fromEntries(currentTracks.filter((track) => !track.unavailable).map((track) => [track.id, { size: track.size, mimeType: track.mimeType, modifiedTime: track.modifiedTime }])),
  } : { type: 'CLEAR_SESSION', requestId }
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel()
    const finish = (accepted = false) => { window.clearTimeout(timeout); channel.port1.close(); resolve(accepted) }
    const timeout = window.setTimeout(() => finish(), 5000)
    channel.port1.onmessage = (event) => finish(event.data?.type === 'SESSION_ACK' && event.data.protocol === 2)
    try { target.postMessage(message, [channel.port2]) } catch { finish() }
  })
}

export function releaseMediaRequests(): void { worker()?.postMessage({ type: 'RELEASE_MEDIA' }) }
export function clearMediaSession(): void { currentTracks = []; worker()?.postMessage({ type: 'CLEAR_SESSION' }) }
export function subscribeMediaAuthRequired(listener: () => void): () => void { authListeners.add(listener); return () => authListeners.delete(listener) }
export function subscribeMediaControllerChange(listener: () => void): () => void {
  navigator.serviceWorker?.addEventListener('controllerchange', listener)
  return () => navigator.serviceWorker?.removeEventListener('controllerchange', listener)
}
export function mediaUrl(trackId: string): string { return `${mediaPrefix}${encodeURIComponent(trackId)}` }
export function getFallbackLimit(): number { return MAX_FALLBACK_BYTES }

// CORS can hide Content-Length. Enforce the budget as the stream arrives,
// before allocating a Blob or a complete ArrayBuffer.
export async function readResponseBytes(response: Response, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>[]> {
  const length = response.headers.get('Content-Length')
  if (length !== null && Number(length) > limit) {
    await response.body?.cancel()
    throw appError('File vượt giới hạn tải dự phòng; cần hỗ trợ streaming để phát.', { reason: 'DOWNLOAD_LIMIT' })
  }
  if (!response.body) throw new Error('Trình duyệt không hỗ trợ đọc luồng dữ liệu có giới hạn bộ nhớ.')
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Đã hủy tải nhạc.', 'AbortError')
      const { value, done } = await reader.read()
      if (signal?.aborted) throw new DOMException('Đã hủy tải nhạc.', 'AbortError')
      if (done) break
      received += value.byteLength
      if (received > limit) throw appError('File vượt giới hạn tải dự phòng 32 MiB; cần hỗ trợ streaming để phát.', { reason: 'DOWNLOAD_LIMIT' })
      chunks.push(new Uint8Array(value))
    }
    return chunks
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

export async function fetchSmallFile(trackId: string, signal?: AbortSignal): Promise<Blob> {
  const token = getTokenState()?.accessToken
  if (!token) throw appError('Phiên Google đã hết hạn. Kết nối lại để tiếp tục.', { status: 401 })
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(trackId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }, signal, cache: 'no-store',
  })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 401) invalidateAccessToken(token)
    throw appError(response.status === 401 ? 'Phiên Google đã hết hạn. Kết nối lại để tiếp tục.' : `Không tải được bài nhạc (HTTP ${response.status}).`, { status: response.status })
  }
  return new Blob(await readResponseBytes(response, MAX_FALLBACK_BYTES, signal), { type: response.headers.get('Content-Type') || 'audio/mpeg' })
}

export async function probeRangePlayback(track: DriveTrack, signal?: AbortSignal): Promise<boolean> {
  if (!await registerMediaWorker()) {
    if (signal?.aborted) throw new DOMException('Đã hủy kiểm tra phát nhạc.', 'AbortError')
    if (track.size > MAX_FALLBACK_BYTES) throw workerFailure || appError('Service Worker chưa sẵn sàng để phát nhạc lớn. Nhấn F5 rồi thử lại.', { reason: 'WORKER_UNAVAILABLE' })
    return false
  }
  const token = getTokenState()?.accessToken
  if (!token) throw appError('Phiên Google đã hết hạn. Kết nối lại để tiếp tục.', { status: 401 })
  const controller = navigator.serviceWorker.controller
  if (!isAppWorker(controller) || !await syncSession(controller)) throw appError('Service Worker chưa nhận phiên phát hợp lệ. Nhấn F5, đăng nhập rồi thử lại.', { reason: 'WORKER_SESSION_UNAVAILABLE' })
  let response: Response
  try { response = await fetch(mediaUrl(track.id), { headers: { Range: 'bytes=0-0' }, signal, cache: 'no-store' }) }
  catch (error) {
    if (signal?.aborted) throw error
    throw new Error('Không thể kết nối với luồng nhạc Google Drive. Kiểm tra kết nối rồi thử lại.')
  }
  if (response.status === 206 && response.headers.get('Content-Range') === `bytes 0-0/${track.size}`) {
    try {
      const chunks = await readResponseBytes(response, 1, signal)
      if (chunks.reduce((size, chunk) => size + chunk.byteLength, 0) !== 1) throw new Error('INCOMPLETE_PROBE')
      return true
    } catch (cause) {
      if (signal?.aborted) throw cause
      throw appError('Drive trả dữ liệu không khớp khoảng byte yêu cầu. Đồng bộ thư viện rồi thử phát lại.', { reason: 'INVALID_PROBE_BODY' })
    }
  }
  await response.body?.cancel()
  const reason = response.headers.get('X-CBM-Error')
  if (reason === 'RANGE_NOT_SUPPORTED' || reason === 'RANGE_HEADERS_UNAVAILABLE' || reason === 'RANGE_LENGTH_UNAVAILABLE') {
    if (track.size > MAX_FALLBACK_BYTES) throw appError(reason === 'RANGE_NOT_SUPPORTED'
      ? 'Drive trả toàn bộ file thay vì khoảng byte. Chưa thể streaming bài này; file lớn hơn giới hạn tải dự phòng 32 MiB.'
      : 'Drive ẩn thông tin cần xác minh khoảng byte. Chưa thể streaming bài này; file lớn hơn giới hạn tải dự phòng 32 MiB.', { reason })
    return false
  }
  if (response.status === 200 || response.status === 404 && !reason) throw appError('Đường dẫn audio chưa được Service Worker xử lý. Nhấn F5 rồi đăng nhập và phát lại.', { reason: 'WORKER_ROUTE_MISSING' })
  if (response.status === 401) {
    invalidateAccessToken(token)
    throw appError('Phiên Google đã hết hạn. Kết nối lại để tiếp tục.', { status: 401 })
  }
  if (reason === 'DOWNLOAD_RESTRICTED') throw appError('Chủ file đã chặn tải nội dung trên Drive, nên CBM Sound không thể phát bài này.', { status: 403, reason })
  if (response.status === 403) throw appError('Google Drive chưa cho phép phát file này. Kiểm tra quyền thư mục và OAuth scope.', { status: 403 })
  if (reason === 'FILE_CHANGED') throw new Error('File đã thay đổi trên Google Drive. Đồng bộ thư viện rồi phát lại.')
  if (response.status === 404) throw new Error('Bài nhạc không còn khả dụng. Đồng bộ thư viện để cập nhật.')
  if (reason === 'INVALID_DRIVE_METADATA') throw appError('Drive không trả thông tin kích thước hợp lệ để kiểm tra streaming. Đồng bộ thư viện rồi thử lại.', { reason })
  if (reason === 'DRIVE_METADATA_UNAVAILABLE') throw appError(response.status === 429
    ? 'Drive đang giới hạn số yêu cầu; chưa xác minh được dữ liệu file để streaming. Chờ một lúc rồi thử lại.'
    : 'Chưa đọc được thông tin mới nhất của file từ Drive để xác minh streaming. Kiểm tra kết nối rồi thử lại.', { status: response.status, reason, retryable: response.status === 429 || response.status >= 500 })
  if (reason === 'NETWORK_ERROR') throw appError('Không kết nối được với Google Drive để đọc nhạc. Kiểm tra mạng rồi thử lại.', { status: response.status, reason, retryable: true })
  if (response.status === 206) throw appError('Phản hồi streaming không khớp khoảng byte yêu cầu. Đồng bộ thư viện rồi thử lại.', { reason: 'INVALID_UPSTREAM_RANGE' })
  if (reason === 'INVALID_UPSTREAM_RANGE' || reason === 'INVALID_UPSTREAM_LENGTH') throw new Error('Drive trả về khoảng byte không hợp lệ. Chưa thể phát an toàn file này.')
  throw new Error(`Google Drive tạm thời không thể phát file (HTTP ${response.status}). Thử lại sau.`)
}
