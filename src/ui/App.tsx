import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, ArrowDownAZ, AudioLines, BadgeCheck, ChevronDown, CircleHelp, Clock3,
  Cloud, Disc3, FileAudio, Headphones, Heart, Library, ListMusic, LogOut, Music2,
  Play, Plus, RefreshCw, Search, Settings, Shield, Shuffle, SkipBack, SkipForward, LayoutGrid,
  Sparkles, Upload, Volume1, Volume2, VolumeX, X,
} from 'lucide-react'
import type { DriveTrack, LibraryMember } from '../types'
import { isSupportedAudio } from '../types'
import { useLibraryStore, selectVisibleTracks, type LibraryPage } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { canRetryUploadJob, formatBytes, uploadEtaText, uploadProgress, useUploadStore } from '../stores/uploads'
import { DRIVE_READONLY_SCOPE, getTokenState, hasGoogleClient, isGoogleIdentityReady, prepareGoogleIdentity, revokeGoogleAccess, subscribeToken } from '../services/auth'
import { hasPickerConfiguration } from '../services/googlePicker'
import { isReadOnlyFallbackEnabled } from '../services/drive'
import { getRememberedAccount, type RememberedAccount } from '../services/rememberedAccount'

const NAV: Array<{ id: LibraryPage; label: string; icon: typeof Library; section?: string }> = [
  { id: 'home', label: 'Khám phá', icon: Sparkles, section: 'KHÔNG GIAN NHẠC' },
  { id: 'library', label: 'Thư viện', icon: Library },
  { id: 'playlists', label: 'Playlist', icon: ListMusic, section: 'CỦA BẠN' },
  { id: 'recent', label: 'Nghe gần đây', icon: Clock3 },
  { id: 'upload', label: 'Tải nhạc lên', icon: Upload, section: 'QUẢN LÝ' },
  { id: 'settings', label: 'Cài đặt', icon: Settings },
]

const PAGE_TITLES: Record<LibraryPage, { title: string; eyebrow: string }> = {
  home: { eyebrow: 'KHÔNG GIAN CỦA BẠN', title: 'Âm nhạc, theo nhịp riêng.' },
  library: { eyebrow: 'TOÀN BỘ BỘ SƯU TẬP', title: 'Thư viện nhạc' },
  playlists: { eyebrow: 'LƯU LẠI CẢM XÚC', title: 'Playlist của bạn' },
  recent: { eyebrow: 'QUAY LẠI NHỊP ĐIỆU', title: 'Nghe gần đây' },
  upload: { eyebrow: 'BỘ SƯU TẬP RIÊNG', title: 'Thêm nhạc mới' },
  settings: { eyebrow: 'QUYỀN RIÊNG TƯ', title: 'Thiết lập thư viện' },
}

const ROOT_FOLDER_ID = import.meta.env.VITE_DRIVE_FOLDER_ID?.trim() || '1_GEZPONNMBfSzvVs2tFHDiCp40fNjREB'
const GOOGLE_PROJECT_NUMBER = import.meta.env.VITE_GOOGLE_CLOUD_PROJECT_NUMBER?.trim() || ''
const DRIVE_API_SETUP_URL = `https://console.cloud.google.com/apis/library/drive.googleapis.com${/^\d+$/.test(GOOGLE_PROJECT_NUMBER) ? `?project=${GOOGLE_PROJECT_NUMBER}` : ''}`

export function App() {
  const status = useLibraryStore((state) => state.status)
  const connect = useLibraryStore((state) => state.connect)
  const switchAccount = useLibraryStore((state) => state.switchAccount)
  const page = useLibraryStore((state) => state.page)
  const playlists = useLibraryStore((state) => state.playlists)
  const setPage = useLibraryStore((state) => state.setPage)
  const user = useLibraryStore((state) => state.user)
  const folder = useLibraryStore((state) => state.folder)
  const error = useLibraryStore((state) => state.error)
  const setError = useLibraryStore((state) => state.setError)
  const notice = useLibraryStore((state) => state.notice)
  const setNotice = useLibraryStore((state) => state.setNotice)
  const cacheSource = useLibraryStore((state) => state.cacheSource)
  const lastSynced = useLibraryStore((state) => state.lastSynced)
  const busy = useLibraryStore((state) => state.busy)
  const playerTrack = usePlayerStore((state) => state.currentTrack)
  const [originHint, setOriginHint] = useState(false)
  const [identityReady, setIdentityReady] = useState(isGoogleIdentityReady())
  const [identityError, setIdentityError] = useState('')
  const [authorized, setAuthorized] = useState(Boolean(getTokenState()))

  useEffect(() => subscribeToken((token) => setAuthorized(Boolean(token))), [])

  const prepareIdentity = useCallback(() => {
    setIdentityError('')
    void prepareGoogleIdentity().then(() => setIdentityReady(true)).catch((error: unknown) => {
      setIdentityReady(false)
      setIdentityError(error instanceof Error ? error.message : 'Không tải được thư viện đăng nhập Google.')
    })
  }, [])

  useEffect(() => {
    if (hasGoogleClient() && !isGoogleIdentityReady()) prepareIdentity()
  }, [prepareIdentity])

  useEffect(() => {
    const syncPage = () => {
      const part = location.hash.replace(/^#\/?/, '').split('/')[0]
      const accepted = NAV.some((item) => item.id === part)
      if (accepted) setPage(part as LibraryPage)
    }
    syncPage()
    addEventListener('hashchange', syncPage)
    return () => removeEventListener('hashchange', syncPage)
  }, [setPage])

  useEffect(() => {
    const refresh = () => {
      const library = useLibraryStore.getState()
      if (document.visibilityState === 'visible' && library.status === 'ready' && getTokenState() && !library.busy &&
          (!library.lastSynced || Date.now() - Date.parse(library.lastSynced) > 5 * 60_000)) void library.sync()
    }
    document.addEventListener('visibilitychange', refresh)
    return () => document.removeEventListener('visibilitychange', refresh)
  }, [])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (page !== 'library') location.hash = '#/library'
        window.setTimeout(() => document.getElementById('library-search')?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [page])

  if (status === 'signedOut' || status === 'connecting') {
    return <WelcomeScreen busy={status === 'connecting'} configured={hasGoogleClient()} identityReady={identityReady} identityError={identityError} onRetryIdentity={prepareIdentity} originHint={originHint} setOriginHint={setOriginHint} remembered={getRememberedAccount()} onConnect={() => void connect()} onSwitchAccount={() => void switchAccount()} />
  }
  if (status === 'needsFolder') return <FolderSetup user={user?.emailAddress} />

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/home" aria-label="CBM Sound — Trang chủ">
          <span className="brand-mark"><AudioLines size={21} strokeWidth={2.4} /></span>
          <span className="brand-name">cbm<span>sound</span><i>.</i></span>
        </a>
        <div className="library-switcher"><span className="switcher-icon"><Disc3 size={17} /></span><span><strong>Thư viện chung</strong><small>Đồng bộ với Google Drive</small></span><ChevronDown size={15} /></div>
        <nav className="primary-nav" aria-label="Điều hướng chính">
          {NAV.map((item) => {
            const Icon = item.icon
            return <div key={item.id}>{item.section && <p className="nav-section-title">{item.section}</p>}<a className={`nav-link ${page === item.id ? 'active' : ''}`} href={`#/${item.id}`}><Icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.id === 'upload' && folder?.ownedByMe && <span className="nav-plus"><Plus size={14} /></span>}</a></div>
          })}
        </nav>
        <div className="sidebar-playlists">
          <div className="sidebar-list-heading"><span>PLAYLIST CỦA TÔI</span><button aria-label="Tạo playlist mới" onClick={() => createNewPlaylist()}><Plus size={15} /></button></div>
          {playlists.length === 0 ? <p className="sidebar-hint">Những playlist bạn tạo sẽ hiện ở đây.</p> : playlists.slice(0, 5).map((playlist) => <a className="small-playlist" href="#/playlists" key={playlist.id}><Music2 size={14} />{playlist.name}</a>)}
        </div>
        <div className="sidebar-bottom">
          <div className="drive-status"><span className="online-dot" /><span>{status === 'ready' && authorized ? 'Google Drive đã kết nối' : 'Cần kết nối lại Google'}</span></div>
          <a className="account-button" href="#/settings" aria-label="Mở cài đặt tài khoản"><span className="avatar">{user?.displayName?.slice(0, 1) || 'M'}</span><span className="account-label"><strong>{user?.displayName || 'Tài khoản Google'}</strong><small>{folder?.ownedByMe ? 'Quản lý thư viện' : 'Quyền nghe'}</small></span><Settings size={15} /></a>
        </div>
      </aside>

      <div className="app-main-column">
        <header className="topbar">
          <div className="breadcrumb"><span>CBM SOUND</span><span className="breadcrumb-separator">/</span><strong>{PAGE_TITLES[page].title}</strong></div>
          <div className="topbar-actions"><span className="online-status" title={lastSynced ? `Đồng bộ lúc ${formatDateTime(lastSynced)}` : 'Chưa đồng bộ'}><span className="online-dot" />{busy ? 'Đang đồng bộ…' : status !== 'ready' || !authorized ? 'Cần kết nối lại' : cacheSource === 'cache' ? 'Dữ liệu đã lưu' : lastSynced ? 'Đã đồng bộ' : 'Chưa đồng bộ'}</span><a className="topbar-avatar" href="#/settings" aria-label="Mở hồ sơ tài khoản" title="Cài đặt tài khoản">{user?.displayName?.slice(0, 1) || 'M'}</a></div>
        </header>
        <main className="main-content">
          <div className="page-title"><div><p className="eyebrow">{PAGE_TITLES[page].eyebrow}</p><h1>{PAGE_TITLES[page].title}</h1></div>{page === 'library' && <a className="button button-secondary desktop-add-button" href={folder?.ownedByMe ? '#/upload' : '#/library'} onClick={folder?.ownedByMe ? undefined : (event) => event.preventDefault()}><Upload size={15} />{folder?.ownedByMe ? 'Tải nhạc lên' : 'Thư viện chia sẻ'}</a>}</div>
          {error && <div role="alert" className="toast toast-error"><CircleHelp size={17} /><span>{error}</span><button onClick={() => setError(null)} aria-label="Đóng thông báo"><X size={15} /></button></div>}
          {notice && <div role="status" className="toast toast-success"><BadgeCheck size={17} /><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Đóng thông báo thành công"><X size={15} /></button></div>}
          {status === 'ready' && !authorized && <div role="status" className="toast toast-success"><Shield size={17} /><span>Phiên Google đã hết hạn. Kết nối lại để tiếp tục dùng Drive.</span><button className="text-button" disabled={busy} onClick={() => void reconnectAndResume()}>Kết nối lại</button></div>}
          {status === 'error' && <AccessError />}
          {status === 'ready' && ['home', 'library', 'settings'].includes(page) && <ExistingMusicAccess />}
          {status !== 'error' && page === 'home' && <HomePage />}
          {status !== 'error' && page === 'library' && <LibraryPageView />}
          {status !== 'error' && page === 'upload' && <UploadPage />}
          {status !== 'error' && page === 'settings' && <SettingsPage />}
          {status !== 'error' && page === 'playlists' && <PlaylistsPage />}
          {status !== 'error' && page === 'recent' && <RecentPage />}
        </main>
      </div>
      <PlayerBar />
      <span className="sr-only" aria-live="polite">{playerTrack ? `Đang chọn ${playerTrack.name}` : ''}</span>
    </div>
  )
}

