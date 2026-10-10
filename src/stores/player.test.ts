// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TRACK_METADATA_VERSION, type DriveTrack } from '../types'

const mocks = vi.hoisted(() => ({
  tracks: [] as DriveTrack[], generation: 0, token: { accessToken: 'test', expiresAt: Date.now() + 10000 } as { accessToken: string; expiresAt: number } | undefined,
  tokenListeners: [] as Array<(token: unknown) => void>, resetListeners: [] as Array<() => void>,
  probe: vi.fn(), metadata: vi.fn(), addTrack: vi.fn(), addRecent: vi.fn(), release: vi.fn(), clear: vi.fn(),
  accountId: undefined as string | undefined, folderId: undefined as string | undefined,
  status: 'ready', cacheSource: 'remote', libraryListeners: [] as Array<() => void>, notice: vi.fn(),
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
vi.mock('./library', () => ({ useLibraryStore: {
  getState: () => ({
    tracks: mocks.tracks, addTrack: mocks.addTrack, addRecent: mocks.addRecent, setNotice: mocks.notice,
    user: mocks.accountId ? { permissionId: mocks.accountId } : null,
    folder: mocks.folderId ? { folderId: mocks.folderId } : null,
    status: mocks.status, cacheSource: mocks.cacheSource,
  }),
  subscribe: (listener: () => void) => { mocks.libraryListeners.push(listener); return () => undefined },
} }))

class TestAudio extends EventTarget {
  static current: TestAudio
  src = ''
  crossOrigin: string | null = null
  currentTime = 0
  duration = 120
  volume = 0.8
  muted = false
  paused = true
  autoMetadata = true
  playbackRate = 1
  error: { code: number } | null = null
  constructor() { super(); TestAudio.current = this }
  play = vi.fn(async () => { this.paused = false; this.dispatchEvent(new Event('play')) })
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')) })
  removeAttribute() { this.src = '' }
  load() {
    this.currentTime = 0
    if (this.src && this.autoMetadata) this.dispatchEvent(new Event('loadedmetadata'))
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
  mocks.libraryListeners = []
  mocks.accountId = undefined
  mocks.folderId = undefined
  mocks.status = 'ready'
  mocks.cacheSource = 'remote'
  mocks.probe.mockReset().mockResolvedValue(true)
  mocks.metadata.mockReset().mockResolvedValue({})
  mocks.addTrack.mockReset().mockImplementation(async (value: DriveTrack) => {
    mocks.tracks = mocks.tracks.map((item) => item.id === value.id ? value : item)
  })
  vi.stubGlobal('Audio', TestAudio)
  vi.stubGlobal('navigator', {})
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => saved.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { saved.set(key, value) }),
    removeItem: vi.fn((key: string) => { saved.delete(key) }),
  })
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  store = (await import('./player')).usePlayerStore
})

function activateLibrary(accountId = 'account-a', folderId = 'root-a', cacheSource = 'remote'): void {
  mocks.accountId = accountId
  mocks.folderId = folderId
  mocks.cacheSource = cacheSource
  for (const listener of mocks.libraryListeners) listener()
}

async function savedPlayback(accountId = 'account-a', folderId = 'root-a') {
  const memory = await import('../services/playbackMemory')
  return memory.readPlaybackMemory(memory.playbackMemoryKey(accountId, folderId))
}

