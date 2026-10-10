import { create } from 'zustand'
import { appError, isSupportedAudio, TRACK_METADATA_VERSION, type AppError, type DriveTrack, type LibraryMember, type PlayerState } from '../types'
import * as drive from '../services/drive'
import { DRIVE_FILE_SCOPE, getDriveIdentity, getReconnectScopes, getTokenState, requestAccessToken, signOut, type TokenState } from '../services/auth'
import { getRememberedAccount, rememberAccount } from '../services/rememberedAccount'
import { authorizeLibraryFolder } from '../services/googlePicker'
import { clearMediaSession, setMediaManifest } from '../services/media'
import { getCachedSnapshot, getLocalPreference, setCachedTracks, setLocalPreference } from '../services/cache'
import { getSessionGeneration, invalidateSession, isSessionCurrent, subscribeSessionReset } from '../services/session'

export type LibraryPage = 'home' | 'library' | 'playlists' | 'recent' | 'upload' | 'settings'
export type LibraryStatus = 'signedOut' | 'connecting' | 'ready' | 'needsFolder' | 'error'

export interface LocalPlaylist {
  id: string
  name: string
  trackIds: string[]
  createdAt: string
}

interface LibraryState {
  status: LibraryStatus
  page: LibraryPage
  user: { permissionId?: string; displayName?: string; emailAddress?: string; photoLink?: string } | null
  folder: drive.LibraryContext | null
  tracks: DriveTrack[]
  members: LibraryMember[]
  playlists: LocalPlaylist[]
  recentTrackIds: string[]
  lastSynced: string | null
  cacheSource: 'none' | 'cache' | 'remote'
  query: string
  sort: 'name' | 'createdTime' | 'size'
  ascending: boolean
  busy: boolean
  error: string | null
  errorDetails: AppError | null
  notice: string | null
  permissionHelp: boolean
  connect: () => Promise<void>
  switchAccount: () => Promise<void>
  reconnect: () => Promise<void>
  authorizeRoot: () => Promise<void>
  enableReadAccess: () => Promise<void>
  createLibrary: () => Promise<void>
  setFolderId: (id: string) => Promise<void>
  sync: () => Promise<void>
  loadMembers: () => Promise<void>
  invite: (email: string) => Promise<void>
  removeMember: (id: string, inherited?: boolean) => Promise<void>
  rename: (track: DriveTrack, name: string) => Promise<void>
  removeTrack: (track: DriveTrack) => Promise<void>
  addTrack: (track: DriveTrack) => Promise<void>
  addRecent: (trackId: string) => Promise<void>
  createPlaylist: (name: string) => Promise<void>
  togglePlaylistTrack: (playlistId: string, trackId: string) => Promise<void>
  deletePlaylist: (playlistId: string) => Promise<void>
  setPage: (page: LibraryPage) => void
  setQuery: (query: string) => void
  setSort: (sort: LibraryState['sort']) => void
  disconnect: () => void
  setError: (error: string | null) => void
  setNotice: (notice: string | null) => void
}

function asError(error: unknown): AppError {
  if (error instanceof Error) return Object.assign(error, { retryable: Boolean((error as AppError).retryable) })
  return appError('Đã xảy ra lỗi. Hãy thử lại.')
}

function permissionHelp(error: AppError): boolean {
  return error.reason === 'appNotAuthorizedToFile' || error.reason === 'insufficientScopes' || error.reason === 'insufficientPermissions'
    || error.status === 404 || error.status === 403 && !error.reason
}

function prefKey(userId: string, key: string): string { return `user:${userId}:${key}` }

function emptyState() {
  return {
    status: 'signedOut' as LibraryStatus, page: 'home' as LibraryPage,
    user: null, folder: null, tracks: [] as DriveTrack[], members: [] as LibraryMember[],
    playlists: [] as LocalPlaylist[], recentTrackIds: [] as string[], lastSynced: null,
    cacheSource: 'none' as const, query: '', sort: 'name' as const, ascending: true,
    busy: false, error: null, errorDetails: null, notice: null, permissionHelp: false,
  }
}

