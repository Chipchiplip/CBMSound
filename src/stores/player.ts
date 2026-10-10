import { create } from 'zustand'
import type { DriveTrack, PlayerState } from '../types'
import { clearMediaSession, fetchSmallFile, getFallbackLimit, mediaUrl, probeRangePlayback, releaseMediaRequests, setMediaManifest, subscribeMediaAuthRequired, subscribeMediaControllerChange } from '../services/media'
import { readMetadataFromDrive } from '../services/audioMetadata'
import { useLibraryStore } from './library'
import { getTokenState, subscribeToken } from '../services/auth'
import { getSessionGeneration, isSessionCurrent, subscribeSessionReset } from '../services/session'
import { clearPlaybackMemory, playbackMemoryKey, readPlaybackMemory, writePlaybackMemory } from '../services/playbackMemory'

interface PlayerStore extends PlayerState {
  loading: boolean
  needsAuth: boolean
  play: (track: DriveTrack, queue?: DriveTrack[]) => Promise<void>
  resumeAfterAuth: () => Promise<void>
  pause: () => void
  toggle: () => void
  next: (automatic?: boolean) => void
  previous: () => void
  seek: (seconds: number) => void
  setVolume: (value: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  onTime: (seconds: number) => void
  onDuration: (seconds: number) => void
  onEnded: () => void
  stop: () => void
  clearError: () => void
}

const audio = typeof Audio !== 'undefined' ? new Audio() : null
let blobUrl: string | undefined
let requestGeneration = 0
let playbackAbort: AbortController | undefined
let pendingSeek = 0
let audioReady = false
let shuffleRemaining: string[] = []
const metadataAttempts = new Set<string>()
let memoryKey: string | undefined
let restoredMemoryKey: string | undefined
let lastCheckpointAt = 0

function shuffled(ids: string[]): string[] {
  const result = [...ids]
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}

function availableTrack(id: string): DriveTrack | undefined {
  return useLibraryStore.getState().tracks.find((track) => track.id === id && !track.unavailable)
}

function resetShuffle(queue: DriveTrack[], currentId?: string): void {
  shuffleRemaining = shuffled([...new Set(queue.filter((track) => availableTrack(track.id) && track.id !== currentId).map((track) => track.id))])
}

function cancelPlaybackRequests(): void {
  requestGeneration++
  playbackAbort?.abort()
  playbackAbort = undefined
  releaseMediaRequests()
}

function unloadAudio(): void {
  audio?.pause()
  audioReady = false
  if (audio) { audio.removeAttribute('src'); audio.load() }
  if (blobUrl) URL.revokeObjectURL(blobUrl)
  blobUrl = undefined
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  currentTrack: null, queue: [], history: [], isPlaying: false, loading: false, needsAuth: false,
  duration: 0, currentTime: 0, volume: 0.8, isMuted: false, repeat: 'off', shuffle: false, error: null,

  play: (track, queue) => startPlayback(track, queue),
  resumeAfterAuth: async () => {
    const state = get()
    if (!state.needsAuth || !state.currentTrack || !getTokenState()) return
    const track = availableTrack(state.currentTrack.id)
    if (!track) { get().stop(); set({ error: 'Bài nhạc không còn trong thư viện.' }); return }
    await startPlayback(track, undefined, state.currentTime)
  },
  pause: () => {
    if (get().loading) cancelPlaybackRequests()
    audio?.pause()
    set({ isPlaying: false, loading: false })
    updateMediaPosition()
    savePlaybackCheckpoint(true, true)
  },
  toggle: () => {
    if (!audio || get().loading) return
    if (!get().currentTrack) return
    if (get().needsAuth) { if (getTokenState()) void get().resumeAfterAuth(); return }
    if (audio.paused) void resumeAudio()
    else get().pause()
  },
  next: (automatic) => {
    const state = get()
    if (automatic && state.repeat === 'one' && state.currentTrack && availableTrack(state.currentTrack.id)) {
      get().seek(0)
      void resumeAudio()
      return
    }
    const playable = state.queue.filter((track) => availableTrack(track.id))
    if (!playable.length) { get().stop(); return }
    let next: DriveTrack | undefined
    if (state.shuffle) {
      while (shuffleRemaining.length && !next) next = availableTrack(shuffleRemaining.shift()!)
      if (!next && state.repeat === 'all') {
        resetShuffle(playable, state.currentTrack?.id)
        next = availableTrack(shuffleRemaining.shift() || playable[0].id)
      }
    } else {
      const currentIndex = state.queue.findIndex((track) => track.id === state.currentTrack?.id)
      next = state.queue.slice(currentIndex + 1).map((track) => availableTrack(track.id)).find(Boolean)
      if (!next && state.repeat === 'all') next = availableTrack(playable[0].id)
    }
    if (!next) { get().pause(); return }
    set({ history: state.currentTrack ? [...state.history, state.currentTrack.id].slice(-100) : state.history })
    void get().play(next)
  },
  previous: () => {
    const state = get()
    if (state.currentTime > 3) { get().seek(0); return }
    const history = [...state.history]
    let previous: DriveTrack | undefined
    while (history.length && !previous) previous = availableTrack(history.pop()!)
    if (previous) {
      if (state.shuffle && state.currentTrack && availableTrack(state.currentTrack.id)) {
        shuffleRemaining = [state.currentTrack.id, ...shuffleRemaining.filter((id) => id !== state.currentTrack!.id && id !== previous!.id)]
      }
      set({ history })
      void get().play(previous)
    } else if (!state.shuffle) {
      const index = state.queue.findIndex((track) => track.id === state.currentTrack?.id)
      const preceding = state.queue.slice(0, Math.max(0, index)).reverse().map((track) => availableTrack(track.id)).find(Boolean)
      if (preceding) void get().play(preceding)
      else get().seek(0)
    }
  },
  seek: (seconds) => {
    if (!audio || !Number.isFinite(seconds)) return
    const duration = get().duration || (audio.src && Number.isFinite(audio.duration) ? audio.duration : 0)
    const currentTime = Math.max(0, Math.min(seconds, duration || seconds))
    if (get().needsAuth || get().loading || !audio.src || !audioReady) pendingSeek = currentTime
    else audio.currentTime = currentTime
    set({ currentTime })
    updateMediaPosition()
    savePlaybackCheckpoint(true)
  },
  setVolume: (value) => {
    const volume = Math.min(1, Math.max(0, value))
    const isMuted = volume === 0
    if (audio) { audio.volume = volume; audio.muted = isMuted }
    set({ volume, isMuted })
  },
  toggleMute: () => {
    const isMuted = !get().isMuted
    if (audio) audio.muted = isMuted
    set({ isMuted })
  },
  toggleShuffle: () => {
    const shuffle = !get().shuffle
    if (shuffle) resetShuffle(get().queue, get().currentTrack?.id)
    else shuffleRemaining = []
    set({ shuffle })
  },
  cycleRepeat: () => set({ repeat: get().repeat === 'off' ? 'all' : get().repeat === 'all' ? 'one' : 'off' }),
  onTime: (currentTime) => {
    if (get().currentTrack && audio?.src && audioReady && !get().loading && !get().needsAuth && Number.isFinite(currentTime)) set({ currentTime: Math.max(0, currentTime) })
    updateMediaPosition()
  },
  onDuration: (duration) => { if (Number.isFinite(duration) && duration > 0) set({ duration }); updateMediaPosition() },
  onEnded: () => get().next(true),
  stop: () => {
    savePlaybackCheckpoint(true, true)
    cancelPlaybackRequests()
    unloadAudio()
    pendingSeek = 0
    shuffleRemaining = []
    clearMediaSession()
    clearSystemMedia()
    set({ currentTrack: null, queue: [], history: [], isPlaying: false, loading: false, needsAuth: false, currentTime: 0, duration: 0, error: null })
  },
  clearError: () => set({ error: null }),
}))

