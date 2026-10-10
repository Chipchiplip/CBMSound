import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App } from './App'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { appError, type DriveTrack } from '../types'

const authMock = vi.hoisted(() => ({ getTokenState: vi.fn() }))
const driveMock = vi.hoisted(() => ({ isReadOnlyFallbackEnabled: vi.fn() }))
vi.mock('../services/auth', async (original) => ({
  ...await original<typeof import('../services/auth')>(),
  hasGoogleClient: () => false,
  getTokenState: authMock.getTokenState,
}))
vi.mock('../services/drive', async (original) => ({
  ...await original<typeof import('../services/drive')>(),
  isReadOnlyFallbackEnabled: driveMock.isReadOnlyFallbackEnabled,
}))

const track = (id: string, name: string, unavailable = false): DriveTrack => ({
  id, name, unavailable, appManaged: true, mimeType: 'audio/mpeg', size: 1024,
  createdTime: '2026-10-10T00:00:00Z', modifiedTime: '2026-10-10T00:00:00Z',
})

beforeEach(() => {
  authMock.getTokenState.mockReturnValue(undefined)
  driveMock.isReadOnlyFallbackEnabled.mockReturnValue(true)
  location.hash = '#/library'
  useLibraryStore.setState({
    ...useLibraryStore.getInitialState(), status: 'ready', page: 'library',
    tracks: [track('a', 'Alpha.mp3'), track('b', 'Beta.mp3'), track('missing', 'Removed.mp3', true)],
    user: { permissionId: 'test-user', emailAddress: 'test@example.com' },
    folder: { folderId: 'test-root', name: 'Test library', ownedByMe: false, canAddChildren: false, canShare: false, canRename: false, canDeleteChildren: false, isAppAuthorized: true },
    cacheSource: 'remote', lastSynced: '2026-10-10T00:00:00Z',
  })
  usePlayerStore.setState({ ...usePlayerStore.getInitialState() })
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('library UI regressions', () => {
  it('renders and updates a filtered library without a Zustand snapshot render loop', () => {
    render(<App />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Removed')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Tìm bài hát'), { target: { value: 'Beta' } })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('focuses search with Ctrl K and actually changes sort direction', () => {
    render(<App />)
    vi.useFakeTimers()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    act(() => { vi.runOnlyPendingTimers() })
    expect(screen.getByLabelText('Tìm bài hát')).toHaveFocus()
    vi.useRealTimers()
    fireEvent.click(screen.getByLabelText('Đổi sang giảm dần'))
    expect(useLibraryStore.getState().ascending).toBe(false)
    expect(screen.getByLabelText('Đổi sang tăng dần')).toBeInTheDocument()
  })

  it('keeps missing playlist entries visible and does not offer playback for them', () => {
    location.hash = '#/playlists'
    useLibraryStore.setState({ page: 'playlists', playlists: [{ id: 'p', name: 'My list', trackIds: ['a', 'missing', 'unknown'], createdAt: '' }] })
    render(<App />)
    expect(screen.getByText('1 bài khả dụng · 2 bài thiếu')).toBeInTheDocument()
    for (const button of screen.getAllByText('Bài không còn khả dụng')) expect(button).toBeDisabled()
  })

  it('subscribes to queue changes while the queue is open', () => {
    render(<App />)
    fireEvent.click(screen.getByLabelText('Mở hàng đợi'))
    expect(screen.getByText('Hàng đợi đang trống.')).toBeInTheDocument()
    act(() => { usePlayerStore.setState({ queue: [track('new', 'New song.mp3')] }) })
    expect(screen.getByText('New song')).toBeInTheDocument()
    expect(screen.queryByText('Hàng đợi đang trống.')).not.toBeInTheDocument()
  })

  it('asks an owner to authorize the folder before exposing upload controls', () => {
    location.hash = '#/upload'
    useLibraryStore.setState({ page: 'upload', folder: { ...useLibraryStore.getState().folder!, ownedByMe: true, canAddChildren: true, isAppAuthorized: false } })
    render(<App />)
    expect(screen.getByText('Cấp quyền quản lý thư mục cho ứng dụng.')).toBeInTheDocument()
    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(screen.getByText('Chọn thư mục gốc trên Google Drive')).toBeInTheDocument()
    expect(screen.getByText(/Hộp này chỉ chọn thư mục nên không hiển thị nhạc/)).toBeInTheDocument()
  })

  it('does not present folder authorization as a fix for storage quota errors', () => {
    useLibraryStore.setState({ status: 'error', error: 'Drive đầy', errorDetails: appError('Drive đầy', { status: 403, reason: 'storageQuotaExceeded', recovery: 'Giải phóng dung lượng.' }) })
    render(<App />)
    expect(screen.getByText('Giải phóng dung lượng.')).toBeInTheDocument()
    expect(screen.queryByText('Chọn thư mục gốc trên Google Drive')).not.toBeInTheDocument()
  })

  it('links disabled Drive API errors to Google Cloud without asking for broader scopes', () => {
    useLibraryStore.setState({ status: 'error', permissionHelp: false, error: 'Google Drive API chưa được bật.', errorDetails: appError('Google Drive API chưa được bật.', { status: 403, reason: 'accessNotConfigured' }) })
    render(<App />)
    expect(screen.getByRole('link', { name: 'Bật Google Drive API ↗' })).toHaveAttribute('href', expect.stringContaining('https://console.cloud.google.com/apis/library/drive.googleapis.com'))
    expect(screen.queryByText('Cấp quyền đọc Drive bổ sung')).not.toBeInTheDocument()
  })

  it('shows existing music for listening and playlists without offering Drive mutations', () => {
    useLibraryStore.setState({
      tracks: [{ ...track('old', 'Existing.mp3'), appManaged: false, canRename: true, canTrash: true }],
      folder: { ...useLibraryStore.getState().folder!, ownedByMe: true },
    })
    render(<App />)
    expect(screen.getByText('Existing')).toBeInTheDocument()
    expect(screen.getByLabelText('Phát Existing.mp3')).toBeEnabled()
    fireEvent.click(screen.getByLabelText('Tùy chọn Existing.mp3'))
    expect(screen.getByRole('menuitem', { name: 'Tạo playlist mới' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Đổi tên/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Chuyển vào thùng rác/ })).not.toBeInTheDocument()
  })

  it('requests broader read access only after an explicit click with scope disclosure', () => {
    authMock.getTokenState.mockReturnValue({ accessToken: 'test', expiresAt: Date.now() + 60_000, scopes: ['https://www.googleapis.com/auth/drive.file'] })
    const enable = vi.fn().mockResolvedValue(undefined)
    useLibraryStore.setState({ enableReadAccess: enable })
    render(<App />)
    expect(screen.getByText('đọc toàn bộ Google Drive')).toBeInTheDocument()
    expect(enable).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cấp quyền đọc nhạc có sẵn' }))
    expect(enable).toHaveBeenCalledTimes(1)
  })

  it('does not ask again when read-only Drive access is already granted', () => {
    authMock.getTokenState.mockReturnValue({ accessToken: 'test', expiresAt: Date.now() + 60_000, scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly'] })
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Cấp quyền đọc nhạc có sẵn' })).not.toBeInTheDocument()
  })

  it('keeps the broader read option disabled when the website setting is off', () => {
    driveMock.isReadOnlyFallbackEnabled.mockReturnValue(false)
    authMock.getTokenState.mockReturnValue({ accessToken: 'test', expiresAt: Date.now() + 60_000, scopes: ['https://www.googleapis.com/auth/drive.file'] })
    render(<App />)
    expect(screen.getByRole('button', { name: 'Cấp quyền đọc nhạc có sẵn' })).toBeDisabled()
  })
})
