import { appError, type AppError, type DriveAbout } from '../types'
import { assertSessionCurrent, getSessionGeneration, invalidateSession, isSessionCurrent, sessionRequestSignal, subscribeSessionReset } from './session'
import { clearRememberedAccount, getRememberedAccount } from './rememberedAccount'

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'

interface GISResponse {
  access_token: string
  expires_in: number
  scope: string
  error?: string
  error_description?: string
}

interface GISClient {
  requestAccessToken: (options?: { prompt?: string; login_hint?: string }) => void
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2: {
          initTokenClient: (options: {
            client_id: string
            scope: string
            callback: (response: GISResponse) => void
            error_callback?: (error: { type?: string; message?: string }) => void
          }) => GISClient
          revoke: (token: string, callback: (result: { successful?: boolean }) => void) => void
        }
      }
    }
  }
}

export interface TokenState {
  accessToken: string
  expiresAt: number
  scopes: string[]
}

let tokenState: TokenState | undefined
let authInFlight: Promise<TokenState> | undefined
let identityScript: Promise<void> | undefined
let expirationTimer: ReturnType<typeof setTimeout> | undefined
let lastGrantedScopes: string[] = getRememberedAccount()?.scopes || [DRIVE_FILE_SCOPE]
const tokenListeners = new Set<(token: TokenState | undefined) => void>()
const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

export function hasGoogleClient(): boolean { return Boolean(clientId?.trim()) }

export function getTokenState(): TokenState | undefined {
  if (tokenState && tokenState.expiresAt <= Date.now()) invalidateAccessToken()
  return tokenState
}

export function subscribeToken(listener: (token: TokenState | undefined) => void): () => void {
  tokenListeners.add(listener)
  return () => tokenListeners.delete(listener)
}

function setTokenState(token: TokenState | undefined): void {
  if (expirationTimer) clearTimeout(expirationTimer)
  expirationTimer = undefined
  tokenState = token
  if (token) lastGrantedScopes = [...token.scopes]
  if (token) expirationTimer = setTimeout(() => invalidateAccessToken(token.accessToken), Math.max(0, token.expiresAt - Date.now()))
  for (const listener of tokenListeners) listener(token)
}

// A late 401 from an old request must not discard a token just renewed by the user.
export function invalidateAccessToken(rejectedToken?: string): void {
  if (rejectedToken && tokenState?.accessToken !== rejectedToken) return
  setTokenState(undefined)
}

export function getReconnectScopes(): string[] { return [...lastGrantedScopes] }

function loadGoogleIdentity(): Promise<void> {
  if (isGoogleIdentityReady()) return Promise.resolve()
  if (identityScript) return identityScript
  // An errored/timed-out script cannot be reused: it will never emit another load.
  document.querySelector<HTMLScriptElement>('script[data-google-identity]')?.remove()
  const script = document.createElement('script')
  script.dataset.googleIdentity = 'true'
  script.src = 'https://accounts.google.com/gsi/client'
  script.async = true
  script.defer = true
  const pending = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      script.removeEventListener('load', onLoad)
      script.removeEventListener('error', onError)
    }
    const fail = (message: string) => {
      cleanup()
      script.remove()
      identityScript = undefined
      reject(appError(message, { retryable: true, recovery: 'Kiểm tra mạng rồi bấm Tải lại thư viện Google.' }))
    }
    const onLoad = () => {
      if (!isGoogleIdentityReady()) { fail('Google Identity Services chưa sẵn sàng.'); return }
      cleanup()
      resolve()
    }
    const onError = () => fail('Không tải được thư viện đăng nhập Google.')
    const timeout = setTimeout(() => fail('Tải thư viện đăng nhập Google quá thời gian chờ.'), 15000)
    script.addEventListener('load', onLoad)
    script.addEventListener('error', onError)
    document.head.appendChild(script)
  })
  identityScript = pending
  return pending
}

export function prepareGoogleIdentity(): Promise<void> { return loadGoogleIdentity() }

export function isGoogleIdentityReady(): boolean { return Boolean(window.google?.accounts?.oauth2) }