async function startPlayback(track: DriveTrack, queue?: DriveTrack[], resumeAt = 0): Promise<void> {
  if (!audio) { usePlayerStore.setState({ error: 'Trình duyệt không hỗ trợ trình phát âm thanh.' }); return }
  if (track.unavailable || !availableTrack(track.id)) { usePlayerStore.setState({ error: 'Bài nhạc không còn trong thư viện. Hãy đồng bộ lại.' }); return }
  cancelPlaybackRequests()
  unloadAudio()
  const generation = requestGeneration
  const session = getSessionGeneration()
  const controller = new AbortController()
  playbackAbort = controller
  const current = () => generation === requestGeneration && isSessionCurrent(session) && !controller.signal.aborted
  const state = usePlayerStore.getState()
  const finalQueue = queue?.length ? queue : state.queue.length ? state.queue : [track]
  if (queue || !state.queue.length) resetShuffle(finalQueue, track.id)
  pendingSeek = resumeAt
  usePlayerStore.setState({
    currentTrack: track, queue: finalQueue, history: queue ? [] : state.history,
    currentTime: resumeAt, duration: track.duration || 0, error: null, isPlaying: false, loading: true, needsAuth: false,
  })
  setMediaManifest(useLibraryStore.getState().tracks)
  updateMediaSession(track)
  try {
    if (!getTokenState()) { requireAuth(); return }
    const rangeSupported = await probeRangePlayback(track, controller.signal)
    if (!current()) return
    let url: string
    if (rangeSupported) url = mediaUrl(track.id)
    else {
      if (track.size > getFallbackLimit()) throw new Error('Drive hoặc trình duyệt không hỗ trợ streaming file này. File lớn hơn giới hạn phát dự phòng 32 MiB.')
      const blob = await fetchSmallFile(track.id, controller.signal)
      if (!current()) return
      url = URL.createObjectURL(blob)
    }
    blobUrl = url.startsWith('blob:') ? url : undefined
    audio.crossOrigin = blobUrl ? null : 'anonymous'
    audio.src = url
    audio.load()
    await audio.play()
    if (!current()) return
    usePlayerStore.setState({ isPlaying: true, loading: false, error: null })
    void useLibraryStore.getState().addRecent(track.id)
    updateMediaSession(track)
    void enrichTrack(track, generation, session, controller.signal)
  } catch (cause) {
    if (!current()) return
    if ((cause as { status?: number })?.status === 401 || !getTokenState()) { requireAuth(); return }
    usePlayerStore.setState({ isPlaying: false, loading: false, error: cause instanceof Error ? cause.message : 'Không thể phát bài nhạc này.' })
  }
}

