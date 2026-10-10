import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ driveJSON: vi.fn(), getTokenState: vi.fn() }))
vi.mock('./auth', () => ({
  DRIVE_FILE_SCOPE: 'drive.file', DRIVE_READONLY_SCOPE: 'drive.readonly',
  driveJSON: mocks.driveJSON, getTokenState: mocks.getTokenState, requestAccessToken: vi.fn(),
}))

import { getConfiguredFolderId, getFileMetadata, getLibraryContext, inviteListener, listMembers, listTracks, removeListener, renameTrack, trashTrack } from './drive'
import { invalidateSession } from './session'

const track = (id: string, properties: Record<string, string> = { cbmSoundTrack: '1' }) => ({ id, name: `${id}.mp3`, mimeType: 'audio/mpeg', size: '10', properties, capabilities: { canRename: true, canTrash: false } })

beforeEach(() => {
  mocks.driveJSON.mockReset()
  mocks.getTokenState.mockReset().mockReturnValue({ scopes: ['drive.file'] })
})

describe('Drive listing and application authorization', () => {
  it('gets every page and includes existing audio without adopting its metadata', async () => {
    mocks.driveJSON.mockResolvedValueOnce({ files: [track('a'), track('external', {}), { ...track('trashed'), trashed: true }], nextPageToken: 'next' })
      .mockResolvedValueOnce({ files: [track('b')] })
    const result = await listTracks('root')
    expect(result.map((file) => file.id)).toEqual(['a', 'external', 'b'])
    expect(result[0]).toMatchObject({ appManaged: true, canRename: true, canTrash: false })
    expect(result[1]).toMatchObject({ appManaged: false, canRename: true, canTrash: false })
    const firstURL = new URL(mocks.driveJSON.mock.calls[0][0])
    expect(firstURL.searchParams.get('q')).toBe("'root' in parents and trashed = false")
    expect(new URL(mocks.driveJSON.mock.calls[1][0]).searchParams.get('pageToken')).toBe('next')
    expect(mocks.driveJSON.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it('excludes nonaudio, Drive-native documents and folders even with audio extensions or app markers', async () => {
    mocks.driveJSON.mockResolvedValue({ files: [
      track('audio'),
      { ...track('pdf'), name: 'notes.pdf', mimeType: 'application/pdf' },
      { ...track('doc'), name: 'transcript.mp3', mimeType: 'application/vnd.google-apps.document' },
      { ...track('folder'), name: 'album.mp3', mimeType: 'application/vnd.google-apps.folder' },
      { ...track('shortcut'), name: 'song.mp3', mimeType: 'application/vnd.google-apps.shortcut' },
      { ...track('image', {}), name: 'cover.png', mimeType: 'image/png' },
    ] })
    await expect(listTracks('root')).resolves.toEqual([expect.objectContaining({ id: 'audio' })])
  })

  it('recognizes advertised audio extensions with generic or absent MIME without requiring a marker', async () => {
    mocks.driveJSON.mockResolvedValue({ files: [
      { ...track('mp3', {}), name: 'Song.MP3', mimeType: 'application/octet-stream' },
      { ...track('m4a', {}), name: 'Song.m4a', mimeType: undefined },
      { ...track('flac', {}), name: 'Song.FLAC', mimeType: 'application/octet-stream' },
      { ...track('aac', {}), name: 'Song.aac', mimeType: 'application/octet-stream' },
      { ...track('wav', {}), name: 'Song.wav', mimeType: 'application/octet-stream' },
      { ...track('ogg', {}), name: 'Song.ogg', mimeType: 'application/octet-stream' },
      { ...track('binary', {}), name: 'unrelated.bin', mimeType: 'application/octet-stream' },
      { ...track('codec', {}), name: 'audio.bin', mimeType: 'audio/opus' },
    ] })
    const result = await listTracks('root')
    expect(result.map((file) => file.id)).toEqual(['mp3', 'm4a', 'flac', 'aac', 'wav', 'ogg', 'codec'])
    expect(result.every((file) => file.appManaged === false)).toBe(true)
  })

  it('rejects a partial search rather than treating unseen files as deleted', async () => {
    mocks.driveJSON.mockResolvedValue({ files: [track('a')], incompleteSearch: true })
    await expect(listTracks('root')).rejects.toMatchObject({ reason: 'incompleteSearch' })
  })

  it('does not return a successful snapshot when a later page fails', async () => {
    mocks.driveJSON.mockResolvedValueOnce({ files: [track('existing', {})], nextPageToken: 'next' })
      .mockRejectedValueOnce(Object.assign(new Error('Mất kết nối'), { status: 503 }))
    await expect(listTracks('root')).rejects.toMatchObject({ status: 503 })
    expect(mocks.driveJSON).toHaveBeenCalledTimes(2)
  })

  it('does not fetch another page under a new session after logout', async () => {
    mocks.driveJSON.mockImplementationOnce(async () => {
      invalidateSession()
      return { files: [track('a')], nextPageToken: 'next' }
    })
    await expect(listTracks('root')).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.driveJSON).toHaveBeenCalledTimes(1)
  })

  it('reports Picker authorization separately from folder ownership', async () => {
    mocks.driveJSON.mockResolvedValue({ id: 'root', name: 'Library', mimeType: 'application/vnd.google-apps.folder', ownedByMe: true, isAppAuthorized: false })
    await expect(getLibraryContext('root')).rejects.toMatchObject({ status: 403, reason: 'appNotAuthorizedToFile' })
    mocks.getTokenState.mockReturnValue({ scopes: ['drive.readonly'] })
    await expect(getLibraryContext('root')).resolves.toMatchObject({ ownedByMe: true, isAppAuthorized: false })
  })

  it('shows public/domain permissions instead of hiding a nonprivate library', async () => {
    mocks.driveJSON.mockResolvedValue({ permissions: [
      { id: 'public', type: 'anyone', role: 'reader' },
      { id: 'domain', type: 'domain', domain: 'example.test', role: 'reader' },
      { id: 'deleted', type: 'user', deleted: true },
    ] })
    const result = await listMembers('root')
    expect(result.map((member) => member.id)).toEqual(['public', 'domain'])
    expect(result[0].name).toContain('Bất kỳ ai')
    expect(result[1].name).toContain('example.test')
  })

  it('refuses management of a song that was moved outside the configured root', async () => {
    mocks.driveJSON.mockResolvedValue({ ...track('a'), parents: ['another-folder'] })
    await expect(getFileMetadata('a', 'root')).rejects.toMatchObject({ reason: 'fileOutsideLibrary' })
  })
})

describe('Drive file management boundary', () => {
  it.each(['rename', 'trash'])('forbids %s of external audio even when Drive reports write capabilities', async (action) => {
    const root = await getConfiguredFolderId()
    mocks.driveJSON.mockResolvedValue({ ...track('external', {}), parents: [root], capabilities: { canRename: true, canTrash: true } })
    const mutation = action === 'rename' ? renameTrack('external', 'changed.mp3') : trashTrack('external')
    await expect(mutation).rejects.toMatchObject({ reason: 'externalFileReadOnly', status: 403 })
    expect(mocks.driveJSON).toHaveBeenCalledTimes(1)
    expect(mocks.driveJSON.mock.calls[0][1]).toBeUndefined()
  })

  it.each(['rename', 'trash'])('forbids %s of managed audio moved outside the configured root', async (action) => {
    mocks.driveJSON.mockResolvedValue({ ...track('moved'), parents: ['another-folder'], capabilities: { canRename: true, canTrash: true } })
    const mutation = action === 'rename' ? renameTrack('moved', 'changed.mp3') : trashTrack('moved')
    await expect(mutation).rejects.toMatchObject({ reason: 'fileOutsideLibrary', status: 403 })
    expect(mocks.driveJSON).toHaveBeenCalledTimes(1)
  })

  it.each(['rename', 'trash'])('forbids %s when Google denies the matching capability', async (action) => {
    const root = await getConfiguredFolderId()
    mocks.driveJSON.mockResolvedValue({ ...track('managed'), parents: [root], capabilities: { canRename: false, canTrash: false } })
    const mutation = action === 'rename' ? renameTrack('managed', 'changed.mp3') : trashTrack('managed')
    await expect(mutation).rejects.toMatchObject({ reason: 'fileCapabilityDenied', status: 403 })
    expect(mocks.driveJSON).toHaveBeenCalledTimes(1)
  })

  it.each(['rename', 'trash'])('allows %s only for managed audio in the configured root with permission', async (action) => {
    const root = await getConfiguredFolderId()
    mocks.driveJSON.mockResolvedValueOnce({ ...track('managed'), parents: [root], capabilities: { canRename: true, canTrash: true } })
      .mockResolvedValueOnce({ id: 'managed' })
    await (action === 'rename' ? renameTrack('managed', 'changed.mp3') : trashTrack('managed'))
    expect(mocks.driveJSON).toHaveBeenCalledTimes(2)
    expect(mocks.driveJSON.mock.calls[1][1]).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse(mocks.driveJSON.mock.calls[1][1].body)).toEqual(action === 'rename' ? { name: 'changed.mp3' } : { trashed: true })
  })
})

describe('Drive member changes', () => {
  it('serializes invitations and verifies the role Google returned', async () => {
    let resolveCreate!: (data: unknown) => void
    const firstCreate = new Promise((resolve) => { resolveCreate = resolve })
    mocks.driveJSON
      .mockReturnValueOnce(firstCreate)
      .mockResolvedValueOnce({ permissions: [{ id: 'a', type: 'user', role: 'reader' }] })
      .mockResolvedValueOnce({ id: 'b' })
      .mockResolvedValueOnce({ permissions: [{ id: 'b', type: 'user', role: 'reader' }] })
    const first = inviteListener('root', 'a@example.test')
    const second = inviteListener('root', 'b@example.test')
    await vi.waitFor(() => expect(mocks.driveJSON).toHaveBeenCalledTimes(1))
    resolveCreate({ id: 'a' })
    await Promise.all([first, second])
    expect(mocks.driveJSON.mock.calls.map(([, init]) => init?.method || 'GET')).toEqual(['POST', 'GET', 'POST', 'GET'])
    expect(JSON.parse(mocks.driveJSON.mock.calls[0][1].body)).toMatchObject({ type: 'user', role: 'reader' })
  })

  it('refuses to claim revocation when the folder permission still exists', async () => {
    const permission = { id: 'member', emailAddress: 'listener@example.test', type: 'user', role: 'reader' }
    mocks.driveJSON.mockResolvedValueOnce({ permissions: [permission] }).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ permissions: [permission] })
    await expect(removeListener('root', 'member')).rejects.toMatchObject({ reason: 'permissionNotConfirmed' })
  })

  it('reports a surviving direct file permission and anyone sharing after folder revocation', async () => {
    const permission = { id: 'member', emailAddress: 'listener@example.test', type: 'user', role: 'reader' }
    mocks.driveJSON
      .mockResolvedValueOnce({ permissions: [permission] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ permissions: [] })
      .mockResolvedValueOnce({ files: [track('a')] })
      .mockResolvedValueOnce({ permissions: [permission, { id: 'public', type: 'anyone', role: 'reader' }] })
    await expect(removeListener('root', 'member')).resolves.toMatchObject({ remainingFiles: [{ id: 'a' }], broadlySharedFiles: [{ id: 'a' }], uncheckedFiles: [] })
  })

  it('reports remaining external-file access without deleting any file permission', async () => {
    const permission = { id: 'member', emailAddress: 'listener@example.test', type: 'user', role: 'reader' }
    mocks.driveJSON
      .mockResolvedValueOnce({ permissions: [permission] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ permissions: [] })
      .mockResolvedValueOnce({ files: [track('external', {})] })
      .mockResolvedValueOnce({ permissions: [permission] })
    const result = await removeListener('root', 'member')
    expect(result.remainingFiles).toEqual([{ id: 'external', name: 'external.mp3' }])
    expect(result.scanError).toContain('drive.file')
    const deletions = mocks.driveJSON.mock.calls.filter(([, init]) => init?.method === 'DELETE')
    expect(deletions).toHaveLength(1)
    expect(deletions[0][0]).toContain('/files/root/permissions/member')
  })

  it('marks external audio as unchecked when its permissions cannot be read', async () => {
    mocks.getTokenState.mockReturnValue({ scopes: ['drive.file', 'drive.readonly'] })
    const permission = { id: 'member', emailAddress: 'listener@example.test', type: 'user', role: 'reader' }
    mocks.driveJSON
      .mockResolvedValueOnce({ permissions: [permission] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ permissions: [] })
      .mockResolvedValueOnce({ files: [track('external', {})] })
      .mockRejectedValueOnce(Object.assign(new Error('Thiếu quyền'), { status: 403 }))
    const result = await removeListener('root', 'member')
    expect(result.uncheckedFiles).toEqual([{ id: 'external', name: 'external.mp3' }])
    expect(result.scanError).toBeUndefined()
  })

  it('does not issue DELETE for an inherited or owner permission', async () => {
    await expect(removeListener('root', 'member', true)).rejects.toThrow('thừa kế')
    expect(mocks.driveJSON).not.toHaveBeenCalled()
    mocks.driveJSON.mockResolvedValueOnce({ permissions: [{ id: 'owner', role: 'owner' }] })
    await expect(removeListener('root', 'owner')).rejects.toThrow('chủ sở hữu')
    expect(mocks.driveJSON).toHaveBeenCalledTimes(1)
  })
})