function WelcomeScreen({ busy, configured, identityReady, identityError, onRetryIdentity, originHint, setOriginHint, remembered, onConnect, onSwitchAccount }: { busy: boolean; configured: boolean; identityReady: boolean; identityError: string; onRetryIdentity: () => void; originHint: boolean; setOriginHint: (value: boolean) => void; remembered?: RememberedAccount; onConnect: () => void; onSwitchAccount: () => void }) {
  const disabled = busy || !configured || !identityReady
  return <div className="welcome-shell">
    <div className="welcome-copy">
      <a className="brand" href="#/home"><span className="brand-mark"><AudioLines size={21} /></span><span className="brand-name">cbm<span>sound</span><i>.</i></span></a>
      <span className="welcome-overline">YOUR MUSIC, YOUR SPACE</span>
      <h1>Mọi giai điệu,<br /><span>đều là của bạn.</span></h1>
      <p>{remembered ? 'Chào bạn trở lại. Tài khoản đã được ghi nhớ trên thiết bị này; bấm tiếp tục để mở thư viện.' : 'Thư viện âm nhạc riêng tư được lưu trữ trên Google Drive. Kết nối tài khoản của bạn để bắt đầu lắng nghe.'}</p>
      {remembered && <div className="remembered-account"><span className="avatar">{(remembered.displayName || remembered.emailAddress).slice(0, 1)}</span><span><strong>{remembered.displayName || 'Tài khoản Google'}</strong><small>{remembered.emailAddress}</small></span></div>}
      <button className="button button-primary connect-button" disabled={disabled} onClick={onConnect}><GoogleG />{busy ? 'Đang kết nối Google…' : configured && !identityReady ? 'Đang chuẩn bị đăng nhập…' : remembered ? `Tiếp tục với ${remembered.displayName || remembered.emailAddress}` : 'Kết nối với Google'}<span aria-hidden>↗</span></button>
      {remembered && <button className="text-button switch-account" disabled={disabled} onClick={onSwitchAccount}>Dùng tài khoản khác</button>}
      {!configured && <p className="setup-needed">Cần cấu hình OAuth Client ID. Xem hướng dẫn trong README.md.</p>}
      {identityError && <div role="alert" className="inline-error">{identityError} <button className="text-button" onClick={onRetryIdentity}><RefreshCw size={13} /> Thử tải lại</button></div>}
      <div className="privacy-note"><Shield size={16} /><span>Nhạc của bạn vẫn riêng tư. Chúng tôi không tải file nhạc lên website.</span></div>
      <button className="text-button" onClick={() => setOriginHint(!originHint)}><CircleHelp size={14} />Không mở được Google?</button>
      {originHint && <p className="origin-note">Chỉ dùng HTTPS hoặc localhost. Thêm đúng domain của website vào Authorized JavaScript origins trong Google Cloud.</p>}
    </div>
    <div className="welcome-art"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="art-disc"><span className="disc-highlight" /><div className="disc-center"><AudioLines size={43} /></div></div><span className="float-note note-a"><Headphones size={16} /> Không gian của riêng bạn</span><span className="float-note note-b"><span className="online-dot" /> Riêng tư, luôn sẵn sàng</span><span className="art-label">EST. IN SOUND&nbsp;&nbsp; · &nbsp;&nbsp; VOL. 01</span></div>
  </div>
}

function GoogleG() { return <span className="google-g" aria-hidden="true">G</span> }

function FolderPickerHint() {
  return <p className="fine-print">Hộp này chỉ chọn thư mục nên không hiển thị nhạc. Chọn dòng thư mục gốc một lần rồi bấm <strong>Chọn</strong>. Nếu đã mở vào bên trong, bấm <strong>Thư mục</strong> trên thanh phía trên để quay lại.</p>
}