async function resumeAudio(): Promise<void> {
  if (!audio || !usePlayerStore.getState().currentTrack) return
  if (!getTokenState()) { requireAuth(); return }
  if (!audio.src || !audioReady) {
    const state = usePlayerStore.getState()
    await startPlayback(state.currentTrack!, undefined, state.currentTime)
    return
  }
  const generation = requestGeneration
  const session = getSessionGeneration()
  try {
    await audio.play()
    if (generation === requestGeneration && isSessionCurrent(session)) usePlayerStore.setState({ isPlaying: true, error: null })
  } catch {
    if (generation === requestGeneration && isSessionCurrent(session)) usePlayerStore.setState({ error: 'Không thể tiếp tục phát. Thử chọn lại bài hoặc kết nối lại Google.' })
  }
  updateMediaPosition()
}

function requireAuth(): void {
  const state = usePlayerStore.getState()
  if (!state.currentTrack) return
  const currentTime = state.loading || !audioReady ? state.currentTime : audio?.currentTime || state.currentTime
  cancelPlaybackRequests()
  audio?.pause()
  usePlayerStore.setState({ currentTime, isPlaying: false, loading: false, needsAuth: true, error: 'Phiên Google đã hết hạn. Kết nối lại để tiếp tục từ vị trí hiện tại.' })
  updateMediaPosition()
}

if (audio) {
  audio.volume = usePlayerStore.getState().volume
  audio.addEventListener('timeupdate', () => usePlayerStore.getState().onTime(audio.currentTime))
  audio.addEventListener('durationchange', () => usePlayerStore.getState().onDuration(audio.duration))
  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const position = Math.min(pendingSeek, audio.duration)
      if (position > 0) audio.currentTime = position
      audioReady = true
      usePlayerStore.setState({ duration: audio.duration, currentTime: position })
    }
    pendingSeek = 0
    updateMediaPosition()
  })
  audio.addEventListener('ended', () => usePlayerStore.getState().onEnded())
  audio.addEventListener('play', () => { if (!usePlayerStore.getState().loading) usePlayerStore.setState({ isPlaying: true }); updateMediaPosition() })
  audio.addEventListener('pause', () => { usePlayerStore.setState({ isPlaying: false }); updateMediaPosition(); savePlaybackCheckpoint(true, true) })
  audio.addEventListener('error', () => {
    const state = usePlayerStore.getState()
    if (state.loading || state.needsAuth || !state.currentTrack) return
    const code = audio.error?.code
    usePlayerStore.setState({ isPlaying: false, error: code === 4
      ? 'Codec hoặc luồng nhạc không tương thích với trình duyệt này.'
      : code === 2 ? 'Mất kết nối khi đang phát. Kết nối lại mạng rồi chọn lại bài.' : 'Không thể đọc dữ liệu bài nhạc từ Google Drive.' })
    updateMediaPosition()
  })
}

