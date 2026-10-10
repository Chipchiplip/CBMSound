import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import type { DriveTrack } from '../types'

const authMock = vi.hoisted(() => ({
  getTokenState: vi.fn(), requestAccessToken: vi.fn(), prepareGoogleIdentity: vi.fn(),
}))
const accountMock = vi.hoisted(() => ({ getRememberedAccount: vi.fn() }))

vi.mock('../services/auth', async (original) => ({
  ...await original<typeof import('../services/auth')>(),
  hasGoogleClient: () => true,
  isGoogleIdentityReady: () => true,
  getTokenState: authMock.getTokenState,
  requestAccessToken: authMock.requestAccessToken,
  prepareGoogleIdentity: authMock.prepareGoogleIdentity,
  subscribeToken: () => () => {},
}))
vi.mock('../services/rememberedAccount', async (original) => ({
  ...await original<typeof import('../services/rememberedAccount')>(),
  getRememberedAccount: accountMock.getRememberedAccount,
}))

const user = { permissionId: '1234567890', emailAddress: 'hoang@example.com', displayName: 'Nguyễn Hoàng' }
const scopes = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly']
const track: DriveTrack = {
  id: 'playing-song', name: 'Current song.mp3', appManaged: true,
  mimeType: 'audio/mpeg', size: 1024, createdTime: '2026-10-10T00:00:00Z', modifiedTime: '2026-10-10T00:00:00Z',
}
const connect = vi.fn<() => Promise<void>>()
const switchAccount = vi.fn<() => Promise<void>>()
const reconnect = vi.fn<() => Promise<void>>()
const disconnect = vi.fn<() => void>()
const stop = vi.fn<() => void>()

