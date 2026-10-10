import type { DriveAbout, DriveTrack, LibraryMember } from '../types'
import { appError, isSupportedAudio } from '../types'
import { DRIVE_FILE_SCOPE, DRIVE_READONLY_SCOPE, driveJSON, getTokenState, requestAccessToken } from './auth'
import { assertSessionCurrent, getSessionGeneration } from './session'

const API = 'https://www.googleapis.com/drive/v3'
// The shared CBM Sound library folder. This ID is public configuration, not a credential.
const DEFAULT_LIBRARY_FOLDER_ID = '1_GEZPONNMBfSzvVs2tFHDiCp40fNjREB'
const FALLBACK_SCOPE_ENABLED = import.meta.env.VITE_ALLOW_LISTENER_READONLY_FALLBACK === 'true'

export function isReadOnlyFallbackEnabled(): boolean { return FALLBACK_SCOPE_ENABLED }

interface DriveFileResponse {
  id: string
  name: string
  mimeType?: string
  size?: string
  createdTime?: string
  modifiedTime?: string
  trashed?: boolean
  ownedByMe?: boolean
  capabilities?: Record<string, boolean>
  appProperties?: Record<string, string>
  properties?: Record<string, string>
  isAppAuthorized?: boolean
  parents?: string[]
}

interface DriveListResponse {
  files?: DriveFileResponse[]
  nextPageToken?: string
}

interface DrivePermissionResponse {
  permissions?: Array<{
    id: string
    emailAddress?: string
    displayName?: string
    role?: string
    type?: string
    domain?: string
    deleted?: boolean
    permissionDetails?: Array<{ inherited?: boolean }>
  }>
  nextPageToken?: string
}

export interface LibraryContext {
  folderId: string
  ownedByMe: boolean
  canAddChildren: boolean
  canRename: boolean
  canDeleteChildren: boolean
  canShare: boolean
  name: string
  isAppAuthorized: boolean
}

export interface RemovalAudit {
  remainingFiles: Array<{ id: string; name: string }>
  broadlySharedFiles: Array<{ id: string; name: string }>
  uncheckedFiles: Array<{ id: string; name: string }>
  scanError?: string
}

const TRACK_FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,trashed,properties,parents,capabilities(canRename,canTrash)'

function queryEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function normalize(file: DriveFileResponse): DriveTrack {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType || 'application/octet-stream',
    size: Number(file.size || 0),
    createdTime: file.createdTime || '',
    modifiedTime: file.modifiedTime || '',
    appManaged: file.properties?.cbmSoundTrack === '1',
    canRename: Boolean(file.capabilities?.canRename),
    canTrash: Boolean(file.capabilities?.canTrash),
  }
}

export async function getConfiguredFolderId(): Promise<string | undefined> {
  return (import.meta.env.VITE_DRIVE_FOLDER_ID as string | undefined)?.trim() || DEFAULT_LIBRARY_FOLDER_ID
}

export async function setConfiguredFolderId(id: string): Promise<void> {
  if (id.trim() !== await getConfiguredFolderId()) throw appError('Website này sử dụng một thư viện chung cố định.', {
    recovery: 'Chủ website cần cập nhật VITE_DRIVE_FOLDER_ID và build lại để thay thư mục gốc cho mọi thành viên.',
  })
}

export async function createLibraryFolder(): Promise<LibraryContext> {
  throw appError('Thư mục gốc đã được cấu hình; không tạo thư viện thay thế.', {
    recovery: 'Cấp quyền cho thư mục gốc bằng Google Picker hoặc xác nhận quyền chia sẻ của tài khoản.',
  })
}

function contextFrom(file: DriveFileResponse): LibraryContext {
  return {
    folderId: file.id,
    name: file.name,
    ownedByMe: Boolean(file.ownedByMe),
    canAddChildren: Boolean(file.capabilities?.canAddChildren),
    canRename: Boolean(file.capabilities?.canRename),
    canDeleteChildren: Boolean(file.capabilities?.canDeleteChildren),
    canShare: Boolean(file.capabilities?.canShare),
    isAppAuthorized: Boolean(file.isAppAuthorized),
  }
}