subscribeMediaControllerChange(() => setMediaManifest(useLibraryStore.getState().tracks))
subscribeToken((token) => {
  setMediaManifest(useLibraryStore.getState().tracks)
  if (!token && usePlayerStore.getState().currentTrack) requireAuth()
})
subscribeMediaAuthRequired(requireAuth)
subscribeSessionReset(() => { usePlayerStore.getState().stop(); metadataAttempts.clear() })

// Store IDs and playback preferences only. No media bytes or OAuth credentials
// are persisted, and a saved selection never opens a stream automatically.
function savePlaybackCheckpoint(force = false, readAudioPosition = false): void {
  const state = usePlayerStore.getState()
  if (!memoryKey || !state.currentTrack) return
  const now = Date.now()
  if (!force && now - lastCheckpointAt < 5_000) return
  const position = readAudioPosition && audio?.src && audioReady && !state.loading && !state.needsAuth ? audio.currentTime : state.currentTime
  const queueIds = [...new Set(state.queue.map((track) => track.id))].slice(0, 1_000)
  if (!queueIds.includes(state.currentTrack.id)) {
    if (queueIds.length === 1_000) queueIds.pop()
    queueIds.push(state.currentTrack.id)
  }
  writePlaybackMemory(memoryKey, {
    version: 1, trackId: state.currentTrack.id,
    currentTime: Math.max(0, Number.isFinite(position) ? position : state.currentTime),
    duration: state.duration, queueIds, history: state.history.slice(-100),
    shuffleRemaining: shuffleRemaining.slice(0, 1_000),
    volume: state.volume, isMuted: state.isMuted, repeat: state.repeat, shuffle: state.shuffle,
  })
  lastCheckpointAt = now
}

usePlayerStore.subscribe((state, previous) => {
  const changed = state.currentTrack?.id !== previous.currentTrack?.id || state.queue !== previous.queue
    || state.history !== previous.history || state.volume !== previous.volume || state.isMuted !== previous.isMuted
    || state.repeat !== previous.repeat || state.shuffle !== previous.shuffle
    || state.isPlaying !== previous.isPlaying || state.needsAuth !== previous.needsAuth
    || state.loading !== previous.loading || state.duration !== previous.duration
  savePlaybackCheckpoint(changed)
})

function restorePlaybackForLibrary(): void {
  const library = useLibraryStore.getState()
  const nextKey = library.user?.permissionId && library.folder?.folderId
    ? playbackMemoryKey(library.user.permissionId, library.folder.folderId) : undefined
  if (nextKey !== memoryKey) {
    savePlaybackCheckpoint(true, true)
    // Clear the previous account/folder before its playback can be observed in
    // the new context. Keep its own checkpoint for a future verified login.
    memoryKey = undefined
    restoredMemoryKey = undefined
    if (usePlayerStore.getState().currentTrack) usePlayerStore.getState().stop()
    memoryKey = nextKey
    lastCheckpointAt = 0
  }
  // A partial/failed sync or cached list cannot prove the saved file is gone.
  if (!nextKey || library.status !== 'ready' || library.cacheSource !== 'remote' || !getTokenState()) return
  const state = usePlayerStore.getState()
  if (restoredMemoryKey === nextKey) {
    if (state.currentTrack && !availableTrack(state.currentTrack.id)) {
      state.stop()
      clearPlaybackMemory(nextKey)
      library.setNotice('Bài đang nghe không còn khả dụng trong thư viện Drive.')
    }
    return
  }
  restoredMemoryKey = nextKey
  // A user may already be listening from the cache while a sync is retried.
  if (state.currentTrack) { savePlaybackCheckpoint(true); return }
  const saved = readPlaybackMemory(nextKey)
  if (!saved) return
  const track = availableTrack(saved.trackId)
  if (!track) {
    clearPlaybackMemory(nextKey)
    library.setNotice('Bài nghe lần trước không còn khả dụng trong thư viện Drive.')
    return
  }
  const queue = saved.queueIds.map(availableTrack).filter((item): item is DriveTrack => Boolean(item))
  if (!queue.some((item) => item.id === track.id)) queue.unshift(track)
  shuffleRemaining = saved.shuffleRemaining.filter((id) => id !== track.id && queue.some((item) => item.id === id))
  const duration = track.duration || saved.duration
  pendingSeek = Math.min(saved.currentTime, duration || saved.currentTime)
  if (audio) { audio.volume = saved.volume; audio.muted = saved.isMuted }
  usePlayerStore.setState({
    currentTrack: track, queue, history: saved.history.filter((id) => availableTrack(id)),
    currentTime: pendingSeek, duration, volume: saved.volume, isMuted: saved.isMuted,
    repeat: saved.repeat, shuffle: saved.shuffle, isPlaying: false, loading: false, needsAuth: false, error: null,
  })
  updateMediaSession(track)
}

