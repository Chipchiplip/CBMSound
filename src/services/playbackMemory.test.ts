import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaybackCheckpoint } from './playbackMemory'

const CLIENT_A = 'client-a.apps.googleusercontent.com'
const CLIENT_B = 'client-b.apps.googleusercontent.com'
let memory: typeof import('./playbackMemory')
let key: string

function checkpoint(): PlaybackCheckpoint {
  return {
    version: 1,
    trackId: 'track-b',
    currentTime: 75.125,
    duration: 210.5,
    queueIds: ['track-a', 'track-b', 'track-c'],
    history: ['track-a'],
    shuffleRemaining: ['track-c'],
    volume: 0.8,
    isMuted: false,
    repeat: 'all',
    shuffle: true,
  }
}

async function load(client = CLIENT_A) {
  vi.resetModules()
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', client)
  return import('./playbackMemory')
}

beforeEach(async () => {
  localStorage.clear()
  memory = await load()
  key = memory.playbackMemoryKey('account-a', 'folder-a')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('local playback checkpoints', () => {
  it('persists the last track, exact position, queue and options across a reload', async () => {
    memory.writePlaybackMemory(key, checkpoint())
    memory = await load()
    expect(memory.readPlaybackMemory(key)).toEqual(checkpoint())
  })

  it('partitions records by OAuth client, account and folder without delimiter collisions', async () => {
    memory.writePlaybackMemory(key, checkpoint())
    const otherAccount = memory.playbackMemoryKey('account-b', 'folder-a')
    const otherFolder = memory.playbackMemoryKey('account-a', 'folder-b')
    expect(memory.readPlaybackMemory(otherAccount)).toBeUndefined()
    expect(memory.readPlaybackMemory(otherFolder)).toBeUndefined()
    expect(memory.playbackMemoryKey('a:b', 'c')).not.toBe(memory.playbackMemoryKey('a', 'b:c'))
    expect(memory.playbackMemoryKey('a%3Ab', 'c')).not.toBe(memory.playbackMemoryKey('a:b', 'c'))
    memory = await load(CLIENT_B)
    expect(memory.readPlaybackMemory(memory.playbackMemoryKey('account-a', 'folder-a'))).toBeUndefined()
    memory.clearPlaybackMemory(otherAccount)
    memory = await load()
    expect(memory.readPlaybackMemory(key)).toEqual(checkpoint())
  })

  it('stores only the constrained schema even when callers supply credentials or track objects', () => {
    const value = { ...checkpoint(), accessToken: 'private-token', refreshToken: 'private-refresh', track: { name: 'Song', blob: 'audio-data' } }
    memory.writePlaybackMemory(key, value)
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(checkpoint())
  })

  it('scrubs unknown fields from an otherwise valid stored record', () => {
    localStorage.setItem(key, JSON.stringify({ ...checkpoint(), token: 'never-return', isPlaying: true }))
    expect(memory.readPlaybackMemory(key)).toEqual(checkpoint())
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(checkpoint())
  })

  it('returns fresh arrays so edits do not alter future restores', () => {
    memory.writePlaybackMemory(key, checkpoint())
    const saved = memory.readPlaybackMemory(key)!
    saved.queueIds.length = 0
    saved.history.push('edited')
    saved.shuffleRemaining.push('edited')
    expect(memory.readPlaybackMemory(key)).toEqual(checkpoint())
  })

  it.each([
    '', 'not-json', 'null', '[]', 'true', '{}', 'x'.repeat(512_001),
  ])('removes corrupted or oversized storage: %s', (raw) => {
    localStorage.setItem(key, raw)
    expect(memory.readPlaybackMemory(key)).toBeUndefined()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it.each([
    { version: 2 }, { version: '1' }, { trackId: '' }, { trackId: 'bad/id' }, { trackId: 'x'.repeat(201) },
    { currentTime: -1 }, { currentTime: '12' }, { currentTime: null }, { duration: -1 }, { duration: '210' },
    { queueIds: [] }, { queueIds: ['track-a'] }, { queueIds: [null, 'track-b'] },
    { queueIds: Array(1001).fill('track-b') }, { history: Array(101).fill('track-a') },
    { shuffleRemaining: Array(1001).fill('track-c') }, { history: 'track-a' }, { shuffleRemaining: ['bad/id'] },
    { volume: -0.1 }, { volume: 1.1 }, { volume: '0.8' }, { isMuted: 0 }, { shuffle: 'true' }, { repeat: 'forever' },
  ])('rejects invalid saved schema and clears the record: %j', (invalid) => {
    localStorage.setItem(key, JSON.stringify({ ...checkpoint(), ...invalid }))
    expect(memory.readPlaybackMemory(key)).toBeUndefined()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it.each([
    { currentTime: NaN }, { currentTime: Infinity }, { duration: Infinity }, { duration: NaN }, { volume: Infinity },
  ])('rejects nonfinite numbers on write instead of keeping an older checkpoint: %j', (invalid) => {
    memory.writePlaybackMemory(key, checkpoint())
    memory.writePlaybackMemory(key, { ...checkpoint(), ...invalid })
    expect(memory.readPlaybackMemory(key)).toBeUndefined()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('accepts boundary values and the exact array limits', () => {
    const value = { ...checkpoint(), currentTime: 0, duration: 0, volume: 0, queueIds: Array(1000).fill('track-b'), history: Array(100).fill('track-a'), shuffleRemaining: Array(1000).fill('track-c') }
    memory.writePlaybackMemory(key, value)
    expect(memory.readPlaybackMemory(key)).toEqual(value)
    memory.writePlaybackMemory(key, { ...value, volume: 1, repeat: 'one' })
    expect(memory.readPlaybackMemory(key)?.volume).toBe(1)
  })

  it('does not throw when storage is blocked for reads, writes or removals', () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    }
    expect(() => memory.writePlaybackMemory(key, checkpoint())).not.toThrow()
    expect(() => memory.clearPlaybackMemory(key)).not.toThrow()
    expect(memory.readPlaybackMemory(key)).toBeUndefined()
  })

  it('does not throw when browser storage is absent', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => memory.writePlaybackMemory(key, checkpoint())).not.toThrow()
    expect(() => memory.clearPlaybackMemory(key)).not.toThrow()
    expect(memory.readPlaybackMemory(key)).toBeUndefined()
  })

  it('clears the previous checkpoint when saving a newer one fails because storage is full', () => {
    memory.writePlaybackMemory(key, checkpoint())
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    memory.writePlaybackMemory(key, { ...checkpoint(), currentTime: 123 })
    expect(memory.readPlaybackMemory(key)).toBeUndefined()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('clears a checkpoint without affecting another account', () => {
    const otherKey = memory.playbackMemoryKey('account-b', 'folder-a')
    memory.writePlaybackMemory(key, checkpoint())
    memory.writePlaybackMemory(otherKey, { ...checkpoint(), currentTime: 25 })
    memory.clearPlaybackMemory(key)
    expect(memory.readPlaybackMemory(key)).toBeUndefined()
    expect(memory.readPlaybackMemory(otherKey)?.currentTime).toBe(25)
  })
})
