import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TRACK_METADATA_VERSION, type DriveTrack } from '../types'

const mocks = vi.hoisted(() => ({
  auth: { getDriveIdentity: vi.fn(), getTokenState: vi.fn(), getReconnectScopes: vi.fn(), requestAccessToken: vi.fn(), invalidateAccessToken: vi.fn(), signOut: vi.fn() },
  drive: { getConfiguredFolderId: vi.fn(), getLibraryContext: vi.fn(), listTracks: vi.fn(), listMembers: vi.fn(), getFileMetadata: vi.fn(), renameTrack: vi.fn(), trashTrack: vi.fn(), inviteListener: vi.fn(), removeListener: vi.fn(), enableListenerReadOnly: vi.fn(), createLibraryFolder: vi.fn(), setConfiguredFolderId: vi.fn() },
  cache: { getCachedSnapshot: vi.fn(), getLocalPreference: vi.fn(), setCachedTracks: vi.fn(), setLocalPreference: vi.fn() },
  media: { clearMediaSession: vi.fn(), setMediaManifest: vi.fn() },
  remembered: { getRememberedAccount: vi.fn(), rememberAccount: vi.fn() },
}))

vi.mock('../services/auth', () => ({ ...mocks.auth, DRIVE_FILE_SCOPE: 'drive.file' }))
vi.mock('../services/drive', () => mocks.drive)
vi.mock('../services/cache', () => mocks.cache)
vi.mock('../services/media', () => mocks.media)
vi.mock('../services/rememberedAccount', () => mocks.remembered)
vi.mock('../services/googlePicker', () => ({ authorizeLibraryFolder: vi.fn() }))

import { reconcileSnapshot, selectVisibleTracks, useLibraryStore } from './library'
import { getSessionGeneration, invalidateSession } from '../services/session'

const user = { permissionId: 'account-a', displayName: 'A', emailAddress: 'a@example.test' }
const folder = { folderId: 'root', name: 'Library', ownedByMe: false, canAddChildren: false, canRename: false, canDeleteChildren: false, canShare: false, isAppAuthorized: true }
const token = { accessToken: 'test', expiresAt: Date.now() + 100000, scopes: ['drive.file'] }
const track = (id: string, options: Partial<DriveTrack> = {}): DriveTrack => ({
  id, name: `${id}.mp3`, mimeType: 'audio/mpeg', size: 10, createdTime: '2026-01-01', modifiedTime: '2026-01-01', appManaged: true, ...options,
})

beforeEach(() => {
  invalidateSession()
  Object.values(mocks).forEach((group) => Object.values(group).forEach((mock) => mock.mockReset()))
  mocks.auth.signOut.mockImplementation(invalidateSession)
  mocks.auth.getTokenState.mockReturnValue(token)
  mocks.auth.getReconnectScopes.mockReturnValue(['drive.file'])
  mocks.auth.requestAccessToken.mockResolvedValue(token)
  mocks.auth.getDriveIdentity.mockResolvedValue(user)
  mocks.drive.getConfiguredFolderId.mockResolvedValue('root')
  mocks.drive.getLibraryContext.mockResolvedValue(folder)
  mocks.drive.listTracks.mockResolvedValue([])
  mocks.drive.listMembers.mockResolvedValue([])
  mocks.cache.getLocalPreference.mockResolvedValue(undefined)
  mocks.cache.getCachedSnapshot.mockResolvedValue(undefined)
  mocks.cache.setCachedTracks.mockResolvedValue(undefined)
})