describe('last playback on this device', () => {
  it('restores the last track and position after reload without fetching or autoplaying', async () => {
    activateLibrary()
    await store.getState().play(mocks.tracks[1], mocks.tracks)
    store.getState().seek(37.5)
    store.getState().pause()
    expect(await savedPlayback()).toMatchObject({ trackId: 'b', currentTime: 37.5, queueIds: ['a', 'b', 'c'] })
    vi.resetModules()
    mocks.probe.mockClear()
    mocks.metadata.mockClear()
    mocks.libraryListeners = []
    store = (await import('./player')).usePlayerStore
    expect(store.getState()).toMatchObject({ currentTrack: { id: 'b' }, currentTime: 37.5, isPlaying: false, loading: false })
    expect(TestAudio.current.src).toBe('')
    expect(TestAudio.current.play).not.toHaveBeenCalled()
    expect(mocks.probe).not.toHaveBeenCalled()
    expect(mocks.metadata).not.toHaveBeenCalled()
    store.getState().toggle()
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    expect(TestAudio.current.currentTime).toBe(37.5)
    store.getState().next()
    await vi.waitFor(() => expect(store.getState().currentTrack?.id).toBe('c'))
  })

  it('saves an exact final position on pagehide and when hiding the page', async () => {
    activateLibrary()
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    TestAudio.current.currentTime = 23.75
    window.dispatchEvent(new Event('pagehide'))
    expect(await savedPlayback()).toMatchObject({ currentTime: 23.75 })
    TestAudio.current.currentTime = 28.5
    Object.assign(document, { visibilityState: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(await savedPlayback()).toMatchObject({ currentTime: 28.5 })
  })

  it('keeps separate positions when switching account or folder and preserves logout checkpoint', async () => {
    activateLibrary()
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().seek(42)
    activateLibrary('account-b')
    expect(store.getState().currentTrack).toBeNull()
    expect(await savedPlayback()).toMatchObject({ trackId: 'a', currentTime: 42 })
    expect(await savedPlayback('account-b')).toBeUndefined()
    await store.getState().play(mocks.tracks[1], mocks.tracks)
    store.getState().seek(11)
    activateLibrary('account-b', 'root-b')
    expect(store.getState().currentTrack).toBeNull()
    expect(await savedPlayback('account-b')).toMatchObject({ trackId: 'b', currentTime: 11 })
    activateLibrary()
    expect(store.getState()).toMatchObject({ currentTrack: { id: 'a' }, currentTime: 42, isPlaying: false })
    mocks.accountId = undefined
    mocks.folderId = undefined
    for (const listener of mocks.libraryListeners) listener()
    expect(store.getState().currentTrack).toBeNull()
    expect(await savedPlayback()).toMatchObject({ trackId: 'a', currentTime: 42 })
  })

  it('waits for authenticated complete Drive sync before restoring or declaring a song missing', async () => {
    activateLibrary()
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().seek(20)
    store.getState().stop()
    activateLibrary('account-b')
    mocks.tracks = []
    activateLibrary('account-a', 'root-a', 'cache')
    expect(store.getState().currentTrack).toBeNull()
    expect(await savedPlayback()).toMatchObject({ trackId: 'a' })
    mocks.token = undefined
    activateLibrary()
    expect(store.getState().currentTrack).toBeNull()
    expect(await savedPlayback()).toMatchObject({ trackId: 'a' })
    mocks.token = { accessToken: 'renewed', expiresAt: Date.now() + 10000 }
    mocks.tracks = [track('a'), track('b')]
    activateLibrary()
    expect(store.getState()).toMatchObject({ currentTrack: { id: 'a' }, currentTime: 20, isPlaying: false })
  })

  it('clears a missing saved song only after successful remote sync and filters deleted queue entries', async () => {
    activateLibrary()
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().seek(30)
    activateLibrary('account-b')
    mocks.tracks[1].unavailable = true
    activateLibrary()
    expect(store.getState().queue.map((item) => item.id)).toEqual(['a', 'c'])
    mocks.tracks[0].unavailable = true
    activateLibrary()
    expect(store.getState().currentTrack).toBeNull()
    expect(await savedPlayback()).toBeUndefined()
    expect(mocks.notice).toHaveBeenCalledWith(expect.stringContaining('không còn khả dụng'))
  })

  it('remembers shuffle history and playback settings without auth data', async () => {
    activateLibrary()
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().toggleShuffle()
    store.getState().setVolume(0.35)
    store.getState().toggleMute()
    store.getState().cycleRepeat()
    store.getState().next()
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    store.getState().pause()
    const saved = await savedPlayback()
    expect(saved).toMatchObject({ history: ['a'], shuffle: true, repeat: 'all', volume: 0.35, isMuted: true })
    expect(JSON.stringify(saved)).not.toContain('accessToken')
    vi.resetModules()
    mocks.libraryListeners = []
    store = (await import('./player')).usePlayerStore
    expect(store.getState()).toMatchObject({ history: ['a'], shuffle: true, repeat: 'all', volume: 0.35, isMuted: true, isPlaying: false })
    expect(TestAudio.current.muted).toBe(true)
    expect(TestAudio.current.volume).toBe(0.35)
    store.getState().previous()
    await vi.waitFor(() => expect(store.getState().currentTrack?.id).toBe('a'))
  })

  it('retains seeking on a restored track before it has any audio source', async () => {
    activateLibrary()
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().seek(35)
    activateLibrary('account-b')
    activateLibrary()
    expect(TestAudio.current.src).toBe('')
    store.getState().seek(67)
    expect(store.getState().currentTime).toBe(67)
    TestAudio.current.dispatchEvent(new Event('timeupdate'))
    expect(store.getState().currentTime).toBe(67)
    store.getState().toggle()
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    expect(TestAudio.current.currentTime).toBe(67)
  })

  it('preserves a restored offset when paused before metadata loads and reloads the stream to resume', async () => {
    activateLibrary()
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().seek(42.5)
    activateLibrary('account-b')
    activateLibrary()
    expect(store.getState().currentTime).toBe(42.5)

    TestAudio.current.autoMetadata = false
    let finishFirstPlay!: () => void
    TestAudio.current.play.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirstPlay = resolve }))
    store.getState().toggle()
    await vi.waitFor(() => expect(TestAudio.current.src).toBe('/__cbm_media__/a'))
    expect(store.getState().loading).toBe(true)
    expect(TestAudio.current.currentTime).toBe(0)
    store.getState().pause()
    expect(await savedPlayback()).toMatchObject({ trackId: 'a', currentTime: 42.5 })

    // An old/early timeupdate must not replace the resume position before the
    // newly selected source has exposed metadata and applied its initial seek.
    TestAudio.current.dispatchEvent(new Event('timeupdate'))
    expect(store.getState().currentTime).toBe(42.5)
    window.dispatchEvent(new Event('pagehide'))
    expect(await savedPlayback()).toMatchObject({ currentTime: 42.5 })

    const priorProbes = mocks.probe.mock.calls.length
    TestAudio.current.autoMetadata = true
    store.getState().toggle()
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    expect(mocks.probe).toHaveBeenCalledTimes(priorProbes + 1)
    expect(TestAudio.current.currentTime).toBe(42.5)
    finishFirstPlay()
    await Promise.resolve()
    expect(store.getState()).toMatchObject({ currentTime: 42.5, isPlaying: true, loading: false })
  })

  it('persists position at most every five seconds while playing and immediately on pause', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000)
    activateLibrary()
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    TestAudio.current.currentTime = 3
    store.getState().onTime(3)
    expect(await savedPlayback()).toMatchObject({ currentTime: 0 })
    vi.spyOn(Date, 'now').mockReturnValue(15_000)
    TestAudio.current.currentTime = 8
    store.getState().onTime(8)
    expect(await savedPlayback()).toMatchObject({ currentTime: 8 })
    TestAudio.current.currentTime = 9.75
    store.getState().pause()
    expect(await savedPlayback()).toMatchObject({ currentTime: 9.75 })
  })
})
afterEach(() => { store.getState().stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('player lifecycle and queue', () => {
  it('keeps an 80-minute stream duration when delayed tags report the old 1:44 prefix duration', async () => {
    let finish!: (tags: { duration: number; artist: string }) => void
    mocks.metadata.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    mocks.tracks[0] = { ...mocks.tracks[0], duration: 104, metadataChecked: true }
    TestAudio.current.duration = 4800
    activateLibrary()
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    expect(store.getState().duration).toBe(4800)
    finish({ duration: 104, artist: 'Long recording' })
    await vi.waitFor(() => expect(store.getState().currentTrack?.artist).toBe('Long recording'))
    expect(store.getState().duration).toBe(4800)
    expect(mocks.tracks[0]).toMatchObject({ duration: 4800, metadataVersion: TRACK_METADATA_VERSION })
    store.getState().seek(2400)
    expect(TestAudio.current.currentTime).toBe(2400)
    expect(store.getState().currentTime).toBe(2400)
    store.getState().pause()
    expect(await savedPlayback()).toMatchObject({ duration: 4800, currentTime: 2400 })
  })

  it('accepts a later durationchange and can play with initially unknown duration', async () => {
    TestAudio.current.duration = Infinity
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    TestAudio.current.currentTime = 130
    TestAudio.current.dispatchEvent(new Event('timeupdate'))
    expect(store.getState()).toMatchObject({ duration: 0, currentTime: 130, isPlaying: true })
    TestAudio.current.duration = 4800
    TestAudio.current.dispatchEvent(new Event('durationchange'))
    expect(store.getState()).toMatchObject({ duration: 4800, currentTime: 130 })
    expect(mocks.tracks[0]).toMatchObject({ duration: 4800, metadataVersion: TRACK_METADATA_VERSION })
    TestAudio.current.duration = 4820
    TestAudio.current.dispatchEvent(new Event('durationchange'))
    expect(store.getState().duration).toBe(4820)
    store.getState().seek(2400)
    expect(TestAudio.current.currentTime).toBe(2400)
    store.getState().stop()
    TestAudio.current.dispatchEvent(new Event('durationchange'))
    expect(store.getState().duration).toBe(0)
  })

  it('preserves a saved position past the legacy duration until the full source loads again', async () => {
    activateLibrary()
    TestAudio.current.duration = 4800
    await store.getState().play(mocks.tracks[0], mocks.tracks)
    store.getState().seek(2400)
    store.getState().pause()
    const memory = await import('../services/playbackMemory')
    const key = memory.playbackMemoryKey('account-a', 'root-a')
    memory.writePlaybackMemory(key, { ...(await savedPlayback())!, duration: 104 })
    mocks.tracks[0] = { ...mocks.tracks[0], duration: 104, metadataChecked: true, metadataVersion: undefined }
    vi.resetModules()
    mocks.libraryListeners = []
    store = (await import('./player')).usePlayerStore
    expect(store.getState()).toMatchObject({ duration: 0, currentTime: 2400, isPlaying: false })
    TestAudio.current.duration = 4800
    store.getState().toggle()
    await vi.waitFor(() => expect(store.getState().isPlaying).toBe(true))
    expect(store.getState().duration).toBe(4800)
    expect(TestAudio.current.currentTime).toBe(2400)
  })

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
    mocks.addTrack.mockClear()
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
    mocks.addTrack.mockClear()
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