// Call from a click/key handler after prepareGoogleIdentity has completed. No
// background service opens an OAuth popup as a side effect of a network failure.
export function requestAccessToken(options: {
  scopes?: string[]
  prompt?: string
  loginHint?: string
} = {}): Promise<TokenState> {
  if (authInFlight) return authInFlight
  if (!clientId?.trim()) return Promise.reject(appError('Cần cấu hình Google OAuth Client ID trước khi đăng nhập.', {
    recovery: 'Thêm VITE_GOOGLE_CLIENT_ID trong .env.local hoặc GitHub Actions variables rồi build lại.',
  }))
  const scopes = options.scopes?.length ? options.scopes : [DRIVE_FILE_SCOPE]
  const generation = getSessionGeneration()
  let resolveToken!: (token: TokenState) => void
  let rejectToken!: (error: unknown) => void
  let settled = false
  let unsubscribe = () => {}
  const finishError = (error: unknown) => {
    if (settled) return
    settled = true
    unsubscribe()
    if (authInFlight === running) authInFlight = undefined
    rejectToken(error)
  }
  const pending = new Promise<TokenState>((resolve, reject) => { resolveToken = resolve; rejectToken = reject })
  const running = pending.finally(() => { if (authInFlight === running) authInFlight = undefined })
  authInFlight = running
  unsubscribe = subscribeSessionReset(() => finishError(new DOMException('Đã hủy đăng nhập.', 'AbortError')))

  const beginPopup = () => {
    if (settled || !isSessionCurrent(generation)) return
    try {
      const oauth2 = window.google?.accounts?.oauth2
      if (!oauth2) throw appError('Google Identity Services chưa sẵn sàng. Hãy tải lại thư viện Google.')
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: scopes.join(' '),
        callback: (response) => {
          if (settled || !isSessionCurrent(generation)) return
          if (response.error || !response.access_token) {
            finishError(appError(response.error_description || 'Google từ chối cấp quyền.', {
              reason: response.error, recovery: 'Kiểm tra tài khoản trong danh sách Test users và chấp nhận quyền Drive được yêu cầu.',
            }))
            return
          }
          const granted = (response.scope || '').split(/\s+/).filter(Boolean)
          // GIS supports granular consent: a successful popup is not proof that
          // every scope we requested was granted by the account.
          if (scopes.some((scope) => !granted.includes(scope))) {
            finishError(appError('Bạn chưa cấp đủ quyền Google Drive được yêu cầu.', {
              status: 403, reason: 'insufficientScopes', recovery: 'Bấm Kết nối lại và đánh dấu quyền Google Drive trong màn hình cấp quyền.',
            }))
            return
          }
          const token: TokenState = {
            accessToken: response.access_token,
            expiresAt: Date.now() + Math.max(0, Number(response.expires_in || 0) - 60) * 1000,
            scopes: granted,
          }
          settled = true
          unsubscribe()
          setTokenState(token)
          resolveToken(token)
        },
        error_callback: (error) => {
          const popupClosed = error.type === 'popup_closed' || /popup.*closed/i.test(error.message || '')
          finishError(appError(popupClosed
            ? 'Cửa sổ đăng nhập Google đã đóng. Hãy cho phép popup rồi thử kết nối lại.'
            : error.message || 'Không thể mở hộp thoại đăng nhập Google.', { reason: error.type }))
        },
      })
      client.requestAccessToken({ prompt: options.prompt, login_hint: options.loginHint })
    } catch (error) { finishError(error) }
  }
  if (isGoogleIdentityReady()) beginPopup()
  else finishError(appError('Thư viện đăng nhập Google chưa sẵn sàng.', {
    retryable: true, recovery: 'Bấm Tải lại thư viện Google, chờ tải xong rồi đăng nhập.',
  }))
  return running
}