export async function getLibraryContext(folderId: string): Promise<LibraryContext> {
  const file = await driveJSON<DriveFileResponse>(`${API}/files/${encodeURIComponent(folderId)}?fields=id,name,ownedByMe,capabilities,mimeType,trashed,isAppAuthorized&supportsAllDrives=true`)
  if (file.trashed || file.mimeType !== 'application/vnd.google-apps.folder') {
    throw appError('Mã thư viện không trỏ tới một thư mục đang hoạt động.', { recovery: 'Kiểm tra lại VITE_DRIVE_FOLDER_ID.' })
  }
  if (file.isAppAuthorized === false && !getTokenState()?.scopes.includes(DRIVE_READONLY_SCOPE)) {
    throw appError('CBM Sound chưa được cấp quyền mở thư mục gốc này.', {
      status: 403, reason: 'appNotAuthorizedToFile', recovery: 'Bấm Cấp quyền thư mục bằng Google Picker và chọn đúng thư mục thư viện đã cấu hình.',
    })
  }
  return contextFrom(file)
}

export async function listTracks(folderId: string): Promise<DriveTrack[]> {
  const generation = getSessionGeneration()
  // Existing audio is available for listening without adopting it into app
  // management. OAuth may still limit which files Google returns to drive.file.
  const q = `'${queryEscape(folderId)}' in parents and trashed = false`
  const fields = `nextPageToken,incompleteSearch,files(${TRACK_FIELDS})`
  const tracks: DriveTrack[] = []
  let pageToken: string | undefined
  const seenTokens = new Set<string>()
  do {
    assertSessionCurrent(generation)
    const params = new URLSearchParams({ q, pageSize: '1000', fields, orderBy: 'name_natural' })
    if (pageToken) params.set('pageToken', pageToken)
    const result = await driveJSON<DriveListResponse & { incompleteSearch?: boolean }>(`${API}/files?${params}`)
    assertSessionCurrent(generation)
    if (result.incompleteSearch) throw appError('Google Drive trả về danh sách chưa đầy đủ; snapshot cũ được giữ lại.', { retryable: true, reason: 'incompleteSearch' })
    for (const file of result.files || []) {
      if (file.trashed || file.mimeType?.startsWith('application/vnd.google-apps.')) continue
      const track = normalize(file)
      if (isSupportedAudio(track)) tracks.push(track)
    }
    pageToken = result.nextPageToken
    if (pageToken && seenTokens.has(pageToken)) throw appError('Google Drive trả về phân trang lặp lại; chưa thay snapshot.', { retryable: true, reason: 'invalidPagination' })
    if (pageToken) seenTokens.add(pageToken)
  } while (pageToken)
  return tracks
}

export async function renameTrack(fileId: string, name: string): Promise<void> {
  await assertManagedFileCapability(fileId, 'canRename')
  await driveJSON(`${API}/files/${encodeURIComponent(fileId)}?fields=id,name`, {
    method: 'PATCH', body: JSON.stringify({ name }),
  })
}

export async function trashTrack(fileId: string): Promise<void> {
  await assertManagedFileCapability(fileId, 'canTrash')
  await driveJSON(`${API}/files/${encodeURIComponent(fileId)}`, { method: 'PATCH', body: JSON.stringify({ trashed: true }) })
}