let connectSequence = 0
let syncSequence = 0
let busyOperations = 0

export const useLibraryStore = create<LibraryState>((set, get) => {
  const beginBusy = () => {
    const generation = getSessionGeneration()
    busyOperations += 1
    set({ busy: true })
    return () => {
      if (!isSessionCurrent(generation)) return
      busyOperations = Math.max(0, busyOperations - 1)
      set({ busy: busyOperations > 0 })
    }
  }
  const current = (generation: number, userId?: string, folderId?: string) => isSessionCurrent(generation)
    && (!userId || get().user?.permissionId === userId)
    && (!folderId || get().folder?.folderId === folderId)
  const showError = (error: unknown) => {
    const details = asError(error)
    set({ error: details.message, errorDetails: details, permissionHelp: permissionHelp(details) })
  }
  const clearError = () => set({ error: null, errorDetails: null, permissionHelp: false })

  const connectWithToken = async (token: Promise<TokenState> | undefined) => {
    const generation = getSessionGeneration()
    const sequence = ++connectSequence
    const valid = () => isSessionCurrent(generation) && sequence === connectSequence
    const finish = beginBusy()
    set({ status: 'connecting', error: null, errorDetails: null, permissionHelp: false })
    try {
      if (token) await token
      if (!valid()) return
      const user = await getDriveIdentity()
      if (!valid()) return
      if (!user?.permissionId) throw appError('Không thể xác định tài khoản Google Drive hiện tại.')
      if (get().user?.permissionId && get().user?.permissionId !== user.permissionId) {
        // A different account selected during reconnect cannot inherit previous
        // playlists, requests, resumable jobs, or the current audio session.
        invalidateSession()
        await get().connect()
        return
      }
      set({ user })
      // This is a convenience hint only. Identity and every Drive permission are
      // verified remotely before any account-specific data is loaded.
      rememberAccount(user, getTokenState()?.scopes || [])
      const preferences = await Promise.allSettled([
        getLocalPreference<LocalPlaylist[]>(prefKey(user.permissionId, 'playlists')),
        getLocalPreference<string[]>(prefKey(user.permissionId, 'recent')),
      ])
      if (!valid()) return
      set({
        playlists: preferences[0].status === 'fulfilled' ? preferences[0].value || [] : [],
        recentTrackIds: preferences[1].status === 'fulfilled' ? preferences[1].value || [] : [],
      })
      if (preferences.some((result) => result.status === 'rejected')) set({ notice: 'Không đọc được dữ liệu cục bộ. Thư viện Drive vẫn hoạt động, nhưng playlist/lịch sử có thể chưa hiện.' })
      const folderId = await drive.getConfiguredFolderId()
      if (!valid()) return
      if (!folderId) { set({ status: 'needsFolder', folder: null, tracks: [] }); return }
      const folder = await drive.getLibraryContext(folderId)
      if (!valid()) return
      if (get().folder && get().folder?.folderId !== folderId) { set({ tracks: [], members: [], lastSynced: null, cacheSource: 'none' }); setMediaManifest([]) }
      set({ folder })
      try {
        const cached = await getCachedSnapshot(`${user.permissionId}:${folderId}`)
        if (!valid()) return
        if (cached) {
          // Existing audio in the configured root is listenable. A missing app
          // marker in legacy cache is not evidence of app ownership: keep it
          // explicitly read-only until the next full Drive snapshot says otherwise.
          const tracks = cached.tracks.filter(isSupportedAudio).map((track) => ({ ...upgradeTrackMetadata(track), appManaged: track.appManaged === true }))
          set({ tracks, lastSynced: cached.syncedAt, cacheSource: 'cache' })
          setMediaManifest(tracks)
        }
      } catch (error) {
        if (!valid()) return
        if ((error as Error).name !== 'AbortError') set({ notice: 'Không đọc được cache trên thiết bị; đang lấy thư viện trực tiếp từ Drive.' })
      }
      if (!valid()) return
      await get().sync()
      if (valid() && get().status === 'ready' && folder.ownedByMe && folder.canShare) await get().loadMembers()
    } catch (error) {
      if (!valid() || (error as Error).name === 'AbortError') return
      showError(error)
      set({ status: 'error' })
    } finally { finish() }
  }

  const remoteMutation = async (action: (valid: () => boolean) => Promise<void>, success?: string) => {
    const generation = getSessionGeneration()
    const userId = get().user?.permissionId
    const folderId = get().folder?.folderId
    const finish = beginBusy()
    clearError()
    try {
      await action(() => current(generation, userId, folderId))
      if (!current(generation, userId, folderId)) return
      if (success) set({ notice: success })
    } catch (error) {
      if (!current(generation, userId, folderId) || (error as Error).name === 'AbortError') return
      showError(error)
      throw error
    } finally { finish() }
  }

  const savePreference = async (key: string, value: unknown) => {
    const generation = getSessionGeneration()
    const userId = get().user?.permissionId
    if (!userId) return
    try { await setLocalPreference(prefKey(userId, key), value) }
    catch (error) {
      if (current(generation, userId) && (error as Error).name !== 'AbortError') showError(appError('Không lưu được playlist/lịch sử trên thiết bị này.', {
        recovery: 'Kiểm tra quyền IndexedDB, chế độ duyệt riêng tư và dung lượng thiết bị.',
      }))
    }
  }

  return {
    ...emptyState(),
    // The popup is requested before awaiting anything, preserving user activation.
    connect: () => {
      const remembered = getRememberedAccount()
      return connectWithToken(getTokenState() ? undefined : requestAccessToken({
        scopes: remembered?.scopes || [DRIVE_FILE_SCOPE],
        prompt: remembered ? '' : 'select_account',
        loginHint: remembered?.emailAddress,
      }))
    },
    switchAccount: () => {
      // Clear the old account, jobs and media before opening another account.
      signOut()
      return connectWithToken(requestAccessToken({ scopes: [DRIVE_FILE_SCOPE], prompt: 'select_account' }))
    },
    reconnect: () => {
      const scopes = getReconnectScopes()
      const loginHint = get().user?.emailAddress || getRememberedAccount()?.emailAddress
      const currentToken = getTokenState()
      return connectWithToken(currentToken && scopes.every((scope) => currentToken.scopes.includes(scope))
        ? undefined : requestAccessToken({ scopes, loginHint, prompt: '' }))
    },

    authorizeRoot: async () => {
      const generation = getSessionGeneration()
      const token = getTokenState() ? undefined : requestAccessToken({ scopes: getReconnectScopes(), loginHint: get().user?.emailAddress, prompt: '' })
      const finish = beginBusy()
      clearError()
      try {
        if (token) await token
        if (!isSessionCurrent(generation)) return
        const folderId = await drive.getConfiguredFolderId()
        if (!folderId) throw appError('Website chưa cấu hình thư mục gốc.')
        await authorizeLibraryFolder(folderId)
        if (!isSessionCurrent(generation)) return
        set({ notice: 'Đã chọn thư mục gốc bằng Google Picker; đang xác minh quyền với Google Drive.' })
        await get().connect()
      } catch (error) { if (isSessionCurrent(generation) && (error as Error).name !== 'AbortError') showError(error) }
      finally { finish() }
    },

    enableReadAccess: async () => {
      const generation = getSessionGeneration()
      // Start GIS directly from the caller's click; drive's async function calls
      // requestAccessToken synchronously before its first await.
      const access = drive.enableListenerReadOnly(get().user || undefined)
      const finish = beginBusy()
      clearError()
      try {
        await access
        if (isSessionCurrent(generation)) await get().connect()
      } catch (error) { if (isSessionCurrent(generation) && (error as Error).name !== 'AbortError') showError(error) }
      finally { finish() }
    },

    createLibrary: () => remoteMutation(async () => { await drive.createLibraryFolder() }),
    setFolderId: (id) => remoteMutation(async (valid) => { await drive.setConfiguredFolderId(id); if (valid()) await get().connect() }),

    sync: async () => {
      const { folder, user } = get()
      if (!folder || !user?.permissionId) return
      const generation = getSessionGeneration()
      const sequence = ++syncSequence
      const valid = () => current(generation, user.permissionId, folder.folderId) && sequence === syncSequence
      const finish = beginBusy()
      clearError()
      try {
        // listTracks returns only after all pages complete. A partial list or
        // failing page never becomes evidence that existing songs were deleted.
        const remoteTracks = await drive.listTracks(folder.folderId)
        if (!valid()) return
        const snapshot = reconcileSnapshot(remoteTracks, get().tracks)
        const syncedAt = new Date().toISOString()
        set({ tracks: snapshot, lastSynced: syncedAt, status: 'ready', cacheSource: 'remote' })
        setMediaManifest(snapshot)
        try { await setCachedTracks(`${user.permissionId}:${folder.folderId}`, snapshot, syncedAt) }
        catch (error) {
          if (valid() && (error as Error).name !== 'AbortError') set({ notice: 'Đã đồng bộ Drive, nhưng không lưu được cache metadata trên thiết bị.' })
        }
      } catch (error) {
        if (!valid() || (error as Error).name === 'AbortError') return
        const details = asError(error)
        showError(details)
        set({
          status: get().tracks.length && ![401, 403, 404].includes(details.status || 0) ? 'ready' : 'error',
          cacheSource: get().tracks.length ? 'cache' : 'none',
        })
      } finally { finish() }
    },

    loadMembers: async () => {
      const { folder, user } = get()
      if (!folder?.ownedByMe || !folder.canShare) return
      const generation = getSessionGeneration()
      try {
        const members = await drive.listMembers(folder.folderId)
        if (current(generation, user?.permissionId, folder.folderId)) set({ members })
      } catch (error) { if (current(generation, user?.permissionId, folder.folderId) && (error as Error).name !== 'AbortError') showError(error) }
    },

    invite: (email) => remoteMutation(async (valid) => {
      const folder = get().folder
      if (!folder?.ownedByMe || !folder.canShare) throw appError('Chỉ chủ sở hữu có quyền chia sẻ mới có thể mời thành viên.')
      await drive.inviteListener(folder.folderId, email)
      if (valid()) await get().loadMembers()
    }, 'Đã xác nhận quyền chỉ nghe cho thành viên. Google không gửi email; hãy sao chép URL website để gửi cho người nghe.'),

    removeMember: (id, inherited) => remoteMutation(async (valid) => {
      const folder = get().folder
      if (!folder?.ownedByMe || !folder.canShare) throw appError('Chỉ chủ sở hữu có quyền chia sẻ mới có thể thu hồi quyền.')
      const audit = await drive.removeListener(folder.folderId, id, inherited)
      if (!valid()) return
      await get().loadMembers()
      if (!valid()) return
      const notices = ['Google đã xác nhận thu hồi quyền trên thư mục.']
      if (audit.remainingFiles.length) notices.push(`Còn quyền truy cập riêng trên ${audit.remainingFiles.length} bài: ${audit.remainingFiles.map((file) => file.name).slice(0, 5).join(', ')}. Gỡ quyền trực tiếp trên các file trong Drive.`)
      if (audit.broadlySharedFiles.length) notices.push(`${audit.broadlySharedFiles.length} bài có quyền anyone/domain/nhóm; quyền rộng này vẫn có thể cho phép người nghe truy cập.`)
      if (audit.uncheckedFiles.length) notices.push(`Chưa kiểm tra được quyền trên ${audit.uncheckedFiles.length} bài; cần kiểm tra chia sẻ trong Drive.`)
      if (audit.scanError) notices.push(`Chưa kiểm tra được quyền trên các bài nhạc: ${audit.scanError}`)
      set({ notice: notices.join(' ') })
    }),

    rename: (track, name) => remoteMutation(async (valid) => {
      const folder = get().folder
      const cleanName = name.trim()
      if (!folder?.ownedByMe || track.unavailable) throw appError('Tài khoản hiện tại không thể đổi tên bài nhạc này.')
      if (!track.appManaged) throw appError('Nhạc có sẵn trên Drive chỉ được nghe trong CBM Sound.', {
        reason: 'externalTrackReadOnly', recovery: 'Mở Google Drive để đổi tên file. Ứng dụng chỉ quản lý file được upload qua CBM Sound.',
      })
      if (!cleanName || /[/\\\0]/.test(cleanName)) throw appError('Tên bài hát không hợp lệ.')
      const metadata = await drive.getFileMetadata(track.id, folder.folderId)
      if (!valid()) return
      if (!metadata.appManaged || !metadata.canRename) throw appError('Drive không cấp quyền đổi tên cho file do ứng dụng quản lý này.', { status: 403, reason: 'fileCapabilityDenied' })
      await drive.renameTrack(track.id, cleanName)
      if (!valid()) return
      const tracks = get().tracks.map((item) => item.id === track.id ? { ...item, name: cleanName } : item)
      set({ tracks })
      setMediaManifest(tracks)
      await get().sync()
    }, 'Đã đổi tên bài nhạc trên Drive.'),

    removeTrack: (track) => remoteMutation(async (valid) => {
      const folder = get().folder
      if (!folder?.ownedByMe || track.unavailable) throw appError('Tài khoản hiện tại không thể xóa bài nhạc này.')
      if (!track.appManaged) throw appError('Nhạc có sẵn trên Drive chỉ được nghe trong CBM Sound.', {
        reason: 'externalTrackReadOnly', recovery: 'Mở Google Drive để chuyển file vào thùng rác. Ứng dụng chỉ quản lý file được upload qua CBM Sound.',
      })
      const metadata = await drive.getFileMetadata(track.id, folder.folderId)
      if (!valid()) return
      if (!metadata.appManaged || !metadata.canTrash) throw appError('Drive không cấp quyền chuyển bài nhạc này vào thùng rác.', { status: 403, reason: 'fileCapabilityDenied' })
      await drive.trashTrack(track.id)
      if (!valid()) return
      const tracks = get().tracks.map((item) => item.id === track.id ? { ...item, unavailable: true } : item)
      set({ tracks })
      setMediaManifest(tracks)
      await get().sync()
    }, 'Đã chuyển bài nhạc vào thùng rác Drive. Playlist giữ dấu bài thiếu.'),

    addTrack: async (track) => {
      const { user, folder, lastSynced } = get()
      // Listening to existing audio may enrich its local metadata too. This
      // writes only the browser cache; it never adopts or modifies a Drive file.
      const existing = get().tracks.find((item) => item.id === track.id && item.modifiedTime === track.modifiedTime)
      if (!user?.permissionId || !folder || !track.appManaged && !existing) return
      const generation = getSessionGeneration()
      // Existing-track tag/duration updates are merged by reconcileSnapshot;
      // they must not cancel an in-flight authoritative Drive sync.
      if (!existing) syncSequence += 1
      const tracks = [track, ...get().tracks.filter((item) => item.id !== track.id)]
      set({ tracks })
      setMediaManifest(tracks)
      try { await setCachedTracks(`${user.permissionId}:${folder.folderId}`, tracks, lastSynced) }
      catch (error) { if (current(generation, user.permissionId, folder.folderId) && (error as Error).name !== 'AbortError') set({ notice: 'Bài đã có trên Drive; không lưu được cache metadata.' }) }
    },

    addRecent: async (trackId) => {
      if (!get().user?.permissionId) return
      const ids = [trackId, ...get().recentTrackIds.filter((id) => id !== trackId)].slice(0, 100)
      set({ recentTrackIds: ids })
      await savePreference('recent', ids)
    },
    createPlaylist: async (name) => {
      const clean = name.trim()
      if (!clean || !get().user?.permissionId) return
      const playlists = [{ id: crypto.randomUUID(), name: clean.slice(0, 80), trackIds: [], createdAt: new Date().toISOString() }, ...get().playlists]
      set({ playlists })
      await savePreference('playlists', playlists)
    },
    togglePlaylistTrack: async (playlistId, trackId) => {
      if (!get().user?.permissionId) return
      const playlists = get().playlists.map((playlist) => playlist.id !== playlistId ? playlist : {
        ...playlist,
        trackIds: playlist.trackIds.includes(trackId) ? playlist.trackIds.filter((id) => id !== trackId) : [...playlist.trackIds, trackId],
      })
      set({ playlists })
      await savePreference('playlists', playlists)
    },
    deletePlaylist: async (playlistId) => {
      if (!get().user?.permissionId) return
      const playlists = get().playlists.filter((playlist) => playlist.id !== playlistId)
      set({ playlists })
      await savePreference('playlists', playlists)
    },
    setPage: (page) => set({ page }),
    setQuery: (query) => set({ query }),
    setSort: (sort) => set((state) => ({ sort, ascending: state.sort === sort ? !state.ascending : true })),
    disconnect: signOut,
    setError: (error) => set((state) => {
      // UI action wrappers report the same exception after the service/store has
      // already recorded it. Keep its HTTP reason and recovery instructions.
      const errorDetails = error ? state.errorDetails?.message === error ? state.errorDetails : appError(error) : null
      return { error, errorDetails, permissionHelp: errorDetails ? permissionHelp(errorDetails) : false }
    }),
    setNotice: (notice) => set({ notice }),
  }
})