export async function getValidToken(scope = DRIVE_FILE_SCOPE, interactive = false): Promise<string> {
  const current = getTokenState()
  if (current?.scopes.includes(scope)) return current.accessToken
  if (!interactive) throw appError('Phiên Google đã hết hạn hoặc chưa cấp đủ quyền.', {
    status: 401, reason: 'authRequired', recovery: 'Bấm Kết nối lại để tiếp tục; trạng thái upload và vị trí phát được giữ trong tab này.',
  })
  const next = await requestAccessToken({ scopes: [DRIVE_FILE_SCOPE, ...(scope === DRIVE_READONLY_SCOPE ? [DRIVE_READONLY_SCOPE] : [])] })
  return next.accessToken
}

export function signOut(): void {
  invalidateAccessToken()
  lastGrantedScopes = [DRIVE_FILE_SCOPE]
  clearRememberedAccount()
  invalidateSession()
}

export async function revokeGoogleAccess(): Promise<void> {
  const token = getTokenState()?.accessToken
  const oauth2 = window.google?.accounts?.oauth2
  signOut()
  if (!token || !oauth2) return
  await new Promise<void>((resolve, reject) => oauth2.revoke(token, (result) => {
    if (result.successful) resolve()
    else reject(appError('Google chưa xác nhận thu hồi quyền.', { recovery: 'Mở phần Kết nối bên thứ ba trong Tài khoản Google để kiểm tra và thu hồi.' }))
  }))
}

export async function getDriveIdentity(): Promise<DriveAbout['user']> {
  const result = await driveJSON<DriveAbout>('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,permissionId,photoLink)')
  return result.user
}