async function assertManagedFileCapability(fileId: string, capability: 'canRename' | 'canTrash'): Promise<void> {
  const generation = getSessionGeneration()
  const metadata = await getFileMetadata(fileId, await getConfiguredFolderId())
  assertSessionCurrent(generation)
  if (!metadata.appManaged) throw appError('Nhạc có sẵn chỉ được dùng để nghe; ứng dụng không quản lý file này.', {
    status: 403, reason: 'externalFileReadOnly', recovery: 'Đổi tên hoặc quản lý file này trực tiếp trong Google Drive.',
  })
  if (!metadata[capability]) throw appError('Google Drive chưa cấp quyền quản lý bài nhạc này.', {
    status: 403, reason: 'fileCapabilityDenied',
  })
}

export async function getFileMetadata(fileId: string, requiredFolderId?: string): Promise<DriveTrack> {
  const file = await driveJSON<DriveFileResponse>(`${API}/files/${encodeURIComponent(fileId)}?fields=${TRACK_FIELDS}&supportsAllDrives=true`)
  if (file.trashed) throw appError('Bài nhạc này đã bị chuyển vào thùng rác.', { status: 404 })
  if (requiredFolderId && !file.parents?.includes(requiredFolderId)) throw appError('File đã được chuyển ra ngoài thư mục gốc; ứng dụng không quản lý file này nữa.', {
    status: 403, reason: 'fileOutsideLibrary', recovery: 'Đồng bộ lại thư viện để giữ dấu bài thiếu trong playlist.',
  })
  return normalize(file)
}

export async function generateDriveFileId(): Promise<string> {
  const params = new URLSearchParams({ count: '1', space: 'drive', fields: 'ids' })
  const result = await driveJSON<{ ids?: string[] }>(`${API}/files/generateIds?${params}`)
  if (!result.ids?.[0]) throw appError('Google Drive chưa cấp được ID cho file upload.', { retryable: true })
  return result.ids[0]
}

export async function listMembers(folderId: string): Promise<LibraryMember[]> {
  const generation = getSessionGeneration()
  const members: LibraryMember[] = []
  let pageToken: string | undefined
  const seenTokens = new Set<string>()
  do {
    assertSessionCurrent(generation)
    const params = new URLSearchParams({
      pageSize: '100',
      fields: 'nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,deleted,permissionDetails(inherited))',
      supportsAllDrives: 'true',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const result = await driveJSON<DrivePermissionResponse>(`${API}/files/${encodeURIComponent(folderId)}/permissions?${params}`)
    assertSessionCurrent(generation)
    for (const permission of result.permissions || []) {
      if (permission.deleted) continue
      members.push({
        id: permission.id,
        email: permission.emailAddress,
        name: permission.displayName || (permission.type === 'anyone' ? 'Bất kỳ ai có đường liên kết' : permission.domain ? `Tên miền ${permission.domain}` : undefined),
        role: permission.role || 'reader',
        type: permission.type || 'user',
        isOwner: permission.role === 'owner',
        inherited: permission.permissionDetails?.some((detail) => detail.inherited),
      })
    }
    pageToken = result.nextPageToken
    if (pageToken && seenTokens.has(pageToken)) throw appError('Google Drive trả về phân trang quyền lặp lại.', { retryable: true, reason: 'invalidPagination' })
    if (pageToken) seenTokens.add(pageToken)
  } while (pageToken)
  return members
}

export async function inviteListener(folderId: string, email: string): Promise<void> {
  await sequentialPermissionChange(async (generation) => {
    const clean = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw appError('Nhập địa chỉ email Google hợp lệ.')
    const params = new URLSearchParams({ sendNotificationEmail: 'false', fields: 'id,type,role,emailAddress' })
    const created = await driveJSON<{ id: string }>(`${API}/files/${encodeURIComponent(folderId)}/permissions?${params}`, {
      method: 'POST',
      body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: clean }),
    })
    assertSessionCurrent(generation)
    const members = await listMembers(folderId)
    if (!members.some((member) => member.id === created.id && member.role === 'reader')) {
      throw appError('Google chưa xác nhận quyền chỉ nghe của thành viên.', { reason: 'permissionNotConfirmed', recovery: 'Đồng bộ danh sách thành viên trước khi mời lại để tránh thao tác trùng.' })
    }
  })
}