function ExistingMusicAccess() {
  const [token, setToken] = useState(getTokenState)
  const busy = useLibraryStore((state) => state.busy)
  const enable = useLibraryStore((state) => state.enableReadAccess)
  useEffect(() => subscribeToken(setToken), [])
  if (!token || token.scopes.includes(DRIVE_READONLY_SCOPE)) return null
  const enabled = isReadOnlyFallbackEnabled()
  return <section className="existing-music-access" aria-label="Quyền đọc nhạc có sẵn">
    <div><h2>Nhạc có sẵn trên Google Drive</h2><p>Quyền hiện tại chỉ đọc các file đã được cấp cho ứng dụng; danh sách có thể chưa có đủ nhạc cũ. Để tìm nhạc có sẵn, bạn có thể cấp quyền <strong>đọc toàn bộ Google Drive</strong>. CBM Sound chỉ lấy nhạc nằm trực tiếp trong thư mục gốc đã cấu hình và không sửa hay xóa file cũ.</p></div>
    <button className="button button-secondary" disabled={busy || !enabled} onClick={() => void enable()}>Cấp quyền đọc nhạc có sẵn</button>
    {!enabled && <p className="fine-print">Tùy chọn đọc nhạc có sẵn chưa được chủ website bật.</p>}
  </section>
}

function FolderSetup({ user }: { user?: string }) {
  const authorize = useLibraryStore((state) => state.authorizeRoot)
  const busy = useLibraryStore((state) => state.busy)
  const error = useLibraryStore((state) => state.error)
  return <div className="setup-screen"><div className="setup-card"><div className="setup-card-icon"><Cloud size={25} /></div><p className="eyebrow">KẾT NỐI THƯ VIỆN CHUNG</p><h1>Cấp quyền cho thư mục gốc.</h1><p className="muted-copy">{user ? `Đang kết nối bằng ${user}. ` : ''}Chọn thư mục đã cấu hình qua Google Picker để ứng dụng truy cập với quyền drive.file.</p>{error && <div className="inline-error" role="alert">{error}</div>}<div className="copy-field"><code>{ROOT_FOLDER_ID}</code><button onClick={() => void copyText(ROOT_FOLDER_ID)}>Sao chép</button></div><button className="button button-primary" disabled={busy || !hasPickerConfiguration()} onClick={() => void authorize()}>Chọn thư mục gốc trên Google Drive</button><FolderPickerHint />{!hasPickerConfiguration() && <p className="fine-print">Cấu hình Google Picker API Key và Project Number theo README, rồi khởi động lại website.</p>}<a className="text-button" target="_blank" rel="noreferrer" href={`https://drive.google.com/drive/folders/${ROOT_FOLDER_ID}`}>Mở thư mục trên Drive ↗</a><button className="button button-quiet" onClick={disconnectAccount}>Đăng xuất</button></div></div>
}

function AccessError() {
  const error = useLibraryStore((state) => state.error)
  const details = useLibraryStore((state) => state.errorDetails)
  const help = useLibraryStore((state) => state.permissionHelp)
  const enable = useLibraryStore((state) => state.enableReadAccess)
  const authorize = useLibraryStore((state) => state.authorizeRoot)
  const busy = useLibraryStore((state) => state.busy)
  const user = useLibraryStore((state) => state.user)
  const canPick = hasPickerConfiguration()
  const folderId = ROOT_FOLDER_ID
  const needsPicker = details?.status === 404 || ['appNotAuthorizedToFile', 'insufficientScopes', 'insufficientPermissions'].includes(details?.reason || '')
  return <div className="access-card">
    <div className="empty-icon"><Shield size={22} /></div>
    <p className="eyebrow">KHÔNG THỂ MỞ THƯ VIỆN</p><h2>Kiểm tra quyền truy cập</h2>
    <p>{error || 'Tài khoản hiện tại chưa được cấp quyền vào thư mục này.'}</p>
    {details?.recovery && <p>{details.recovery}</p>}
    {details?.status && <small className="account-tip">HTTP {details.status}{details.reason ? ` · ${details.reason}` : ''}</small>}
    {['accessNotConfigured', 'serviceDisabled'].includes(details?.reason || '') && <a className="button button-primary" href={DRIVE_API_SETUP_URL} target="_blank" rel="noreferrer">Bật Google Drive API ↗</a>}
    {needsPicker && <div className="root-access-help">
      <p>Với quyền drive.file, thư mục có sẵn cần được chọn qua Google Picker để cấp quyền cho ứng dụng.</p>
      <button className="button button-secondary" disabled={busy || !canPick} onClick={() => void authorize()}>Chọn thư mục gốc trên Google Drive</button>
      <FolderPickerHint />
      {!canPick && <p className="inline-error">Cần cấu hình Google Picker API Key và Google Cloud Project Number theo README, rồi khởi động lại website.</p>}
    </div>}
    {help && <><div className="scope-note"><Shield size={16} /><span>Quyền bổ sung cho phép đọc toàn bộ Google Drive của bạn. Ứng dụng chỉ truy vấn thư mục nhạc đã cấu hình. Quyền này không cấp khả năng upload hay quản lý thư viện.</span></div><button className="button button-secondary" disabled={busy} onClick={() => void enable()}>Cấp quyền đọc Drive bổ sung</button></>}
    <button className="button button-quiet" disabled={busy} onClick={() => void reconnectAndResume()}><RefreshCw size={15} />Kết nối lại Google</button>
    <div className="access-divider" />
    {folderId && <a className="text-button root-folder-link" target="_blank" rel="noreferrer" href={`https://drive.google.com/drive/folders/${folderId}`}>Mở thư mục gốc trên Drive ↗</a>}
    <small className="account-tip">Đang đăng nhập: {user?.emailAddress || 'Google'}. Nếu Drive không mở được thư mục, hãy yêu cầu chủ sở hữu cấp quyền cho đúng tài khoản.</small>
  </div>
}

function HomePage() {
  const tracks = useLibraryStore((state) => state.tracks)
  const user = useLibraryStore((state) => state.user)
  const visible = tracks.filter((track) => !track.unavailable && isSupportedAudio(track))
  const volume = visible.reduce((sum, track) => sum + track.size, 0)
  return <><section className="hero-panel"><div className="hero-copy"><p className="hero-kicker"><span className="hero-kicker-dot" /> YOUR PERSONAL LIBRARY</p><h2>Những giai điệu<br />nói hộ tâm trạng.</h2><p>Thư viện nhạc riêng tư, được thiết kế để đồng hành cùng bạn — mọi ngày.</p><a className="button button-primary" href="#/library"><Library size={16} />Khám phá thư viện<ChevronDown className="hero-arrow" size={16} /></a></div><div className="hero-art"><span className="art-glow" /><div className="hero-vinyl"><div className="vinyl-lines" /><div className="vinyl-label"><span>CBM</span><AudioLines size={18} /><small>SOUND</small></div></div><div className="hero-spark spark-one"><i /><i /><i /><i /></div><div className="hero-caption">COLLECTION&nbsp; 01<br /><strong>MADE FOR YOUR EARS</strong></div></div></section><section className="stats-row"><div className="stat-item"><span>TRONG THƯ VIỆN</span><strong>{visible.length.toLocaleString('vi-VN')} <small>bài hát</small></strong></div><div className="stat-item"><span>DUNG LƯỢNG ĐANG DÙNG</span><strong>{formatBytes(volume)}</strong></div><div className="stat-item"><span>ĐỒNG HÀNH CÙNG</span><strong className="stat-user"><span className="online-dot" />{user?.displayName || 'Bạn'}</strong></div></section><div className="section-heading"><div><p className="eyebrow">BỘ SƯU TẬP RIÊNG</p><h2>Gần đây trong thư viện</h2></div><a className="subtle-link" href="#/library">Xem tất cả <span>↗</span></a></div>{visible.length ? <TrackTable tracks={visible.slice(0, 5)} showDate={false} /> : <EmptyLibrary compact />}</>
}