describe('full library snapshots', () => {
  it('retains the last full snapshot after a later Drive page fails', async () => {
    const previous = track('a')
    useLibraryStore.setState({ user, folder, tracks: [previous], lastSynced: '2026-01-01', status: 'ready', cacheSource: 'remote' })
    mocks.drive.listTracks.mockRejectedValue(Object.assign(new Error('page 2 failed'), { retryable: true, status: 503 }))
    await useLibraryStore.getState().sync()
    expect(useLibraryStore.getState()).toMatchObject({ tracks: [previous], lastSynced: '2026-01-01', cacheSource: 'cache', error: 'page 2 failed' })
    expect(mocks.cache.setCachedTracks).not.toHaveBeenCalled()
    expect(useLibraryStore.getState().tracks[0].unavailable).toBeUndefined()
  })

  it('invalidates extracted metadata only when the file content metadata changed', () => {
    const tagged = track('a', { artist: 'Artist', duration: 120, artwork: 'data:image/test', metadataChecked: true, metadataVersion: TRACK_METADATA_VERSION })
    expect(reconcileSnapshot([track('a')], [tagged])[0]).toMatchObject({ artist: 'Artist', metadataChecked: true })
    const changed = reconcileSnapshot([track('a', { modifiedTime: '2026-02-02' })], [tagged])[0]
    expect(changed.artist).toBeUndefined()
    expect(changed.artwork).toBeUndefined()
    expect(changed.metadataChecked).toBeUndefined()
  })

  it('discards legacy prefix durations without losing artist, artwork or library files', async () => {
    const legacy = track('a', { artist: 'Artist', duration: 104, artwork: 'data:image/test', metadataChecked: true })
    const reconciled = reconcileSnapshot([track('a')], [legacy])[0]
    expect(reconciled).toMatchObject({ id: 'a', artist: 'Artist', artwork: 'data:image/test' })
    expect(reconciled.duration).toBeUndefined()
    expect(reconciled.metadataChecked).toBeUndefined()
    mocks.cache.getCachedSnapshot.mockResolvedValue({ tracks: [legacy], syncedAt: '2026-01-01' })
    mocks.drive.listTracks.mockRejectedValue(new Error('offline'))
    await useLibraryStore.getState().connect()
    expect(useLibraryStore.getState().tracks[0].duration).toBeUndefined()
    expect(useLibraryStore.getState().tracks[0].artist).toBe('Artist')
  })

  it('caches duration and tags for existing audio without granting Drive management rights', async () => {
    const external = track('existing', { appManaged: false })
    useLibraryStore.setState({ user, folder, tracks: [external], lastSynced: '2026-01-01' })
    await useLibraryStore.getState().addTrack({ ...external, duration: 4800, metadataVersion: TRACK_METADATA_VERSION })
    expect(useLibraryStore.getState().tracks[0]).toMatchObject({ duration: 4800, appManaged: false })
    expect(mocks.cache.setCachedTracks).toHaveBeenCalled()
    expect(mocks.drive.renameTrack).not.toHaveBeenCalled()
    expect(mocks.drive.trashTrack).not.toHaveBeenCalled()
    await useLibraryStore.getState().addTrack(track('outside', { appManaged: false }))
    expect(useLibraryStore.getState().tracks.map((item) => item.id)).toEqual(['existing'])
  })

  it('finishes the full Drive sync when playback enriches a cached song in the meantime', async () => {
    const external = track('existing', { appManaged: false })
    let finishListing!: (tracks: DriveTrack[]) => void
    mocks.cache.getCachedSnapshot.mockResolvedValue({ tracks: [external], syncedAt: '2026-01-01' })
    mocks.drive.listTracks.mockImplementationOnce(() => new Promise((resolve) => { finishListing = resolve }))
    const connecting = useLibraryStore.getState().connect()
    await vi.waitFor(() => expect(mocks.drive.listTracks).toHaveBeenCalled())
    await useLibraryStore.getState().addTrack({ ...external, duration: 4800, metadataVersion: TRACK_METADATA_VERSION })
    finishListing([external])
    await connecting
    expect(useLibraryStore.getState()).toMatchObject({ status: 'ready', cacheSource: 'remote', busy: false })
    expect(useLibraryStore.getState().tracks[0]).toMatchObject({ duration: 4800, metadataVersion: TRACK_METADATA_VERSION, appManaged: false })
  })

  it('keeps missing managed and external audio as playlist markers', async () => {
    useLibraryStore.setState({ user, folder, tracks: [track('a'), track('gone'), track('external', { appManaged: false })] })
    mocks.drive.listTracks.mockResolvedValue([track('a')])
    await useLibraryStore.getState().sync()
    expect(useLibraryStore.getState().tracks.map((item) => [item.id, item.unavailable])).toEqual([['a', undefined], ['gone', true], ['external', true]])
    expect(mocks.cache.setCachedTracks.mock.calls[0][0]).toBe('account-a:root')
    expect(mocks.cache.setCachedTracks.mock.calls[0][2]).toBe(useLibraryStore.getState().lastSynced)
  })

  it('loads cache and playlist preferences partitioned by account and root', async () => {
    mocks.cache.getCachedSnapshot.mockResolvedValue({ tracks: [track('cache')], syncedAt: '2026-01-01' })
    await useLibraryStore.getState().connect()
    expect(mocks.cache.getCachedSnapshot).toHaveBeenCalledWith('account-a:root')
    expect(mocks.cache.getLocalPreference.mock.calls.map(([key]) => key)).toEqual(['user:account-a:playlists', 'user:account-a:recent'])
    expect(useLibraryStore.getState().cacheSource).toBe('remote')
  })

  it('shows cached external/legacy audio as read-only while the remote sync is unavailable', async () => {
    const cachedExternal = track('existing', { appManaged: false, canRename: true, canTrash: true })
    const cachedLegacy = track('legacy', { appManaged: undefined })
    const cachedOther = track('notes', { name: 'notes.txt', mimeType: 'text/plain', appManaged: false })
    mocks.cache.getCachedSnapshot.mockResolvedValue({ tracks: [cachedExternal, cachedLegacy, cachedOther], syncedAt: '2026-01-01' })
    mocks.drive.listTracks.mockRejectedValue(Object.assign(new Error('offline'), { retryable: true }))
    await useLibraryStore.getState().connect()
    const state = useLibraryStore.getState()
    expect(state.cacheSource).toBe('cache')
    expect(state.lastSynced).toBe('2026-01-01')
    expect(state.tracks.map((file) => [file.id, file.appManaged])).toEqual([['existing', false], ['legacy', false]])
    expect(selectVisibleTracks(state).map((file) => file.id)).toEqual(['existing', 'legacy'])
    expect(mocks.auth.requestAccessToken).not.toHaveBeenCalled()
    expect(mocks.drive.enableListenerReadOnly).not.toHaveBeenCalled()
  })

  it('includes existing remote songs without granting ownership or rewriting the app marker', async () => {
    const external = track('existing', { appManaged: false, canRename: true, canTrash: true })
    useLibraryStore.setState({ user, folder, tracks: [], playlists: [{ id: 'p', name: 'Mine', trackIds: ['existing'], createdAt: '' }], recentTrackIds: ['existing'] })
    mocks.drive.listTracks.mockResolvedValue([external, track('uploaded')])
    await useLibraryStore.getState().sync()
    const state = useLibraryStore.getState()
    expect(state.folder?.ownedByMe).toBe(false)
    expect(state.tracks.find((file) => file.id === 'existing')).toMatchObject({ appManaged: false })
    expect(selectVisibleTracks(state)).toHaveLength(2)
    expect(state.playlists[0].trackIds).toEqual(['existing'])
    expect(state.recentTrackIds).toEqual(['existing'])
    expect(mocks.drive.enableListenerReadOnly).not.toHaveBeenCalled()
  })

  it('uses the remote app marker instead of a stale managed cache flag', () => {
    const staleManaged = track('a', { appManaged: true, artist: 'Artist' })
    const snapshot = reconcileSnapshot([track('a', { appManaged: false })], [staleManaged])
    expect(snapshot[0]).toMatchObject({ appManaged: false, artist: 'Artist' })
  })

  it('restores an external song when it becomes available again and retains extracted metadata', () => {
    const missingExternal = track('a', { appManaged: false, unavailable: true, artist: 'Artist' })
    const snapshot = reconcileSnapshot([track('a', { appManaged: false })], [missingExternal])
    expect(snapshot[0]).toMatchObject({ appManaged: false, artist: 'Artist' })
    expect(snapshot[0].unavailable).toBeUndefined()
  })
})

