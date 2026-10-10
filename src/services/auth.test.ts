import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type AuthModule = typeof import('./auth')
let auth: AuthModule
type OAuthOptions = Parameters<NonNullable<NonNullable<Window['google']>['accounts']>['oauth2']['initTokenClient']>[0]
let pendingOptions: OAuthOptions | undefined
let popupRequest: ReturnType<typeof vi.fn<(options?: { prompt?: string; login_hint?: string }) => void>>

function fakeGoogle() {
  popupRequest = vi.fn()
  window.google = { accounts: { oauth2: {
    initTokenClient: vi.fn((options) => {
      pendingOptions = options
      return { requestAccessToken: popupRequest }
    }),
    revoke: vi.fn((_token, callback) => callback({ successful: true })),
  } } }
}

async function issueToken(token = 'test-token') {
  const pending = auth.requestAccessToken()
  pendingOptions!.callback({ access_token: token, expires_in: 3600, scope: auth.DRIVE_FILE_SCOPE })
  await pending
}

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client.apps.googleusercontent.com')
  auth = await import('./auth')
  pendingOptions = undefined
  fakeGoogle()
})

afterEach(() => {
  auth.signOut()
  window.google = undefined
  document.querySelectorAll('[data-google-identity]').forEach((script) => script.remove())
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('Google token/session lifecycle', () => {
  it('passes the documented login_hint to Google and avoids repeated account selection', async () => {
    const pending = auth.requestAccessToken({ prompt: '', loginHint: 'a@example.test' })
    expect(popupRequest).toHaveBeenCalledWith({ prompt: '', login_hint: 'a@example.test' })
    pendingOptions!.callback({ access_token: 'test', expires_in: 3600, scope: auth.DRIVE_FILE_SCOPE })
    await pending
  })

  it('keeps the remembered account on token expiry but removes it on explicit logout', async () => {
    const remembered = await import('./rememberedAccount')
    remembered.rememberAccount({ permissionId: 'account-a', emailAddress: 'a@example.test' }, [auth.DRIVE_FILE_SCOPE])
    await issueToken()
    auth.invalidateAccessToken()
    expect(remembered.getRememberedAccount()?.emailAddress).toBe('a@example.test')
    auth.signOut()
    expect(remembered.getRememberedAccount()).toBeUndefined()
  })

  it('restores previously confirmed scopes after a reload while keeping the token only in RAM', async () => {
    const remembered = await import('./rememberedAccount')
    remembered.rememberAccount({ permissionId: 'account-a', emailAddress: 'a@example.test' }, [auth.DRIVE_FILE_SCOPE, auth.DRIVE_READONLY_SCOPE])
    await issueToken('private-access-token')
    expect(JSON.stringify(localStorage)).not.toContain('private-access-token')
    auth.invalidateAccessToken()
    vi.resetModules()
    auth = await import('./auth')
    expect(auth.getTokenState()).toBeUndefined()
    expect(auth.getReconnectScopes()).toEqual([auth.DRIVE_FILE_SCOPE, auth.DRIVE_READONLY_SCOPE])
    expect(popupRequest).toHaveBeenCalledTimes(1)
  })

  it('does not accept granular consent missing the requested scope', async () => {
    const pending = auth.requestAccessToken({ scopes: [auth.DRIVE_FILE_SCOPE, auth.DRIVE_READONLY_SCOPE] })
    pendingOptions!.callback({ access_token: 'test', expires_in: 3600, scope: auth.DRIVE_FILE_SCOPE })
    await expect(pending).rejects.toMatchObject({ reason: 'insufficientScopes', status: 403 })
    expect(auth.getTokenState()).toBeUndefined()
  })

  it('ignores an OAuth callback delivered after logout', async () => {
    const pending = auth.requestAccessToken()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    auth.signOut()
    pendingOptions!.callback({ access_token: 'late-token', expires_in: 3600, scope: auth.DRIVE_FILE_SCOPE })
    await rejected
    expect(auth.getTokenState()).toBeUndefined()
  })

  it('invalidates a rejected token on HTTP401 without resetting the session', async () => {
    await issueToken()
    const session = await import('./session')
    const generation = session.getSessionGeneration()
    const subscriber = vi.fn()
    const unsubscribe = auth.subscribeToken(subscriber)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { errors: [{ reason: 'authError' }] } }), { status: 401 })))
    await expect(auth.driveJSON('https://example.test/file')).rejects.toMatchObject({ status: 401 })
    expect(auth.getTokenState()).toBeUndefined()
    expect(subscriber).toHaveBeenLastCalledWith(undefined)
    expect(session.getSessionGeneration()).toBe(generation)
    unsubscribe()
  })

  it('does not invalidate a newly issued token because an old request failed', async () => {
    await issueToken('old')
    await issueToken('new')
    auth.invalidateAccessToken('old')
    expect(auth.getTokenState()?.accessToken).toBe('new')
  })

  it('retains granted readonly scope for reconnect after401 and clears it on logout', async () => {
    const pending = auth.requestAccessToken({ scopes: [auth.DRIVE_FILE_SCOPE, auth.DRIVE_READONLY_SCOPE] })
    pendingOptions!.callback({ access_token: 'test', expires_in: 3600, scope: `${auth.DRIVE_FILE_SCOPE} ${auth.DRIVE_READONLY_SCOPE}` })
    await pending
    auth.invalidateAccessToken()
    expect(auth.getReconnectScopes()).toEqual([auth.DRIVE_FILE_SCOPE, auth.DRIVE_READONLY_SCOPE])
    auth.signOut()
    expect(auth.getReconnectScopes()).toEqual([auth.DRIVE_FILE_SCOPE])
  })

  it('actively notifies listeners at token expiry without waiting for another API call', async () => {
    vi.useFakeTimers()
    await issueToken()
    const subscriber = vi.fn()
    const unsubscribe = auth.subscribeToken(subscriber)
    vi.advanceTimersByTime((3600 - 60) * 1000)
    expect(auth.getTokenState()).toBeUndefined()
    expect(subscriber).toHaveBeenCalledWith(undefined)
    unsubscribe()
  })

  it('does not open a popup when a background service has no token', async () => {
    await expect(auth.getValidToken()).rejects.toMatchObject({ status: 401 })
    expect(window.google!.accounts!.oauth2.initTokenClient).not.toHaveBeenCalled()
  })

  it('drops a successful fetch result delivered after logout, even if fetch ignored abort', async () => {
    await issueToken()
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
    const request = auth.driveJSON('https://example.test/file')
    await Promise.resolve()
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    auth.signOut()
    finish(new Response(JSON.stringify({ name: 'private-file' })))
    await rejected
  })

  it('replaces a failed GIS script when retrying preparation', async () => {
    window.google = undefined
    const first = auth.prepareGoogleIdentity()
    const failure = expect(first).rejects.toThrow('Không tải được')
    const failedScript = document.querySelector<HTMLScriptElement>('[data-google-identity]')!
    failedScript.dispatchEvent(new Event('error'))
    await failure
    const second = auth.prepareGoogleIdentity()
    const newScript = document.querySelector<HTMLScriptElement>('[data-google-identity]')!
    expect(newScript).not.toBe(failedScript)
    fakeGoogle()
    newScript.dispatchEvent(new Event('load'))
    await expect(second).resolves.toBeUndefined()
  })
})