export function driveErrorFromResponse(status: number, reason?: string, detail?: string, retryAfter?: string | null): AppError {
  let message = detail || `Google Drive trả về lỗi HTTP ${status}.`
  let recovery = 'Kiểm tra cấu hình Google Cloud rồi thử lại.'
  const rateLimited = ['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded'].includes(reason || '') || status === 429
  const retryable = rateLimited || status >= 500
  if (status === 401) {
    message = 'Phiên Google đã hết hạn hoặc bị Google từ chối.'
    recovery = 'Bấm Kết nối lại Google để nhận token mới.'
  } else if (reason === 'appNotAuthorizedToFile') {
    message = 'CBM Sound chưa được cấp quyền mở thư mục hoặc file này.'
    recovery = 'Bấm Cấp quyền thư mục bằng Google Picker và chọn đúng thư mục thư viện. Quyền sở hữu Drive và quyền ứng dụng là hai quyền riêng.'
  } else if (reason === 'insufficientScopes' || reason === 'insufficientPermissions') {
    message = 'Token hiện tại chưa có quyền OAuth cần thiết cho thao tác này.'
    recovery = 'Kết nối lại và chấp nhận scope được yêu cầu. Với người nghe, quyền đọc bổ sung chỉ dùng sau khi drive.file không đủ.'
  } else if (reason === 'insufficientFilePermissions') {
    message = 'Google Drive không cấp quyền thực hiện thao tác này trên file.'
    recovery = 'Kiểm tra quyền chia sẻ của file và khả năng canRename/canTrash. Scope OAuth không nâng quyền tài khoản trên Drive.'
  } else if (reason === 'storageQuotaExceeded') {
    message = 'Google Drive của tài khoản đã hết dung lượng lưu trữ.'
    recovery = 'Giải phóng dung lượng trong Drive, Gmail hoặc Google Photos rồi thử lại upload.'
  } else if (reason === 'dailyLimitExceeded' || reason === 'quotaExceeded' || reason === 'downloadQuotaExceeded') {
    message = 'Google đã giới hạn quota của ứng dụng hoặc file này.'
    recovery = 'Kiểm tra quota Google Cloud hoặc chờ quota được khôi phục. Đổi quyền chia sẻ không khắc phục được giới hạn này.'
  } else if (rateLimited) {
    message = 'Google Drive đang giới hạn tốc độ yêu cầu.'
    recovery = 'Chờ một chút rồi thử lại; thao tác đọc an toàn được retry có giới hạn.'
  } else if (['domainPolicy', 'blockedByAdmin', 'teamDriveMembershipRequired'].includes(reason || '')) {
    message = 'Chính sách Google Workspace hoặc Shared Drive đang chặn truy cập.'
    recovery = 'Liên hệ quản trị viên Workspace hoặc chủ Shared Drive để cho phép ứng dụng và tài khoản.'
  } else if (reason === 'accessNotConfigured' || reason === 'serviceDisabled') {
    message = 'Google Drive API chưa được bật cho Google Cloud project này.'
    recovery = 'Bật Google Drive API trong đúng project tạo OAuth Client ID rồi thử lại.'
  } else if (reason === 'fileNotDownloadable') {
    message = 'File này không có dữ liệu âm thanh tải xuống được.'
    recovery = 'Upload một file âm thanh thực như MP3, FLAC hoặc M4A.'
  } else if (status === 403) {
    message = detail ? `Google từ chối thao tác: ${detail}` : 'Google từ chối thao tác với thư viện này.'
    recovery = 'Kiểm tra reason của Google, quyền ứng dụng và quyền Drive của đúng tài khoản. Lỗi này chưa đủ để kết luận bạn không phải chủ thư mục.'
  } else if (status === 404) {
    message = 'Không tìm thấy thư mục hoặc bài nhạc, hoặc tài khoản chưa được phép mở bằng ứng dụng.'
    recovery = 'Chọn đúng thư mục bằng Google Picker, xác nhận quyền chia sẻ Drive rồi đồng bộ lại.'
  } else if (status >= 500) {
    message = 'Google Drive đang gặp sự cố tạm thời.'
    recovery = 'Chờ một chút rồi thử lại.'
  }
  const seconds = Number(retryAfter)
  const retryAfterMs = retryAfter ? Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - Date.now()) : undefined
  return Object.assign(appError(message, { status, reason, retryable, recovery }), {
    retryAfterMs: retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
  })
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function driveJSON<T>(url: string, init: RequestInit = {}, scope = DRIVE_FILE_SCOPE): Promise<T> {
  const generation = getSessionGeneration()
  const method = (init.method || 'GET').toUpperCase()
  const isRead = method === 'GET' || method === 'HEAD'
  const readonlyScope = isRead && getTokenState()?.scopes.includes(DRIVE_READONLY_SCOPE) ? DRIVE_READONLY_SCOPE : scope
  const token = await getValidToken(readonlyScope, false)
  assertSessionCurrent(generation)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const request = sessionRequestSignal(init.signal)
  try {
    // Retry only reads. A permissions/create request must never be repeated just
    // because its response was lost; callers reconcile state explicitly.
    for (let attempt = 0; ; attempt += 1) {
      let response: Response
      try { response = await fetch(url, { ...init, headers, signal: request.signal }) }
      catch (error) {
        if (request.signal.aborted) throw request.signal.reason
        if (isRead && attempt < 2) { await waitForRetry(500 * 2 ** attempt + Math.random() * 250, request.signal); continue }
        throw appError(error instanceof Error ? `Không kết nối được Google Drive: ${error.message}` : 'Không kết nối được Google Drive.', {
          retryable: true, reason: 'networkError', recovery: 'Kiểm tra kết nối mạng rồi thử đồng bộ lại. Dữ liệu cache chưa bị xóa.',
        })
      }
      assertSessionCurrent(generation)
      if (!response.ok) {
        let payload: { error?: { message?: string; errors?: Array<{ reason?: string }> } } | undefined
        try { payload = await response.json() as typeof payload } catch { /* Drive sometimes returns an empty error body. */ }
        assertSessionCurrent(generation)
        if (response.status === 401) invalidateAccessToken(token)
        const error = driveErrorFromResponse(response.status, payload?.error?.errors?.[0]?.reason, payload?.error?.message, response.headers.get('Retry-After'))
        if (isRead && error.retryable && attempt < 2 && (error.retryAfterMs || 0) <= 30000) {
          await waitForRetry(error.retryAfterMs ?? 500 * 2 ** attempt + Math.random() * 250, request.signal)
          continue
        }
        throw error
      }
      if (response.status === 204 || method === 'HEAD') return undefined as T
      const result = await response.json() as T
      assertSessionCurrent(generation)
      return result
    }
  } finally { request.release() }
}