function LibraryPageView() {
  const allTracks = useLibraryStore((state) => state.tracks)
  const query = useLibraryStore((state) => state.query)
  const sort = useLibraryStore((state) => state.sort)
  const ascending = useLibraryStore((state) => state.ascending)
  const tracks = useMemo(() => selectVisibleTracks({ tracks: allTracks, query, sort, ascending }), [allTracks, query, sort, ascending])
  const setQuery = useLibraryStore((state) => state.setQuery)
  const setSort = useLibraryStore((state) => state.setSort)
  const sync = useLibraryStore((state) => state.sync)
  const busy = useLibraryStore((state) => state.busy)
  const folder = useLibraryStore((state) => state.folder)
  const lastSynced = useLibraryStore((state) => state.lastSynced)
  const cacheSource = useLibraryStore((state) => state.cacheSource)
  const [grid, setGrid] = useState(false)
  const audioTracks = allTracks.filter((track) => !track.unavailable && isSupportedAudio(track))
  const total = audioTracks.reduce((sum, item) => sum + item.size, 0)
  return <>
    <div className="library-summary"><div><strong>{audioTracks.length}</strong><span>bài hát</span><i /><strong>{formatBytes(total)}</strong><span>trong Drive</span></div><button className="sync-button" disabled={busy} onClick={() => void sync()}><RefreshCw className={busy ? 'spin' : ''} size={14} />Đồng bộ</button></div>
    <p className="sync-detail" role="status">{busy ? 'Đang lấy đầy đủ danh sách từ Drive…' : cacheSource === 'cache' ? 'Đang hiển thị dữ liệu đã lưu; chưa xác nhận lại với Drive.' : 'Dữ liệu từ Google Drive.'} {lastSynced && `Lần đồng bộ gần nhất: ${formatDateTime(lastSynced)}.`}</p>
    <div className="library-toolbar">
      <label className="search-box"><Search size={17} /><input id="library-search" aria-label="Tìm bài hát" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm bài hát, nghệ sĩ, album…" /><kbd>Ctrl K</kbd></label>
      <div className="sort-menu"><ArrowDownAZ size={15} /><select value={sort} onChange={(event) => { if (event.target.value !== sort) setSort(event.target.value as typeof sort) }} aria-label="Sắp xếp theo"><option value="name">Tên bài</option><option value="createdTime">Ngày tải</option><option value="size">Dung lượng</option></select><button className="icon-button" aria-label={ascending ? 'Đổi sang giảm dần' : 'Đổi sang tăng dần'} onClick={() => setSort(sort)}>{ascending ? '↑' : '↓'}</button></div>
      <button className="icon-button view-toggle" aria-label={grid ? 'Hiển thị danh sách' : 'Hiển thị lưới'} aria-pressed={grid} onClick={() => setGrid(!grid)}>{grid ? <ListMusic size={17} /> : <LayoutGrid size={17} />}</button>
    </div>
    {busy && !allTracks.length ? <LibrarySkeleton /> : tracks.length ? grid ? <TrackGrid tracks={tracks} /> : <TrackTable tracks={tracks} showDate /> : query ? <div className="empty-state compact-empty"><Search size={22} /><h3>Không tìm thấy bài phù hợp</h3><p>Thử tên bài hát hoặc nghệ sĩ khác.</p></div> : <EmptyLibrary />}
    {!folder?.ownedByMe && <p className="listener-note"><Headphones size={14} />Bạn đang nghe từ thư viện được chia sẻ. Playlist và lịch sử nghe chỉ lưu trên thiết bị này.</p>}
  </>
}

function LibrarySkeleton() {
  return <div className="library-skeleton" role="status" aria-label="Đang tải thư viện">{Array.from({ length: 5 }, (_, index) => <div className="skeleton-row" key={index}><span /><i /><b /></div>)}</div>
}

function TrackGrid({ tracks }: { tracks: DriveTrack[] }) {
  const play = usePlayerStore((state) => state.play)
  return <div className="track-grid">{tracks.map((track) => <button className="track-grid-card" key={track.id} onClick={() => void play(track, tracks)} aria-label={`Phát ${track.name}`}><CoverArt track={track} large /><strong>{track.name.replace(/\.[^/.]+$/, '')}</strong><small>{track.artist || 'Chưa rõ nghệ sĩ'}</small><span><Play size={14} />{track.duration ? formatTime(track.duration) : formatBytes(track.size)}</span></button>)}</div>
}

function TrackTable({ tracks, showDate }: { tracks: DriveTrack[]; showDate: boolean }) {
  const current = usePlayerStore((state) => state.currentTrack)
  const play = usePlayerStore((state) => state.play)
  const playlists = useLibraryStore((state) => state.playlists)
  const togglePlaylistTrack = useLibraryStore((state) => state.togglePlaylistTrack)
  const rename = useLibraryStore((state) => state.rename)
  const removeTrack = useLibraryStore((state) => state.removeTrack)
  const owner = useLibraryStore((state) => Boolean(state.folder?.ownedByMe && state.folder.isAppAuthorized))
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [mutating, setMutating] = useState(false)
  async function mutate(action: () => Promise<void>) {
    setMutating(true); setOpenMenu(null)
    try { await action() } catch (error) { reportError(error) } finally { setMutating(false) }
  }
  const queue = tracks.filter((track) => !track.unavailable && isSupportedAudio(track))
  return <div className="track-list">
    <div className={`track-header ${showDate ? 'with-date' : ''}`}><span className="track-number">#</span><span>TÊN BÀI / NGHỆ SĨ</span><span className="track-album-heading">ALBUM</span>{showDate && <span className="track-date-heading">NGÀY TẢI</span>}<span className="track-size-heading">DUNG LƯỢNG</span><span className="track-duration-heading">◷</span><span /></div>
    {tracks.map((track, index) => {
      const active = current?.id === track.id
      return <div className={`track-row ${showDate ? 'with-date' : ''} ${active ? 'is-current' : ''} ${track.unavailable ? 'unavailable-track' : ''}`} key={track.id}>
        <span className="track-number">{active ? <AudioLines className="playing-icon" size={15} /> : <><span className="number-text">{String(index + 1).padStart(2, '0')}</span><button disabled={track.unavailable} className="row-play" aria-label={`Phát ${track.name}`} onClick={() => void play(track, queue)}><Play size={15} fill="currentColor" /></button></>}</span>
        <button disabled={track.unavailable} className="track-name-button" title={track.name} onClick={() => void play(track, queue)}><CoverArt track={track} /><span className="track-title"><strong>{track.name.replace(/\.[^/.]+$/, '')}</strong><small>{track.unavailable ? 'Không còn trong thư viện' : track.artist || 'Chưa rõ nghệ sĩ'}</small></span></button>
        <span className="track-album">{track.album || '—'}</span>{showDate && <span className="track-date">{track.createdTime ? formatDate(track.createdTime) : '—'}</span>}<span className="track-size">{formatBytes(track.size)}</span><span className="track-duration">{track.duration ? formatTime(track.duration) : '—'}</span>
        <div className="row-menu-wrap"><button disabled={mutating} className="more-button" aria-label={`Tùy chọn ${track.name}`} aria-expanded={openMenu === track.id} onClick={() => setOpenMenu(openMenu === track.id ? null : track.id)}><span>···</span></button>
          {openMenu === track.id && <div className="row-menu" role="menu"><div className="menu-label">PLAYLIST CÁ NHÂN</div>{playlists.length ? playlists.map((playlist) => <button key={playlist.id} role="menuitem" onClick={() => void mutate(() => togglePlaylistTrack(playlist.id, track.id))}><Plus size={14} />{playlist.name}{playlist.trackIds.includes(track.id) && <span className="menu-added">Gỡ bài</span>}</button>) : <button role="menuitem" onClick={() => { createNewPlaylist(track.id); setOpenMenu(null) }}><Plus size={14} />Tạo playlist mới</button>}
            {owner && track.appManaged && !track.unavailable && <><div className="menu-separator" />{track.canRename !== false && <button role="menuitem" onClick={() => { const name = window.prompt('Tên bài hát mới', track.name); if (name?.trim()) void mutate(() => rename(track, name)); else setOpenMenu(null) }}>↗ Đổi tên</button>}{track.canTrash !== false && <button className="menu-danger" role="menuitem" onClick={() => { if (window.confirm(`Chuyển “${track.name}” vào thùng rác Google Drive?`)) void mutate(() => removeTrack(track)); else setOpenMenu(null) }}><X size={14} />Chuyển vào thùng rác</button>}</>}
          </div>}
        </div>
      </div>
    })}
  </div>
}