describe('Drive error reasons', () => {
  it('distinguishes per-file app authorization from account ACL', () => {
    const error = auth.driveErrorFromResponse(403, 'appNotAuthorizedToFile')
    expect(error.recovery).toContain('Google Picker')
    expect(error.message).not.toContain('Tài khoản chưa có quyền')
    expect(error.retryable).toBe(false)
  })

  it('retries per-user HTTP403 rate limits and parses Retry-After', () => {
    const error = auth.driveErrorFromResponse(403, 'userRateLimitExceeded', undefined, '2')
    expect(error).toMatchObject({ retryable: true, retryAfterMs: 2000 })
    expect(auth.driveErrorFromResponse(403, 'storageQuotaExceeded')).toMatchObject({ retryable: false })
  })

  it('keeps quota and domain restrictions separate from access problems', () => {
    expect(auth.driveErrorFromResponse(403, 'domainPolicy').recovery).toContain('quản trị viên')
    expect(auth.driveErrorFromResponse(403, 'dailyLimitExceeded').message).toContain('quota')
    expect(auth.driveErrorFromResponse(404).message).toContain('hoặc tài khoản')
  })

  it.each(['accessNotConfigured', 'serviceDisabled'])('reports %s as API setup instead of missing account permissions', (reason) => {
    const error = auth.driveErrorFromResponse(403, reason)
    expect(error).toMatchObject({ status: 403, reason, retryable: false })
    expect(error.message).toContain('Google Drive API chưa được bật')
    expect(error.recovery).toContain('đúng project tạo OAuth Client ID')
    expect(error.recovery).not.toContain('Google Picker')
  })
})