let permissionChanges: Promise<unknown> = Promise.resolve()

function sequentialPermissionChange<T>(action: (generation: number) => Promise<T>): Promise<T> {
  const generation = getSessionGeneration()
  const running = permissionChanges.catch(() => undefined).then(() => {
    assertSessionCurrent(generation)
    return action(generation)
  })
  permissionChanges = running
  return running
}

export async function removeListener(folderId: string, permissionId: string, inherited?: boolean): Promise<RemovalAudit> {
  return sequentialPermissionChange(async (generation) => {
    if (inherited) throw appError('Quyền này được thừa kế từ thư mục cha và không thể gỡ trực tiếp tại đây.')
    const before = await listMembers(folderId)
    assertSessionCurrent(generation)
    const removed = before.find((member) => member.id === permissionId)
    if (!removed) throw appError('Quyền này không còn tồn tại; hãy tải lại danh sách thành viên.')
    if (removed.isOwner) throw appError('Ứng dụng không thể thu hồi quyền chủ sở hữu.')
    await driveJSON(`${API}/files/${encodeURIComponent(folderId)}/permissions/${encodeURIComponent(permissionId)}`, { method: 'DELETE' })
    assertSessionCurrent(generation)
    if ((await listMembers(folderId)).some((member) => member.id === permissionId)) {
      throw appError('Google chưa xác nhận quyền thư mục đã bị thu hồi.', { reason: 'permissionNotConfirmed', recovery: 'Đồng bộ danh sách thành viên và kiểm tra chia sẻ trong Google Drive.' })
    }
    const audit: RemovalAudit = { remainingFiles: [], broadlySharedFiles: [], uncheckedFiles: [] }
    if (!getTokenState()?.scopes.includes(DRIVE_READONLY_SCOPE)) {
      audit.scanError = 'Quyền drive.file chỉ cho phép kiểm tra các file ứng dụng truy cập được. Chưa thể xác nhận quyền còn lại trên mọi file nhạc có sẵn; hãy kiểm tra chia sẻ trong Google Drive.'
    }
    let tracks: DriveTrack[]
    try { tracks = await listTracks(folderId) }
    catch (error) {
      if ((error as Error).name === 'AbortError') throw error
      return { ...audit, scanError: error instanceof Error ? error.message : 'Không đọc được danh sách nhạc để kiểm tra quyền còn lại.' }
    }
    for (const track of tracks) {
      assertSessionCurrent(generation)
      try {
        const permissions = await listMembers(track.id)
        // On My Drive inherited details can be absent. A surviving permission is
        // still a remaining access path; do not falsely promise full revocation.
        if (permissions.some((member) => member.id === permissionId || removed.email && member.email?.toLowerCase() === removed.email.toLowerCase())) {
          audit.remainingFiles.push({ id: track.id, name: track.name })
        }
        if (permissions.some((member) => member.type === 'anyone' || member.type === 'domain' || member.type === 'group')) audit.broadlySharedFiles.push({ id: track.id, name: track.name })
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError' || (error as { status?: number }).status === 401) throw error
        audit.uncheckedFiles.push({ id: track.id, name: track.name })
      }
    }
    return audit
  })
}

export async function enableListenerReadOnly(identity?: DriveAbout['user']): Promise<void> {
  if (!FALLBACK_SCOPE_ENABLED) throw appError('Quyền đọc bổ sung đang tắt.', {
    recovery: 'Chủ thư viện cần bật VITE_ALLOW_LISTENER_READONLY_FALLBACK rồi build lại. Quyền này bao phủ toàn bộ Google Drive của bạn.',
  })
  await requestAccessToken({
    scopes: [DRIVE_FILE_SCOPE, DRIVE_READONLY_SCOPE],
    loginHint: identity?.emailAddress,
    prompt: '',
  })
}