beforeEach(() => {
  vi.clearAllMocks()
  connect.mockResolvedValue(undefined)
  switchAccount.mockResolvedValue(undefined)
  reconnect.mockResolvedValue(undefined)
  disconnect.mockImplementation(() => {})
  stop.mockImplementation(() => {})
  authMock.getTokenState.mockReturnValue({ accessToken: 'test-token', expiresAt: Date.now() + 60_000, scopes })
  authMock.prepareGoogleIdentity.mockResolvedValue(undefined)
  accountMock.getRememberedAccount.mockReturnValue({ ...user, scopes })
  history.replaceState(null, '', '/#/library')
  useLibraryStore.setState({
    ...useLibraryStore.getInitialState(), status: 'ready', page: 'library', user,
    folder: { folderId: 'root-folder', name: 'Music library', ownedByMe: false, canAddChildren: false, canShare: false, canRename: false, canDeleteChildren: false, isAppAuthorized: true },
    tracks: [track], cacheSource: 'remote', lastSynced: '2026-10-10T00:00:00Z',
    connect, switchAccount, reconnect, disconnect,
  })
  usePlayerStore.setState({
    ...usePlayerStore.getInitialState(), currentTrack: track, queue: [track],
    isPlaying: true, currentTime: 37, duration: 200, stop,
  })
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('account navigation and remembered login', () => {
  it.each(['Mở cài đặt tài khoản', 'Mở hồ sơ tài khoản'])('opens settings from %s while preserving authentication and playback', async (label) => {
    render(<App />)
    const profile = screen.getByRole('link', { name: label })
    expect(profile).toHaveAttribute('href', '#/settings')
    fireEvent.click(profile)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Quyền riêng tư' })).toBeInTheDocument())
    expect(location.hash).toBe('#/settings')
    expect(useLibraryStore.getState().status).toBe('ready')
    expect(useLibraryStore.getState().user).toEqual(user)
    expect(usePlayerStore.getState()).toMatchObject({ currentTrack: track, isPlaying: true, currentTime: 37 })
    expect(disconnect).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
    expect(switchAccount).not.toHaveBeenCalled()
    expect(authMock.requestAccessToken).not.toHaveBeenCalled()
  })

  it('ends playback and disconnects only through the explicit Settings logout action', () => {
    history.replaceState(null, '', '/#/settings')
    useLibraryStore.setState({ page: 'settings' })
    stop.mockImplementation(() => usePlayerStore.setState({ currentTrack: null, isPlaying: false, currentTime: 0 }))
    disconnect.mockImplementation(() => {
      accountMock.getRememberedAccount.mockReturnValue(undefined)
      useLibraryStore.setState({ status: 'signedOut', user: null, folder: null, tracks: [] })
    })
    render(<App />)
    expect(disconnect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Đăng xuất' }))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(usePlayerStore.getState()).toMatchObject({ currentTrack: null, isPlaying: false })
    expect(screen.getByRole('button', { name: /Kết nối với Google/ })).toBeInTheDocument()
    expect(location.hash).toBe('#/home')
    expect(connect).not.toHaveBeenCalled()
    expect(authMock.requestAccessToken).not.toHaveBeenCalled()
  })

  it('shows the remembered account after refresh without authenticating or opening a popup on render', () => {
    useLibraryStore.setState({ status: 'signedOut', user: null, folder: null, tracks: [] })
    authMock.getTokenState.mockReturnValue(undefined)
    render(<App />)
    expect(screen.getByText(user.emailAddress)).toBeInTheDocument()
    expect(screen.getByText(user.displayName, { exact: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Tiếp tục với Nguyễn Hoàng/ })).toBeEnabled()
    expect(connect).not.toHaveBeenCalled()
    expect(switchAccount).not.toHaveBeenCalled()
    expect(authMock.requestAccessToken).not.toHaveBeenCalled()
    expect(authMock.prepareGoogleIdentity).not.toHaveBeenCalled()
    expect(useLibraryStore.getState().status).toBe('signedOut')
  })

  it('starts connecting to the remembered account only after the user clicks Continue', () => {
    useLibraryStore.setState({ status: 'signedOut', user: null, folder: null, tracks: [] })
    authMock.getTokenState.mockReturnValue(undefined)
    render(<App />)
    expect(connect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Tiếp tục với Nguyễn Hoàng/ }))
    expect(connect).toHaveBeenCalledTimes(1)
    expect(switchAccount).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('lets returning users explicitly choose another account instead of reconnecting the saved hint', () => {
    useLibraryStore.setState({ status: 'signedOut', user: null, folder: null, tracks: [] })
    authMock.getTokenState.mockReturnValue(undefined)
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Dùng tài khoản khác' }))
    expect(switchAccount).toHaveBeenCalledTimes(1)
    expect(connect).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('offers explicit account switching in Settings without signing out on profile navigation', () => {
    history.replaceState(null, '', '/#/settings')
    useLibraryStore.setState({ page: 'settings' })
    render(<App />)
    const swap = screen.getByRole('button', { name: 'Đổi tài khoản' })
    expect(swap).toBeEnabled()
    expect(switchAccount).not.toHaveBeenCalled()
    fireEvent.click(swap)
    expect(switchAccount).toHaveBeenCalledTimes(1)
    expect(connect).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('prevents opening a second account flow while a connection is pending', () => {
    useLibraryStore.setState({ status: 'connecting', user: null, folder: null, tracks: [] })
    authMock.getTokenState.mockReturnValue(undefined)
    render(<App />)
    const pending = screen.getByRole('button', { name: /Đang kết nối Google/ })
    const other = screen.getByRole('button', { name: 'Dùng tài khoản khác' })
    expect(pending).toBeDisabled()
    expect(other).toBeDisabled()
    fireEvent.click(pending)
    fireEvent.click(other)
    expect(connect).not.toHaveBeenCalled()
    expect(switchAccount).not.toHaveBeenCalled()
  })

  it('uses the regular Google connection screen when no account is remembered', () => {
    accountMock.getRememberedAccount.mockReturnValue(undefined)
    useLibraryStore.setState({ status: 'signedOut', user: null, folder: null, tracks: [] })
    authMock.getTokenState.mockReturnValue(undefined)
    render(<App />)
    expect(screen.getByRole('button', { name: /Kết nối với Google/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Tiếp tục với/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dùng tài khoản khác' })).not.toBeInTheDocument()
    expect(connect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Kết nối với Google/ }))
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