function CoverArt({ track, large = false }: { track: DriveTrack; large?: boolean }) {
  if (track.artwork) return <img className={`cover-art ${large ? 'large-cover' : ''}`} src={track.artwork} alt="" />
  const palettes = ['cover-coral', 'cover-blue', 'cover-sand', 'cover-olive']
  const n = Array.from(track.id).reduce((sum, c) => sum + c.charCodeAt(0), 0) % palettes.length
  return <span className={`cover-art ${large ? 'large-cover' : ''} ${palettes[n]}`}><AudioLines size={large ? 26 : 16} /></span>
}

function EmptyLibrary({ compact = false }: { compact?: boolean }) {
  const owner = useLibraryStore((state) => state.folder?.ownedByMe)
  return <div className={`empty-state ${compact ? 'compact-empty' : ''}`}><div className="empty-artwork"><Disc3 size={27} /></div><p className="eyebrow">BẮT ĐẦU TỪ NHỮNG GIAI ĐIỆU CỦA BẠN</p><h3>Chưa tìm thấy nhạc trong thư viện.</h3><p>Ứng dụng lấy file âm thanh nằm trực tiếp trong thư mục gốc. Nếu Drive đã có nhạc, hãy cấp quyền đọc nhạc có sẵn ở phía trên rồi đồng bộ lại; nhạc trong thư mục con chưa được quét.</p>{owner && <a className="button button-primary" href="#/upload"><Upload size={15} />Tải nhạc lên</a>}</div>
}

