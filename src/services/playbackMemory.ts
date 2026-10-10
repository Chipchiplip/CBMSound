// A playback checkpoint is a local convenience, never evidence of Google
// authentication or permission to read a track. Restore it only after Drive sync.
export interface PlaybackCheckpoint {
  version: 1
  trackId: string
  currentTime: number
  duration: number
  queueIds: string[]
  history: string[]
  shuffleRemaining: string[]
  volume: number
  isMuted: boolean
  repeat: 'off' | 'one' | 'all'
  shuffle: boolean
}

const MAX_RECORD_LENGTH = 512_000
const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? ''

export function playbackMemoryKey(accountId: string, folderId: string): string {
  return `cbm-sound:playback:v1:${encodeURIComponent(clientId)}:${encodeURIComponent(accountId)}:${encodeURIComponent(folderId)}`
}

function isTrackId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)
}

function isPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function trackIds(value: unknown, maximum: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maximum || !value.every(isTrackId)) return undefined
  return [...value] as string[]
}

function sanitizeCheckpoint(value: unknown): PlaybackCheckpoint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const queueIds = trackIds(record.queueIds, 1000)
  const history = trackIds(record.history, 100)
  const shuffleRemaining = trackIds(record.shuffleRemaining, 1000)
  if (record.version !== 1 || !isTrackId(record.trackId) ||
      !isPosition(record.currentTime) || !isPosition(record.duration) ||
      !queueIds?.includes(record.trackId) || !history || !shuffleRemaining ||
      typeof record.volume !== 'number' || !Number.isFinite(record.volume) || record.volume < 0 || record.volume > 1 ||
      typeof record.isMuted !== 'boolean' || typeof record.shuffle !== 'boolean' ||
      (record.repeat !== 'off' && record.repeat !== 'one' && record.repeat !== 'all')) return undefined
  // Construct the whitelist explicitly: never retain track objects, credentials,
  // audio data or unknown fields supplied by older builds or edited storage.
  return {
    version: 1,
    trackId: record.trackId,
    currentTime: record.currentTime,
    duration: record.duration,
    queueIds,
    history,
    shuffleRemaining,
    volume: record.volume,
    isMuted: record.isMuted,
    repeat: record.repeat,
    shuffle: record.shuffle,
  }
}

export function clearPlaybackMemory(key: string): void {
  try { localStorage.removeItem(key) }
  catch { /* Storage may be unavailable or disabled; playback can continue. */ }
}

export function readPlaybackMemory(key: string): PlaybackCheckpoint | undefined {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return undefined
    if (raw.length > MAX_RECORD_LENGTH) { clearPlaybackMemory(key); return undefined }
    const checkpoint = sanitizeCheckpoint(JSON.parse(raw) as unknown)
    if (!checkpoint) { clearPlaybackMemory(key); return undefined }
    const clean = JSON.stringify(checkpoint)
    if (clean !== raw) {
      try { localStorage.setItem(key, clean) }
      catch { clearPlaybackMemory(key) }
    }
    return checkpoint
  } catch {
    clearPlaybackMemory(key)
    return undefined
  }
}

export function writePlaybackMemory(key: string, value: PlaybackCheckpoint): void {
  const checkpoint = sanitizeCheckpoint(value)
  if (!checkpoint) { clearPlaybackMemory(key); return }
  try { localStorage.setItem(key, JSON.stringify(checkpoint)) }
  catch { clearPlaybackMemory(key) }
}