describe('account isolation and logout races', () => {
  it('drops identity returned after logout', async () => {
    let resolveIdentity!: (value: unknown) => void
    mocks.auth.getDriveIdentity.mockReturnValue(new Promise((resolve) => { resolveIdentity = resolve }))
    const connection = useLibraryStore.getState().connect()
    useLibraryStore.getState().disconnect()
    resolveIdentity(user)
    await connection
    expect(useLibraryStore.getState()).toMatchObject({ status: 'signedOut', user: null, folder: null, tracks: [], busy: false })
    expect(mocks.cache.getLocalPreference).not.toHaveBeenCalled()
  })

  it('drops synchronization that resolves after logout and clears all account data', async () => {
    let resolveTracks!: (value: DriveTrack[]) => void
    mocks.drive.listTracks.mockReturnValue(new Promise((resolve) => { resolveTracks = resolve }))
    useLibraryStore.setState({ user, folder, tracks: [track('a')], playlists: [{ id: 'p', name: 'Private', trackIds: ['a'], createdAt: '' }], recentTrackIds: ['a'], query: 'secret', sort: 'size' })
    const sync = useLibraryStore.getState().sync()
    useLibraryStore.getState().disconnect()
    resolveTracks([track('late')])
    await sync
    expect(useLibraryStore.getState()).toMatchObject({ status: 'signedOut', tracks: [], playlists: [], recentTrackIds: [], user: null, query: '', sort: 'name', lastSynced: null, cacheSource: 'none' })
    expect(mocks.cache.setCachedTracks).not.toHaveBeenCalled()
  })

  it('starts a fresh token request synchronously when reconnect is clicked', async () => {
    let issueToken!: (value: typeof token) => void
    mocks.auth.requestAccessToken.mockReturnValue(new Promise((resolve) => { issueToken = resolve }))
    mocks.auth.getReconnectScopes.mockReturnValue(['drive.file', 'drive.readonly'])
    mocks.auth.getTokenState.mockReturnValue(undefined)
    useLibraryStore.setState({ user, folder, status: 'ready' })
    const reconnect = useLibraryStore.getState().reconnect()
    expect(mocks.auth.invalidateAccessToken).not.toHaveBeenCalled()
    expect(mocks.auth.requestAccessToken).toHaveBeenCalledWith({ scopes: ['drive.file', 'drive.readonly'], loginHint: user.emailAddress, prompt: '' })
    expect(mocks.auth.getDriveIdentity).not.toHaveBeenCalled()
    issueToken(token)
    await reconnect
    expect(useLibraryStore.getState().status).toBe('ready')
  })

  it('reuses a valid token on repeated connect and reconnect instead of opening Google', async () => {
    useLibraryStore.setState({ user, folder, status: 'ready' })
    await useLibraryStore.getState().connect()
    await useLibraryStore.getState().reconnect()
    expect(mocks.auth.requestAccessToken).not.toHaveBeenCalled()
    expect(mocks.auth.invalidateAccessToken).not.toHaveBeenCalled()
    expect(mocks.auth.signOut).not.toHaveBeenCalled()
    expect(useLibraryStore.getState().user).toEqual(user)
  })

  it('continues with a remembered account and scopes without trusting it as authenticated', async () => {
    const remembered = { ...user, scopes: ['drive.file', 'drive.readonly'] }
    mocks.remembered.getRememberedAccount.mockReturnValue(remembered)
    mocks.auth.getTokenState.mockReturnValue(undefined)
    mocks.auth.getDriveIdentity.mockRejectedValue(new Error('Identity could not be verified'))
    await useLibraryStore.getState().connect()
    expect(mocks.auth.requestAccessToken).toHaveBeenCalledWith({ scopes: remembered.scopes, prompt: '', loginHint: user.emailAddress })
    expect(useLibraryStore.getState()).toMatchObject({ status: 'error', user: null, folder: null, tracks: [] })
    expect(mocks.cache.getCachedSnapshot).not.toHaveBeenCalled()
    expect(mocks.remembered.rememberAccount).not.toHaveBeenCalled()
  })

  it('remembers only the verified identity with scopes from the live token', async () => {
    await useLibraryStore.getState().connect()
    expect(mocks.remembered.rememberAccount).toHaveBeenCalledWith(user, token.scopes)
  })

  it('starts explicit account switching synchronously and clears old account state first', async () => {
    useLibraryStore.setState({ user, folder, tracks: [track('private-a')], playlists: [{ id: 'p', name: 'A', trackIds: [], createdAt: '' }] })
    let issueToken!: (value: typeof token) => void
    mocks.auth.requestAccessToken.mockReturnValue(new Promise((resolve) => { issueToken = resolve }))
    mocks.auth.getDriveIdentity.mockResolvedValue({ permissionId: 'account-b', emailAddress: 'b@example.test' })
    const connection = useLibraryStore.getState().switchAccount()
    expect(mocks.auth.signOut).toHaveBeenCalledTimes(1)
    expect(mocks.auth.requestAccessToken).toHaveBeenCalledWith({ scopes: ['drive.file'], prompt: 'select_account' })
    expect(useLibraryStore.getState()).toMatchObject({ status: 'connecting', user: null, folder: null, tracks: [], playlists: [] })
    issueToken(token)
    await connection
    expect(useLibraryStore.getState().user?.permissionId).toBe('account-b')
    expect(mocks.cache.getCachedSnapshot).toHaveBeenCalledWith('account-b:root')
  })

  it('resets the old account session if a different account is chosen while reconnecting', async () => {
    useLibraryStore.setState({ user, folder, recentTrackIds: ['private-a'], playlists: [{ id: 'p', name: 'A', trackIds: [], createdAt: '' }] })
    mocks.auth.getDriveIdentity.mockResolvedValue({ permissionId: 'account-b', emailAddress: 'b@example.test' })
    const before = getSessionGeneration()
    await useLibraryStore.getState().connect()
    expect(getSessionGeneration()).toBeGreaterThan(before)
    expect(useLibraryStore.getState()).toMatchObject({ user: { permissionId: 'account-b' }, playlists: [], recentTrackIds: [] })
    expect(mocks.cache.getCachedSnapshot).toHaveBeenCalledWith('account-b:root')
  })

  it('does not carry cached existing songs into another account after reconnect', async () => {
    mocks.cache.getCachedSnapshot.mockImplementation(async (key: string) => ({
      tracks: [track(key === 'account-a:root' ? 'private-a' : 'private-b', { appManaged: false })], syncedAt: '2026-01-01',
    }))
    mocks.drive.listTracks.mockRejectedValue(Object.assign(new Error('offline'), { retryable: true }))
    await useLibraryStore.getState().connect()
    expect(useLibraryStore.getState().tracks.map((file) => file.id)).toEqual(['private-a'])
    mocks.auth.getDriveIdentity.mockResolvedValue({ permissionId: 'account-b', emailAddress: 'b@example.test' })
    await useLibraryStore.getState().connect()
    expect(useLibraryStore.getState().tracks.map((file) => file.id)).toEqual(['private-b'])
    expect(mocks.cache.getCachedSnapshot.mock.calls.map(([key]) => key)).toEqual(['account-a:root', 'account-b:root'])
    expect(useLibraryStore.getState().folder?.ownedByMe).toBe(false)
  })

  it('shows permission-capability errors and never sends an unauthorized file rename', async () => {
    const file = track('a')
    useLibraryStore.setState({ user, folder: { ...folder, ownedByMe: true }, tracks: [file] })
    mocks.drive.getFileMetadata.mockResolvedValue({ ...file, canRename: false })
    await expect(useLibraryStore.getState().rename(file, 'new.mp3')).rejects.toMatchObject({ reason: 'fileCapabilityDenied' })
    expect(useLibraryStore.getState().errorDetails?.reason).toBe('fileCapabilityDenied')
    expect(mocks.drive.renameTrack).not.toHaveBeenCalled()
  })

  it('does not mutate existing Drive music even for the folder owner with writable file capabilities', async () => {
    const external = track('existing', { appManaged: false, canRename: true, canTrash: true })
    useLibraryStore.setState({ user, folder: { ...folder, ownedByMe: true }, tracks: [external] })
    await expect(useLibraryStore.getState().rename(external, 'new.mp3')).rejects.toMatchObject({ reason: 'externalTrackReadOnly' })
    await expect(useLibraryStore.getState().removeTrack(external)).rejects.toMatchObject({ reason: 'externalTrackReadOnly' })
    expect(mocks.drive.getFileMetadata).not.toHaveBeenCalled()
    expect(mocks.drive.renameTrack).not.toHaveBeenCalled()
    expect(mocks.drive.trashTrack).not.toHaveBeenCalled()
    expect(useLibraryStore.getState().tracks[0]).toEqual(external)
  })

  it('does not give a listening account admin rights because a song is app-managed', async () => {
    const managed = track('managed', { appManaged: true, canRename: true, canTrash: true })
    useLibraryStore.setState({ user, folder, tracks: [managed] })
    await expect(useLibraryStore.getState().rename(managed, 'new.mp3')).rejects.toThrow('Tài khoản hiện tại')
    await expect(useLibraryStore.getState().removeTrack(managed)).rejects.toThrow('Tài khoản hiện tại')
    expect(mocks.drive.getFileMetadata).not.toHaveBeenCalled()
    expect(mocks.drive.renameTrack).not.toHaveBeenCalled()
    expect(mocks.drive.trashTrack).not.toHaveBeenCalled()
    expect(useLibraryStore.getState().folder?.ownedByMe).toBe(false)
  })

  it.each(['accessNotConfigured', 'serviceDisabled'])('does not offer broader Drive scope for API setup error %s', async (reason) => {
    mocks.auth.getDriveIdentity.mockRejectedValue(Object.assign(new Error('Google Drive API chưa được bật cho Google Cloud project này.'), {
      status: 403, reason, retryable: false,
    }))
    await useLibraryStore.getState().connect()
    expect(useLibraryStore.getState()).toMatchObject({ status: 'error', permissionHelp: false, errorDetails: { status: 403, reason } })
    expect(mocks.auth.invalidateAccessToken).not.toHaveBeenCalled()
    expect(mocks.drive.getLibraryContext).not.toHaveBeenCalled()
  })
})