useLibraryStore.subscribe(restorePlaybackForLibrary)
restorePlaybackForLibrary()
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => savePlaybackCheckpoint(true, true))
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePlaybackCheckpoint(true, true)
})

function updateMediaSession(track: DriveTrack): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  try {
    if (typeof MediaMetadata !== 'undefined') navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name.replace(/\.[^/.]+$/, ''), artist: track.artist || 'CBM Sound', album: track.album || 'MusicCloudLibrary',
      artwork: track.artwork ? [{ src: track.artwork }] : [],
    })
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => {
        if (usePlayerStore.getState().loading) return
        if (usePlayerStore.getState().needsAuth) void usePlayerStore.getState().resumeAfterAuth()
        else if (audio?.paused) void resumeAudio()
      },
      pause: () => usePlayerStore.getState().pause(), previoustrack: () => usePlayerStore.getState().previous(),
      nexttrack: () => usePlayerStore.getState().next(), stop: () => usePlayerStore.getState().stop(),
      seekto: (details) => { if (details.seekTime != null) usePlayerStore.getState().seek(details.seekTime) },
      seekbackward: (details) => usePlayerStore.getState().seek(usePlayerStore.getState().currentTime - (details.seekOffset || 10)),
      seekforward: (details) => usePlayerStore.getState().seek(usePlayerStore.getState().currentTime + (details.seekOffset || 10)),
    }
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler!) } catch { /* Optional browser action. */ }
    }
  } catch { /* Metadata is optional on browsers with partial support. */ }
  updateMediaPosition()
}

function updateMediaPosition(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const state = usePlayerStore.getState()
  try {
    navigator.mediaSession.playbackState = state.currentTrack ? state.isPlaying ? 'playing' : 'paused' : 'none'
    if (Number.isFinite(state.duration) && state.duration > 0) navigator.mediaSession.setPositionState({ duration: state.duration, playbackRate: audio?.playbackRate || 1, position: Math.min(state.duration, Math.max(0, state.currentTime)) })
  } catch { /* Position state is optional. */ }
}

function clearSystemMedia(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = null
  navigator.mediaSession.playbackState = 'none'
  try { navigator.mediaSession.setPositionState() } catch { /* Optional API. */ }
  for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'stop', 'seekto', 'seekbackward', 'seekforward'] as MediaSessionAction[]) {
    try { navigator.mediaSession.setActionHandler(action, null) } catch { /* Optional action. */ }
  }
}

async function enrichTrack(track: DriveTrack, generation: number, session: number, signal: AbortSignal): Promise<void> {
  const key = `${track.id}:${track.modifiedTime}`
  if (track.metadataChecked || metadataAttempts.has(key)) return
  metadataAttempts.add(key)
  const meta = await readMetadataFromDrive(track, signal)
  if (signal.aborted || !isSessionCurrent(session)) { metadataAttempts.delete(key); return }
  const latest = useLibraryStore.getState().tracks.find((item) => item.id === track.id)
  if (!latest || latest.unavailable || latest.modifiedTime !== track.modifiedTime) return
  const next = { ...latest, ...meta, metadataChecked: true }
  await useLibraryStore.getState().addTrack(next)
  if (signal.aborted || !isSessionCurrent(session) || generation !== requestGeneration || usePlayerStore.getState().currentTrack?.id !== track.id) return
  usePlayerStore.setState({ currentTrack: next, duration: next.duration || usePlayerStore.getState().duration })
  updateMediaSession(next)
}
