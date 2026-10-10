// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveTrack } from '../types'

const mocks = vi.hoisted(() => ({
  tracks: [] as DriveTrack[], generation: 0, token: { accessToken: 'test', expiresAt: Date.now() + 10000 } as { accessToken: string; expiresAt: number } | undefined,
  tokenListeners: [] as Array<(token: unknown) => void>, resetListeners: [] as Array<() => void>,
  probe: vi.fn(), metadata: vi.fn(), addTrack: vi.fn(), addRecent: vi.fn(), release: vi.fn(), clear: vi.fn(),
}))

vi.mock('../services/auth', () => ({
  getTokenState: () => mocks.token,
  subscribeToken: (listener: (token: unknown) => void) => { mocks.tokenListeners.push(listener); return () => undefined },
}))
vi.mock('../services/session', () => ({
  getSessionGeneration: () => mocks.generation, isSessionCurrent: (generation: number) => generation === mocks.generation,
  subscribeSessionReset: (listener: () => void) => { mocks.resetListeners.push(listener); return () => undefined },
}))
vi.mock('../services/media', () => ({
  clearMediaSession: mocks.clear, fetchSmallFile: vi.fn(), getFallbackLimit: () => 32 * 1024 * 1024,
  mediaUrl: (id: string) => `/__cbm_media__/${id}`, probeRangePlayback: mocks.probe, releaseMediaRequests: mocks.release,
  setMediaManifest: vi.fn(), subscribeMediaAuthRequired: vi.fn(), subscribeMediaControllerChange: vi.fn(),
}))
vi.mock('../services/audioMetadata', () => ({ readMetadataFromDrive: mocks.metadata }))
vi.mock('./library', () => ({ useLibraryStore: { getState: () => ({ tracks: mocks.tracks, addTrack: mocks.addTrack, addRecent: mocks.addRecent }) } }))

class TestAudio extends EventTarget {
  static current: TestAudio
  src = ''
  crossOrigin: string | null = null
  currentTime = 0
  duration = 120
  volume = 0.8
  muted = false
  paused = true
  playbackRate = 1
  error: { code: number } | null = null
  constructor() { super(); TestAudio.current = this }
  play = vi.fn(async () => { this.paused = false; this.dispatchEvent(new Event('play')) })
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')) })
  removeAttribute() { this.src = '' }
  load() {
    this.currentTime = 0
    if (this.src) this.dispatchEvent(new Event('loadedmetadata'))
  }
}

function track(id: string, unavailable = false): DriveTrack {
  return { id, name: `${id}.mp3`, mimeType: 'audio/mpeg', size: 100, createdTime: '2026-01-01', modifiedTime: '2026-01-01', unavailable }
}

