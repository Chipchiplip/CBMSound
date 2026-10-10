import type { DriveAbout } from '../types'

// A remembered account is a convenience hint, never proof of authentication or
// Drive permissions. Fresh Google authorization is required before using it.
export interface RememberedAccount {
  permissionId: string
  emailAddress: string
  displayName?: string
  scopes: string[]
}

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const MAX_RECORD_LENGTH = 4096
const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim()
const storageKey = clientId && clientId.length <= 512
  ? `cbm-sound:remembered-account:v1:${clientId}`
  : undefined

function stripControlCharacters(value: string): string {
  return Array.from(value).filter((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  }).join('')
}

function sanitizeAccount(value: unknown): RememberedAccount | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.permissionId !== 'string' || typeof record.emailAddress !== 'string' || !Array.isArray(record.scopes)) return undefined
  const permissionId = record.permissionId.trim()
  const emailAddress = record.emailAddress.trim()
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(permissionId) || emailAddress.length > 254 ||
      stripControlCharacters(emailAddress) !== emailAddress || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(emailAddress)) return undefined
  if (record.scopes.length > 16 || !record.scopes.includes(DRIVE_FILE_SCOPE)) return undefined
  const scopes = [DRIVE_FILE_SCOPE]
  if (record.scopes.includes(DRIVE_READONLY_SCOPE)) scopes.push(DRIVE_READONLY_SCOPE)
  const displayName = typeof record.displayName === 'string'
    ? stripControlCharacters(record.displayName).trim().slice(0, 200)
    : undefined
  return { permissionId, emailAddress, ...(displayName ? { displayName } : {}), scopes }
}

export function clearRememberedAccount(): void {
  if (!storageKey) return
  try { localStorage.removeItem(storageKey) } catch { /* Storage may be disabled in this browser. */ }
}

export function getRememberedAccount(): RememberedAccount | undefined {
  if (!storageKey) return undefined
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return undefined
    if (raw.length > MAX_RECORD_LENGTH) { clearRememberedAccount(); return undefined }
    const account = sanitizeAccount(JSON.parse(raw) as unknown)
    if (!account) clearRememberedAccount()
    return account
  } catch {
    clearRememberedAccount()
    return undefined
  }
}

export function rememberAccount(user: DriveAbout['user'], scopes: readonly string[]): void {
  if (!storageKey) return
  const account = sanitizeAccount({
    permissionId: user?.permissionId,
    emailAddress: user?.emailAddress,
    displayName: user?.displayName,
    scopes,
  })
  if (!account) { clearRememberedAccount(); return }
  try { localStorage.setItem(storageKey, JSON.stringify(account)) }
  catch { clearRememberedAccount() }
}