function UploadPage() {
  const folder = useLibraryStore((state) => state.folder)
  const owner = folder?.ownedByMe
  const canUpload = Boolean(owner && folder?.isAppAuthorized && folder.canAddChildren)
  const authorize = useLibraryStore((state) => state.authorizeRoot)
  const jobs = useUploadStore((state) => state.jobs)
  const addFiles = useUploadStore((state) => state.addFiles)
  const start = useUploadStore((state) => state.start)
  const processing = useUploadStore((state) => state.processing)
  const cancel = useUploadStore((state) => state.cancel)
  const retry = useUploadStore((state) => state.retry)
  const remove = useUploadStore((state) => state.remove)
  const clearCompleted = useUploadStore((state) => state.clearCompleted)
  const duplicatePolicy = useUploadStore((state) => state.duplicatePolicy)
  const setDuplicatePolicy = useUploadStore((state) => state.setDuplicatePolicy)
  const [dragging, setDragging] = useState(false)
  const activeJobs = jobs.filter((job) => !['done', 'cancelled', 'skipped'].includes(job.state))
  return <>
    <div className="upload-intro"><div><p className="eyebrow">LƯU TRỰC TIẾP VÀO GOOGLE DRIVE</p><p>MP3, WAV, FLAC, AAC, M4A, OGG và các định dạng âm thanh phổ biến. File lớn được chia thành từng phần; khả năng phát phụ thuộc codec của trình duyệt.</p></div><div className="upload-security"><Shield size={15} /><span>Quyền nghe do Google Drive kiểm soát.</span></div></div>
    {!owner ? <div className="access-card compact-access"><h3>Chỉ chủ thư viện có thể tải nhạc lên.</h3><p>Vai trò được xác nhận từ Google Drive. Quyền đọc bổ sung không nâng tài khoản thành chủ sở hữu.</p></div> : !canUpload ? <div className="access-card compact-access"><h3>Cấp quyền quản lý thư mục cho ứng dụng.</h3><p>{!folder?.isAppAuthorized ? 'Bạn là chủ thư mục, nhưng quyền đọc bổ sung chưa cho phép ứng dụng upload vào thư mục này. Hãy chọn thư mục gốc bằng Google Picker.' : 'Google Drive chưa cấp khả năng thêm file vào thư mục này.'}</p>{!folder?.isAppAuthorized && <button className="button button-secondary" disabled={processing || !hasPickerConfiguration()} onClick={() => void authorize()}>Chọn thư mục gốc trên Google Drive</button>}<FolderPickerHint />{!hasPickerConfiguration() && <p>Cần cấu hình Google Picker API Key và Project Number theo README.</p>}</div> : <>
      <label className={`drop-zone ${dragging ? 'is-dragging' : ''}`} htmlFor="audio-files" onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)) }}><input id="audio-files" type="file" accept="audio/*,.mp3,.wav,.flac,.aac,.m4a,.ogg,.opus,.aiff,.alac" multiple onChange={(event) => { if (event.target.files) addFiles(Array.from(event.target.files)); event.target.value = '' }} /><span className="drop-icon"><Upload size={23} /></span><strong>Kéo nhạc vào đây <span>hoặc chọn tệp</span></strong><small>Có thể tải nhiều file cùng lúc · Upload từng phần 8 MiB</small><span className="button button-secondary">Chọn file từ thiết bị</span></label>
      <div className="upload-info-bar"><span><FileAudio size={15} />Lưu trong {folder?.name || 'thư mục đã cấu hình'}</span><label>File trùng tên: <select aria-label="Xử lý file trùng tên" disabled={processing} value={duplicatePolicy} onChange={(event) => setDuplicatePolicy(event.target.value as 'keep' | 'skip')}><option value="keep">Giữ cả hai, thêm hậu tố</option><option value="skip">Bỏ qua</option></select></label></div>
    </>}
    {jobs.length > 0 && <section className="upload-queue"><div className="queue-heading"><div><p className="eyebrow">TIẾN TRÌNH</p><h2>Hàng đợi upload <span>{activeJobs.length}</span></h2></div><div className="queue-actions"><button className="text-button" onClick={clearCompleted}>Dọn file đã hoàn tất</button>{canUpload && jobs.some((job) => ['queued', 'paused', 'needsAuth'].includes(job.state)) && <button className="button button-primary small-button" disabled={processing} onClick={() => void (jobs.some((job) => job.state === 'needsAuth') ? reconnectAndResume() : start())}>{jobs.some((job) => job.state === 'needsAuth') ? 'Kết nối lại để tiếp tục' : 'Bắt đầu / tiếp tục'}</button>}</div></div>
      <div className="upload-jobs">{jobs.map((job) => <div className="upload-job" key={job.id}>
        <CoverArt track={{ id: job.id, name: job.file.name, mimeType: job.file.type, size: job.file.size, createdTime: '', modifiedTime: '' }} />
        <div className="job-info"><strong title={job.file.name}>{job.file.name}</strong><span>{formatBytes(job.file.size)} <i /> {uploadEtaText(job)}</span><div className="progress-track" role="progressbar" aria-label={`Drive đã xác nhận ${job.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(uploadProgress(job))}><span style={{ width: `${uploadProgress(job)}%` }} /></div>
          {['uploading', 'retrying', 'paused', 'needsAuth'].includes(job.state) && <small>Drive đã nhận {formatBytes(job.confirmedBytes)} · Đang gửi {formatBytes(Math.max(0, job.sentBytes - job.confirmedBytes))}</small>}
          {job.error && <small role="alert">{job.error.message} {job.error.recovery}</small>}
        </div>
        <div className="job-progress">{job.state === 'done' ? <BadgeCheck size={19} /> : job.state === 'skipped' ? <span>Bỏ qua</span> : <span>{Math.floor(uploadProgress(job))}%</span>}
          {job.state === 'error' && canRetryUploadJob(job) && <button className="retry-button" onClick={() => retry(job.id)}>Thử lại</button>}
          {['uploading', 'retrying', 'paused', 'needsAuth'].includes(job.state) ? <button onClick={() => cancel(job.id)} aria-label={`Hủy upload ${job.file.name}`}><X size={15} /></button> : <button onClick={() => remove(job.id)} aria-label={`Xóa khỏi hàng đợi ${job.file.name}`}><X size={15} /></button>}
        </div>
      </div>)}</div>
      <p className="sync-detail">Đóng hoặc tải lại tab sẽ dừng upload và mất phiên tiếp tục trong bộ nhớ.</p>
    </section>}
  </>
}

function SettingsPage() {
  const user = useLibraryStore((state) => state.user)
  const accountBusy = useLibraryStore((state) => state.busy)
  const folder = useLibraryStore((state) => state.folder)
  const tracks = useLibraryStore((state) => state.tracks)
  const members = useLibraryStore((state) => state.members)
  const loadMembers = useLibraryStore((state) => state.loadMembers)
  const invite = useLibraryStore((state) => state.invite)
  const removeMember = useLibraryStore((state) => state.removeMember)
  const [email, setEmail] = useState('')
  const [inviteError, setInviteError] = useState('')
  const [busy, setBusy] = useState(false)
  const memberBusy = busy || !folder?.isAppAuthorized
  useEffect(() => { if (folder?.ownedByMe && folder.canShare) void loadMembers().catch(reportError) }, [folder?.folderId, folder?.ownedByMe, folder?.canShare, loadMembers])
  async function submitInvite(event: React.FormEvent) {
    event.preventDefault()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setInviteError('Nhập địa chỉ email hợp lệ.'); return }
    setBusy(true); setInviteError('')
    try { await invite(email); setEmail('') } catch (error) { setInviteError(error instanceof Error ? error.message : 'Không thể mời tài khoản này.') } finally { setBusy(false) }
  }
  async function remove(member: LibraryMember) {
    if (member.inherited || !window.confirm(`Thu hồi quyền của ${member.email || member.name || member.type}?`)) return
    setBusy(true); setInviteError('')
    try { await removeMember(member.id) } catch (error) { setInviteError(error instanceof Error ? error.message : 'Không thể thu hồi quyền.') } finally { setBusy(false) }
  }
  const broadPermissions = members.filter((member) => member.type === 'anyone' || member.type === 'domain')
  return <div className="settings-grid">
    <section className="settings-card account-settings"><div className="settings-card-heading"><div><span className="settings-icon"><Shield size={17} /></span><div><p className="eyebrow">TÀI KHOẢN GOOGLE</p><h2>Quyền riêng tư</h2></div></div></div><div className="profile-line"><span className="profile-avatar">{user?.displayName?.slice(0, 1) || 'M'}</span><span><strong>{user?.displayName || 'Google user'}</strong><small>{user?.emailAddress}</small></span></div><div className="settings-fact"><span>VAI TRÒ CỦA BẠN</span><strong>{folder?.ownedByMe ? 'Chủ sở hữu thư viện' : 'Người nghe được mời'}</strong></div><p className="settings-note">Ứng dụng quản lý file trong thư mục đã cấu hình. Nếu cấp drive.readonly, quyền OAuth cho phép đọc toàn bộ Drive dù ứng dụng chỉ truy vấn thư viện.</p><p className="settings-note">Tài khoản được ghi nhớ trên thiết bị này. Bấm tên hoặc avatar để mở cài đặt; chỉ nút Đăng xuất mới kết thúc phiên. Khi tải lại trang hoặc hết phiên Google, bấm Tiếp tục hoặc Kết nối lại.</p><div className="account-actions"><button className="button button-secondary" disabled={accountBusy} onClick={() => void reconnectAndResume()}><RefreshCw size={15} />Kết nối lại</button><button className="button button-quiet" disabled={accountBusy} onClick={() => void useLibraryStore.getState().switchAccount()}>Đổi tài khoản</button><button className="button button-quiet" onClick={disconnectAccount}><LogOut size={15} />Đăng xuất</button><button className="text-button" onClick={() => { if (window.confirm('Thu hồi quyền Google đã cấp cho CBM Sound? Bạn sẽ cần cấp lại quyền khi kết nối lần sau.')) void revokeGoogleAccess().then(disconnectAccount).catch(reportError) }}>Thu hồi quyền ứng dụng</button></div></section>
    <section className="settings-card folder-settings"><div className="settings-card-heading"><div><span className="settings-icon"><Cloud size={17} /></span><div><p className="eyebrow">VỊ TRÍ LƯU TRỮ</p><h2>Google Drive</h2></div></div></div><div className="folder-summary"><span className="folder-icon"><Library size={19} /></span><span><strong>{folder?.name || 'Thư mục gốc'}</strong><small>{formatBytes(tracks.filter((track) => !track.unavailable).reduce((sum, track) => sum + track.size, 0))} nhạc trong thư viện</small></span></div><div className="settings-fact"><span>MÃ THƯ MỤC</span><div className="copy-field"><code>{folder?.folderId}</code><button onClick={() => void copyText(folder?.folderId || '')}>Sao chép</button></div></div><a className="text-button" target="_blank" rel="noreferrer" href={`https://drive.google.com/drive/folders/${folder?.folderId}`}>Mở thư mục trên Drive ↗</a><p className="settings-note">Thư viện gồm nhạc tải qua CBM Sound và nhạc có sẵn trong thư mục gốc. Nhạc có sẵn chỉ được nghe và thêm vào playlist; đổi tên hoặc xóa bằng Google Drive.</p></section>
    {folder?.ownedByMe && !folder.isAppAuthorized && <section className="settings-card"><h2>Cấp quyền thư mục cho ứng dụng</h2><p className="settings-note">Quyền đọc cho phép xem thư viện. Để upload và quản lý thành viên, chọn đúng thư mục gốc qua Google Picker.</p><button className="button button-secondary" disabled={busy || !hasPickerConfiguration()} onClick={() => void useLibraryStore.getState().authorizeRoot()}>Chọn thư mục gốc trên Google Drive</button><FolderPickerHint />{!hasPickerConfiguration() && <p className="fine-print">Cần cấu hình Google Picker API Key và Project Number theo README.</p>}</section>}
    {folder?.ownedByMe && folder.canShare && <section className="settings-card members-settings"><div className="settings-card-heading member-heading"><div><span className="settings-icon"><Headphones size={17} /></span><div><p className="eyebrow">NGHE CÙNG NHAU</p><h2>Thành viên thư viện</h2></div></div><button className="text-button" disabled={busy} onClick={() => void loadMembers().catch(reportError)}><RefreshCw size={14} />Làm mới</button></div><form className="invite-form" onSubmit={(event) => void submitInvite(event)}><label className="sr-only" htmlFor="invite-email">Email Google</label><input id="invite-email" type="email" disabled={memberBusy} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email tài khoản Google" /><button className="button button-primary" disabled={memberBusy || !email.trim()}><Plus size={15} />{busy ? 'Đang xử lý…' : 'Mời nghe'}</button></form>{inviteError && <p role="alert" className="inline-error invite-error">{inviteError}</p>}{broadPermissions.length > 0 && <p role="alert" className="inline-error">Thư mục có quyền {broadPermissions.map((permission) => permission.type === 'anyone' ? 'bất kỳ ai có liên kết' : 'toàn miền').join(', ')}. Kiểm tra hoặc thu hồi các quyền này nếu muốn giới hạn người nghe.</p>}<p className="members-help">Lời mời cấp quyền reader và không gửi email. Nếu OAuth đang ở Testing, người nghe còn cần được thêm vào Test users trong Google Cloud.</p><div className="members-list">{members.length ? members.map((member) => <MemberRow key={member.id} member={member} busy={memberBusy} onRemove={() => remove(member)} />) : <div className="members-empty">Chưa tải được danh sách thành viên.</div>}</div><button className="copy-link" onClick={() => void copyText(location.origin + location.pathname + '#/home')}><span><span className="link-mark">↗</span><span><strong>Sao chép liên kết website</strong><small>Gửi cho tài khoản đã được mời</small></span></span><span>Sao chép</span></button></section>}
    <section className="settings-card limitations-card"><div className="settings-card-heading"><div><span className="settings-icon"><Activity size={17} /></span><div><p className="eyebrow">VỀ THƯ VIỆN</p><h2>Một vài lưu ý</h2></div></div></div><ul><li>File lớn cần trình duyệt và Drive hỗ trợ Range. Chỉ fallback tải toàn file khi không quá 32 MiB.</li><li>Playlist và lịch sử nghe lưu riêng theo tài khoản trên thiết bị này.</li><li>Đóng tab dừng upload; phiên xác thực hết hạn cần bấm Kết nối lại.</li><li>Người có quyền đọc có thể tải nhạc theo các quyền Google đã cấp.</li></ul></section>
  </div>
}

function MemberRow({ member, busy, onRemove }: { member: LibraryMember; busy: boolean; onRemove: () => Promise<void> }) {
  const label = member.type === 'anyone' ? 'Bất kỳ ai có liên kết' : member.type === 'domain' ? member.name || member.email || 'Toàn miền' : member.name || member.email || 'Tài khoản Google'
  return <div className="member-row"><span className="member-avatar">{label.slice(0, 1).toUpperCase()}</span><span className="member-info"><strong>{label}</strong><small>{member.email || member.type}</small></span><span className="member-role">{member.isOwner ? 'Chủ sở hữu' : member.role === 'reader' ? 'Chỉ nghe' : member.role}</span>{member.isOwner ? <span className="owner-badge">CHỦ SỞ HỮU</span> : member.inherited ? <span className="inherited-tag">Kế thừa</span> : <button disabled={busy} className="remove-member" onClick={() => void onRemove()} aria-label={`Thu hồi quyền ${label}`}><X size={15} /></button>}</div>
}

function PlaylistsPage() {
  const playlists = useLibraryStore((state) => state.playlists)
  const tracks = useLibraryStore((state) => state.tracks)
  const deletePlaylist = useLibraryStore((state) => state.deletePlaylist)
  const toggleTrack = useLibraryStore((state) => state.togglePlaylistTrack)
  const play = usePlayerStore((state) => state.play)
  return <><div className="playlist-page-action"><span>Playlist chỉ hiển thị trên thiết bị và tài khoản Google này.</span><button className="button button-primary" onClick={() => createNewPlaylist()}><Plus size={15} />Tạo playlist</button></div>{playlists.length ? <div className="playlist-grid">{playlists.map((playlist, index) => {
    const songs = playlist.trackIds.map((id) => tracks.find((track) => track.id === id)).filter((track): track is DriveTrack => Boolean(track && !track.unavailable && isSupportedAudio(track)))
    return <article className="playlist-card" key={playlist.id}><button disabled={!songs.length} className={`playlist-art playlist-art-${index % 4}`} aria-label={`Phát ${playlist.name}`} onClick={() => { if (songs.length) void play(songs[0], songs) }}><Disc3 size={32} /><span className="playlist-art-play"><Play size={17} fill="currentColor" /></span></button><div className="playlist-card-info"><strong>{playlist.name}</strong><small>{songs.length} bài khả dụng{playlist.trackIds.length > songs.length && ` · ${playlist.trackIds.length - songs.length} bài thiếu`}</small></div><button className="playlist-delete" aria-label={`Xóa playlist ${playlist.name}`} onClick={() => { if (window.confirm(`Xóa playlist “${playlist.name}”?`)) void deletePlaylist(playlist.id).catch(reportError) }}><X size={15} /></button><div className="playlist-tracks">{playlist.trackIds.map((id) => { const track = tracks.find((item) => item.id === id); const unavailable = !track || track.unavailable; return <div className="playlist-song" key={id}><button disabled={unavailable} onClick={() => { if (track) void play(track, songs) }}>{unavailable ? 'Bài không còn khả dụng' : track.name.replace(/\.[^/.]+$/, '')}</button><button aria-label={`Gỡ ${track?.name || 'bài thiếu'} khỏi ${playlist.name}`} onClick={() => void toggleTrack(playlist.id, id).catch(reportError)}><X size={12} /></button></div> })}</div></article>
  })}</div> : <div className="empty-state"><div className="empty-artwork"><ListMusic size={25} /></div><p className="eyebrow">NHỮNG TUYỂN TẬP RIÊNG</p><h3>Tạo playlist theo tâm trạng.</h3><p>Sắp xếp bài hát thành một tuyển tập riêng.</p><button className="button button-primary" onClick={() => createNewPlaylist()}><Plus size={15} />Tạo playlist đầu tiên</button></div>}</>
}

function RecentPage() {
  const recentIds = useLibraryStore((state) => state.recentTrackIds)
  const tracks = useLibraryStore((state) => state.tracks)
  const recent = useMemo(() => recentIds.map((id) => tracks.find((track) => track.id === id)).filter((track): track is DriveTrack => Boolean(track && !track.unavailable)), [recentIds, tracks])
  return recent.length ? <TrackTable tracks={recent} showDate={false} /> : <div className="empty-state"><div className="empty-artwork"><Clock3 size={25} /></div><p className="eyebrow">NGHE GẦN ĐÂY</p><h3>Những giai điệu sẽ hiện ở đây.</h3><p>Mở một bài hát để tạo lịch sử nghe riêng trên thiết bị này.</p><a className="button button-secondary" href="#/library">Mở thư viện</a></div>
}

function PlayerBar() {
  const track = usePlayerStore((state) => state.currentTrack)
  const queue = usePlayerStore((state) => state.queue)
  const playing = usePlayerStore((state) => state.isPlaying)
  const loading = usePlayerStore((state) => state.loading)
  const needsAuth = usePlayerStore((state) => state.needsAuth)
  const time = usePlayerStore((state) => state.currentTime)
  const duration = usePlayerStore((state) => state.duration)
  const volume = usePlayerStore((state) => state.volume)
  const muted = usePlayerStore((state) => state.isMuted)
  const shuffle = usePlayerStore((state) => state.shuffle)
  const repeat = usePlayerStore((state) => state.repeat)
  const error = usePlayerStore((state) => state.error)
  const toggle = usePlayerStore((state) => state.toggle)
  const next = usePlayerStore((state) => state.next)
  const previous = usePlayerStore((state) => state.previous)
  const seek = usePlayerStore((state) => state.seek)
  const setVolume = usePlayerStore((state) => state.setVolume)
  const toggleMute = usePlayerStore((state) => state.toggleMute)
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle)
  const cycleRepeat = usePlayerStore((state) => state.cycleRepeat)
  const [expanded, setExpanded] = useState(false)
  const progress = duration > 0 ? Math.min(100, time / duration * 100) : 0
  return <><div className={`player-bar ${expanded ? 'player-expanded' : ''}`}>
    <div className="now-playing">{track ? <><button className="mobile-expand-cover" aria-label={expanded ? 'Thu gọn trình phát' : 'Mở trình phát và hàng đợi'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><CoverArt track={track} /></button><div className="now-info"><strong title={track.name}>{track.name.replace(/\.[^/.]+$/, '')}</strong><small>{loading ? 'Đang chuẩn bị âm thanh…' : track.artist || 'Chưa rõ nghệ sĩ'}</small></div><button className="player-heart" title="Thêm vào playlist" aria-label="Thêm bài đang phát vào playlist" onClick={() => createNewPlaylist(track.id)}><Heart size={16} /></button></> : <><span className="no-track-icon"><Headphones size={17} /></span><div className="now-info"><strong>Âm thanh của riêng bạn</strong><small>Chọn một bài hát để bắt đầu</small></div></>}</div>
    <div className="player-center"><div className="play-controls"><button className={`shuffle-control ${shuffle ? 'control-active' : ''}`} aria-label="Phát ngẫu nhiên" aria-pressed={shuffle} onClick={toggleShuffle}><Shuffle size={16} /></button><button className="skip-control" aria-label="Bài trước" disabled={!track} onClick={previous}><SkipBack size={17} fill="currentColor" /></button><button className="main-play" aria-label={loading ? 'Hủy tải bài' : playing ? 'Tạm dừng' : 'Phát'} disabled={!track} onClick={() => loading ? usePlayerStore.getState().pause() : toggle()}>{playing ? <span className="pause-mark">Ⅱ</span> : <Play size={16} fill="currentColor" />}</button><button className="skip-control" aria-label="Bài tiếp theo" disabled={!track} onClick={() => next()}><SkipForward size={17} fill="currentColor" /></button><button className={`repeat-control ${repeat !== 'off' ? 'control-active' : ''}`} aria-label={`Lặp lại: ${repeat === 'off' ? 'tắt' : repeat === 'one' ? 'một bài' : 'tất cả'}`} onClick={cycleRepeat}><span className="repeat-icon">↻</span>{repeat === 'one' && <i>1</i>}</button></div>
      <div className="seek-row"><time>{formatTime(time)}</time><input aria-label="Vị trí phát" type="range" min={0} max={Math.max(1, duration)} step="0.25" value={Math.min(time, duration || 0)} style={{ '--range-progress': `${progress}%` } as React.CSSProperties} onChange={(event) => seek(Number(event.target.value))} disabled={!track || !duration} /><time>{formatTime(duration)}</time></div>
      {error && <div className="player-error" role="alert"><span>{error}</span>{needsAuth && <button onClick={() => void reconnectAndResume()}>Kết nối lại</button>}<button aria-label="Đóng lỗi trình phát" onClick={() => usePlayerStore.getState().clearError()}><X size={12} /></button></div>}
    </div>
    <div className="player-right"><button className="queue-toggle" aria-label={expanded ? 'Đóng hàng đợi' : 'Mở hàng đợi'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><ListMusic size={17} /></button><div className="volume-control"><button aria-label={muted ? 'Bỏ tắt tiếng' : 'Tắt tiếng'} onClick={toggleMute}>{muted || volume === 0 ? <VolumeX size={17} /> : volume < 0.55 ? <Volume1 size={17} /> : <Volume2 size={17} />}</button><input aria-label="Âm lượng" type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume} onChange={(event) => setVolume(Number(event.target.value))} style={{ '--range-progress': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties} /></div></div>
  </div>{expanded && <div className="queue-panel"><div className="queue-heading"><div><p className="eyebrow">ĐANG PHÁT / HÀNG ĐỢI</p><h2>{track?.name.replace(/\.[^/.]+$/, '') || 'Chọn bài hát'}</h2></div><button className="icon-button" onClick={() => setExpanded(false)} aria-label="Đóng trình phát mở rộng"><X size={17} /></button></div><div className="mobile-player-options"><button className="button button-quiet" aria-pressed={shuffle} onClick={toggleShuffle}><Shuffle size={16} />{shuffle ? 'Ngẫu nhiên bật' : 'Ngẫu nhiên tắt'}</button><button className="button button-quiet" onClick={cycleRepeat}>Lặp: {repeat === 'off' ? 'tắt' : repeat === 'one' ? 'một bài' : 'tất cả'}</button><div className="volume-control"><button aria-label={muted ? 'Bỏ tắt tiếng trên trình phát mở rộng' : 'Tắt tiếng trên trình phát mở rộng'} onClick={toggleMute}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button><input aria-label="Âm lượng trình phát mở rộng" type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(event) => setVolume(Number(event.target.value))} /></div></div>{queue.filter((item) => !item.unavailable).map((item, index) => <QueueRow key={item.id} track={item} index={index} active={item.id === track?.id} />)}{queue.length === 0 && <p className="sync-detail">Hàng đợi đang trống.</p>}</div>}</>
}

function QueueRow({ track, index, active }: { track: DriveTrack; index: number; active: boolean }) {
  const play = usePlayerStore((state) => state.play)
  const queue = usePlayerStore((state) => state.queue)
  return <button className={`queue-row ${active ? 'is-current' : ''}`} onClick={() => void play(track, queue)}><span>{active ? <AudioLines size={14} /> : String(index + 1).padStart(2, '0')}</span><CoverArt track={track} /><span className="queue-title"><strong>{track.name.replace(/\.[^/.]+$/, '')}</strong><small>{track.name}</small></span><span>{track.duration ? formatTime(track.duration) : ''}</span></button>
}

function createNewPlaylist(trackId?: string) {
  const name = window.prompt('Đặt tên cho playlist mới')
  if (!name?.trim()) return
  void useLibraryStore.getState().createPlaylist(name).then(async () => {
    if (trackId) {
      const playlist = useLibraryStore.getState().playlists[0]
      if (playlist) await useLibraryStore.getState().togglePlaylistTrack(playlist.id, trackId)
    }
  }).catch(reportError)
}

function reportError(error: unknown) {
  useLibraryStore.getState().setError(error instanceof Error ? error.message : 'Không thể hoàn tất thao tác. Hãy thử lại.')
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); useLibraryStore.getState().setNotice('Đã sao chép.') } catch { reportError(new Error('Trình duyệt không cho phép sao chép. Hãy chọn và sao chép nội dung thủ công.')) }
}

function disconnectAccount() {
  usePlayerStore.getState().stop()
  useLibraryStore.getState().disconnect()
  location.hash = '#/home'
}

async function reconnectAndResume() {
  try {
    await useLibraryStore.getState().reconnect()
    if (useLibraryStore.getState().status !== 'ready') return
    const tasks = [usePlayerStore.getState().resumeAfterAuth()]
    if (useUploadStore.getState().jobs.some((job) => job.state === 'needsAuth' || job.state === 'paused')) tasks.push(useUploadStore.getState().start())
    for (const result of await Promise.allSettled(tasks)) if (result.status === 'rejected') reportError(result.reason)
  } catch (error) { reportError(error) }
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'chưa xác định' : date.toLocaleString('vi-VN')
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('vi-VN', { day: 'numeric', month: 'short', year: '2-digit' }).format(date)
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}