type Store = typeof import('./player')['usePlayerStore']
let store: Store

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.tracks = [track('a'), track('b'), track('c')]
  mocks.generation = 0
  mocks.token = { accessToken: 'test', expiresAt: Date.now() + 10000 }
  mocks.tokenListeners = []
  mocks.resetListeners = []
  mocks.probe.mockReset().mockResolvedValue(true)
  mocks.metadata.mockReset().mockResolvedValue({})
  mocks.addTrack.mockReset().mockImplementation(async (value: DriveTrack) => {
    mocks.tracks = mocks.tracks.map((item) => item.id === value.id ? value : item)
  })
  vi.stubGlobal('Audio', TestAudio)
  vi.stubGlobal('navigator', {})
  store = (await import('./player')).usePlayerStore
})
afterEach(() => { store.getState().stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('player lifecycle and queue', () => {
  it('skips unavailable tracks going forward and back', async () => {
    mocks.tracks[1].unavailable = true
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().next()
    await vi.waitFor(() => expect(store.getState().currentTrack?.id).toBe('c'))
    store.getState().previous()
    await vi.waitFor(() => expect(store.getState().currentTrack?.id).toBe('a'))
  })

  it('finishes a shuffle round with repeat off and replays forward consistently after Previous', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().toggleShuffle()
    store.getState().next()
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    const nextId = store.getState().currentTrack!.id
    store.getState().previous()
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    expect(store.getState().currentTrack?.id).toBe('a')
    store.getState().next()
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    expect(store.getState().currentTrack?.id).toBe(nextId)
    store.getState().next()
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    expect(store.getState().currentTrack?.id).not.toBe(nextId)
    store.getState().next(true)
    expect(store.getState().isPlaying).toBe(false)
  })

  it('wraps Repeat All and restarts Repeat One on an automatic end', async () => {
    await store.getState().play(mocks.tracks[2], mocks.tracks)
    store.getState().cycleRepeat()
    store.getState().next(true)
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    expect(store.getState().currentTrack?.id).toBe('a')
    store.getState().cycleRepeat()
    store.getState().seek(40)
    store.getState().next(true)
    expect(TestAudio.current.currentTime).toBe(0)
    expect(store.getState().currentTrack?.id).toBe('a')
  })

  it('Previous seeks to zero after three seconds instead of changing track', async () => {
    await store.getState().play(mocks.tracks[1], mocks.tracks)
    store.getState().seek(10)
    store.getState().previous()
    expect(TestAudio.current.currentTime).toBe(0)
    expect(store.getState().currentTrack?.id).toBe('b')
  })

  it('unmutes the audio element when raising the volume after mute', () => {
    store.getState().toggleMute()
    expect(TestAudio.current.muted).toBe(true)
    store.getState().setVolume(0.5)
    expect(store.getState().isMuted).toBe(false)
    expect(TestAudio.current.muted).toBe(false)
    store.getState().setVolume(0)
    expect(TestAudio.current.muted).toBe(true)
  })

  it('pauses the old audio immediately and rejects a stale request during a switch', async () => {
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    let resolveProbe!: (supported: boolean) => void
    mocks.probe.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveProbe = resolve }))
    const pending = store.getState().play(mocks.tracks[1])
    expect(TestAudio.current.paused).toBe(true)
    expect(TestAudio.current.src).toBe('')
    const oldSignal = mocks.probe.mock.calls.at(-1)![1] as AbortSignal
    await store.getState().play(mocks.tracks[2])
    resolveProbe(true)
    await pending
    expect(oldSignal.aborted).toBe(true)
    expect(TestAudio.current.src).toBe('/__cbm_media__/c')
    expect(store.getState().currentTrack?.id).toBe('c')
  })

  it('does not let slow metadata replace the playing track or current account cache', async () => {
    let finish!: (tags: { artist: string }) => void
    mocks.metadata.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    await store.getState().play(mocks.tracks[1])
    finish({ artist: 'Artist A' })
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState().currentTrack?.id).toBe('b')
    expect(mocks.addTrack).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('honors Pause while a network probe is pending and can play the selected track afterward', async () => {
    let finish!: (supported: boolean) => void
    mocks.probe.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve }))
    const pending = store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().pause()
    finish(true)
    await pending
    expect(store.getState().isPlaying).toBe(false)
    expect(store.getState().loading).toBe(false)
    expect(TestAudio.current.src).toBe('')
    store.getState().toggle()
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    expect(TestAudio.current.src).toBe('/__cbm_media__/a')
  })

  it('remembers an empty metadata attempt instead of redownloading four MiB every play', async () => {
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    await vi.waitFor(() => expect(mocks.addTrack).toHaveBeenCalledWith(expect.objectContaining({ metadataChecked: true })))
    await store.getState().play(mocks.tracks[0])
    expect(mocks.metadata).toHaveBeenCalledOnce()
  })

  it('holds the seek position through token expiration and resumes after reconnect', async () => {
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().seek(42)
    mocks.token = undefined
    for (const listener of mocks.tokenListeners) listener(undefined)
    expect(store.getState().needsAuth).toBe(true)
    expect(store.getState().currentTime).toBe(42)
    expect(TestAudio.current.paused).toBe(true)
    mocks.token = { accessToken: 'renewed', expiresAt: Date.now() + 10000 }
    await store.getState().resumeAfterAuth()
    expect(store.getState().needsAuth).toBe(false)
    expect(TestAudio.current.currentTime).toBe(42)
    expect(store.getState().isPlaying).toBe(true)
  })

  it('clears queue/history and ignores metadata arriving after logout', async () => {
    let finish!: (tags: { artist: string }) => void
    mocks.metadata.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    mocks.generation++
    for (const listener of mocks.resetListeners) listener()
    finish({ artist: 'Old account' })
    await Promise.resolve()
    expect(store.getState().currentTrack).toBeNull()
    expect(store.getState().queue).toEqual([])
    expect(store.getState().history).toEqual([])
    expect(TestAudio.current.src).toBe('')
    expect(mocks.addTrack).not.toHaveBeenCalled()
  })

  it('uses idempotent MediaSession Play and updates/clears position state', async () => {
    const handlers = new Map<string, ((details: object) => void) | null>()
    const mediaSession = { metadata: {} as object | null, playbackState: 'none', setPositionState: vi.fn(), setActionHandler: vi.fn((action: string, handler: ((details: object) => void) | null) => handlers.set(action, handler)) }
    vi.stubGlobal('navigator', { mediaSession })
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    const before = TestAudio.current.play.mock.calls.length
    handlers.get('play')!({})
    expect(TestAudio.current.paused).toBe(false)
    expect(TestAudio.current.play.mock.calls.length).toBe(before)
    store.getState().onDuration(120)
    store.getState().seek(10)
    expect(mediaSession.setPositionState).toHaveBeenCalledWith(expect.objectContaining({ position: 10, duration: 120 }))
    store.getState().stop()
    expect(mediaSession.metadata).toBeNull()
    expect(mediaSession.playbackState).toBe('none')
    expect(handlers.get('play')).toBeNull()
  })
})