subscribeSessionReset(() => {
  connectSequence += 1
  syncSequence += 1
  busyOperations = 0
  clearMediaSession()
  useLibraryStore.setState(emptyState())
})

function upgradeTrackMetadata(track: DriveTrack): DriveTrack {
  return track.metadataVersion === TRACK_METADATA_VERSION ? track : {
    ...track, duration: undefined, metadataChecked: undefined, metadataVersion: undefined,
  }
}

export function reconcileSnapshot(remoteTracks: DriveTrack[], existingTracks: DriveTrack[]): DriveTrack[] {
  const existing = new Map(existingTracks.map((track) => [track.id, track]))
  const tracks = remoteTracks.map((track) => {
    const cached = existing.get(track.id)
    const local = cached ? upgradeTrackMetadata(cached) : undefined
    const currentTrack = { ...track, appManaged: track.appManaged === true }
    return local && local.modifiedTime === track.modifiedTime ? {
      ...currentTrack, artist: local.artist, album: local.album, duration: local.duration,
      artwork: local.artwork, metadataChecked: local.metadataChecked, metadataVersion: local.metadataVersion,
    } : currentTrack
  })
  const remoteIds = new Set(remoteTracks.map((track) => track.id))
  const missing = existingTracks.filter((track) => isSupportedAudio(track) && !remoteIds.has(track.id)).map((track) => ({ ...track, appManaged: track.appManaged === true, unavailable: true }))
  return [...tracks, ...missing]
}

export function selectVisibleTracks(state: Pick<LibraryState, 'tracks' | 'query' | 'sort' | 'ascending'>): DriveTrack[] {
  const needle = state.query.trim().toLocaleLowerCase()
  return state.tracks
    .filter((track) => !track.unavailable && isSupportedAudio(track) && (!needle || `${track.name} ${track.artist || ''} ${track.album || ''}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => {
      const first = state.sort === 'name' ? a.name.localeCompare(b.name, 'vi') : state.sort === 'size' ? a.size - b.size : Date.parse(a.createdTime) - Date.parse(b.createdTime)
      return (state.ascending ? 1 : -1) * first
    })
}

export function toPlayerState(tracks: DriveTrack[]): PlayerState {
  return {
    currentTrack: null, queue: tracks, history: [], isPlaying: false,
    duration: 0, currentTime: 0, volume: 0.8, isMuted: false,
    repeat: 'off', shuffle: false, error: null,
  }
}
