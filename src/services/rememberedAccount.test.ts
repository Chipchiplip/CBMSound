import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAbout } from '../types'

const FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const CLIENT_A = 'client-a.apps.googleusercontent.com'
const CLIENT_B = 'client-b.apps.googleusercontent.com'
const key = (client = CLIENT_A) => `cbm-sound:remembered-account:v1:${client}`
const user = { permissionId: '12345678901234567890', emailAddress: 'listener@example.com', displayName: 'Người nghe' }
let account: typeof import('./rememberedAccount')

async function load(clientId = CLIENT_A) {
  vi.resetModules()
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', clientId)
  return import('./rememberedAccount')
}

beforeEach(async () => {
  localStorage.clear()
  account = await load()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  localStorage.clear()
})

describe('remembered account hints', () => {
  it('restores the same account and confirmed scopes after a module reload', async () => {
    account.rememberAccount(user, [FILE_SCOPE, READ_SCOPE])
    account = await load()
    expect(account.getRememberedAccount()).toEqual({ ...user, scopes: [FILE_SCOPE, READ_SCOPE] })
  })

  it('persists only identity hints and whitelisted scopes, never credentials or roles', () => {
    const extras = { ...user, accessToken: 'private-token', refreshToken: 'private-refresh', expiresAt: 9999999999999, photoLink: 'https://photo.example.com/me', capabilities: { canShare: true }, ownedByMe: true, role: 'admin' }
    account.rememberAccount(extras, [FILE_SCOPE, 'https://www.googleapis.com/auth/drive', READ_SCOPE, FILE_SCOPE])
    expect(JSON.parse(localStorage.getItem(key())!)).toEqual({ ...user, scopes: [FILE_SCOPE, READ_SCOPE] })
    expect(localStorage.getItem(key())).not.toContain('private-token')
    expect(localStorage.getItem(key())).not.toContain('private-refresh')
  })

  it('strips unexpected credential fields and scopes from legacy or edited records', () => {
    localStorage.setItem(key(), JSON.stringify({ ...user, scopes: [FILE_SCOPE, 'https://www.googleapis.com/auth/drive', READ_SCOPE], token: 'do-not-return', role: 'owner' }))
    expect(account.getRememberedAccount()).toEqual({ ...user, scopes: [FILE_SCOPE, READ_SCOPE] })
  })

  it.each([
    { permissionId: '', emailAddress: user.emailAddress },
    { permissionId: 'bad/id', emailAddress: user.emailAddress },
    { permissionId: 'a'.repeat(201), emailAddress: user.emailAddress },
    { permissionId: user.permissionId, emailAddress: 'missing-domain' },
    { permissionId: user.permissionId, emailAddress: 'name@domain' },
    { permissionId: user.permissionId, emailAddress: 'name\u0000@example.com' },
    { permissionId: user.permissionId, emailAddress: 'a'.repeat(255) + '@example.com' },
  ])('clears an old hint when new identity data is invalid: %j', (invalid) => {
    account.rememberAccount(user, [FILE_SCOPE])
    account.rememberAccount(invalid, [FILE_SCOPE])
    expect(account.getRememberedAccount()).toBeUndefined()
    expect(localStorage.getItem(key())).toBeNull()
  })

  it('clears an old hint when no identity or no supported base scope is supplied', () => {
    account.rememberAccount(user, [FILE_SCOPE])
    account.rememberAccount(undefined, [FILE_SCOPE])
    expect(account.getRememberedAccount()).toBeUndefined()
    account.rememberAccount(user, [FILE_SCOPE])
    account.rememberAccount(user, [READ_SCOPE])
    expect(account.getRememberedAccount()).toBeUndefined()
  })

  it.each(['not-json', 'null', '[]', 'true', JSON.stringify({ ...user, scopes: 'drive.file' }), JSON.stringify({ ...user, scopes: [READ_SCOPE] }), JSON.stringify({ ...user, scopes: Array(17).fill(FILE_SCOPE) }), 'x'.repeat(4097)])('ignores and removes invalid storage: %s', (raw) => {
    localStorage.setItem(key(), raw)
    expect(account.getRememberedAccount()).toBeUndefined()
    expect(localStorage.getItem(key())).toBeNull()
  })

  it('does not reuse or clear account hints belonging to another OAuth client', async () => {
    account.rememberAccount(user, [FILE_SCOPE])
    account = await load(CLIENT_B)
    expect(account.getRememberedAccount()).toBeUndefined()
    account.clearRememberedAccount()
    expect(localStorage.getItem(key())).not.toBeNull()
    account.rememberAccount({ ...user, emailAddress: 'other@example.com' }, [FILE_SCOPE])
    account = await load(CLIENT_A)
    expect(account.getRememberedAccount()?.emailAddress).toBe(user.emailAddress)
    expect(localStorage.getItem(key(CLIENT_B))).not.toBeNull()
  })

  it('returns no hint and saves nothing without a configured OAuth client', async () => {
    account = await load('  ')
    account.rememberAccount(user, [FILE_SCOPE])
    account.clearRememberedAccount()
    expect(account.getRememberedAccount()).toBeUndefined()
    expect(localStorage.length).toBe(0)
  })

  it('handles browser storage being blocked for both reads and writes', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    expect(() => account.rememberAccount(user, [FILE_SCOPE])).not.toThrow()
    expect(() => account.clearRememberedAccount()).not.toThrow()
    expect(account.getRememberedAccount()).toBeUndefined()
  })

  it('removes an older account hint if saving the current account fails', () => {
    account.rememberAccount(user, [FILE_SCOPE])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    account.rememberAccount({ ...user, emailAddress: 'different@example.com' }, [FILE_SCOPE])
    expect(account.getRememberedAccount()).toBeUndefined()
  })

  it('clears remembered identity on explicit logout', () => {
    account.rememberAccount(user, [FILE_SCOPE, READ_SCOPE])
    account.clearRememberedAccount()
    expect(account.getRememberedAccount()).toBeUndefined()
    expect(localStorage.getItem(key())).toBeNull()
  })

  it('normalizes bounded display data and returns fresh objects', () => {
    account.rememberAccount({ ...user, displayName: '  Người\u0000 nghe  ' }, [FILE_SCOPE])
    const first = account.getRememberedAccount()!
    first.emailAddress = 'changed@example.com'
    first.scopes.push(READ_SCOPE)
    expect(account.getRememberedAccount()).toEqual({ ...user, scopes: [FILE_SCOPE] })
    account.rememberAccount({ ...user, displayName: 'x'.repeat(500) }, [FILE_SCOPE])
    expect(account.getRememberedAccount()?.displayName).toHaveLength(200)
  })

  it('does not mistake a fabricated permission or role for a valid account', () => {
    account.rememberAccount({ displayName: 'Admin', emailAddress: user.emailAddress } as DriveAbout['user'], [FILE_SCOPE])
    expect(account.getRememberedAccount()).toBeUndefined()
  })
})
