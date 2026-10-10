export interface DriveTrack {
  id: string
  name: string
  mimeType: string
  size: number
  createdTime: string
  modifiedTime: string
  artist?: string
  album?: string
  duration?: number
  artwork?: string
  unavailable?: boolean
  appManaged?: boolean
  metadataChecked?: boolean
  canRename?: boolean
  canTrash?: boolean
}

export interface UploadResumeState {
  fileId: string
  sessionUrl?: string
  offset: number
  driveName?: string
}

export interface UploadJob {
  id: string
  file: File
  state: 'queued' | 'uploading' | 'retrying' | 'paused' | 'needsAuth' | 'skipped' | 'done' | 'error' | 'cancelled'
  sentBytes: number
  confirmedBytes: number
  totalBytes: number
  error?: AppError
  result?: DriveTrack
  resume?: UploadResumeState
}

export interface LibraryMember {
  id: string
  email?: string
  name?: string
  role: string
  type: string
  isOwner: boolean
  inherited?: boolean
}

export interface PlayerState {
  currentTrack: DriveTrack | null
  queue: DriveTrack[]
  history: string[]
  isPlaying: boolean
  duration: number
  currentTime: number
  volume: number
  isMuted: boolean
  repeat: 'off' | 'one' | 'all'
  shuffle: boolean
  error: string | null
}

export interface AppError extends Error {
  status?: number
  reason?: string
  retryable: boolean
  recovery?: string
  retryAfterMs?: number
}

export interface DriveAbout {
  user?: {
    permissionId?: string
    displayName?: string
    emailAddress?: string
    photoLink?: string
  }
}

export function appError(
  message: string,
  options: Partial<Pick<AppError, 'status' | 'reason' | 'retryable' | 'recovery' | 'retryAfterMs'>> = {},
): AppError {
  return Object.assign(new Error(message), { retryable: false, ...options })
}

export function isAudioFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type.startsWith('audio/') || /\.(mp3|wav|flac|aac|m4a|ogg|opus|aiff|alac)$/i.test(file.name)
}

export function isSupportedAudio(track: Pick<DriveTrack, 'mimeType' | 'name'>): boolean {
  return isAudioFile({ type: track.mimeType, name: track.name })
}
