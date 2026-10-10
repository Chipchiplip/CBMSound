import { appError } from '../types'
import { getValidToken } from './auth'
import { assertSessionCurrent, getSessionGeneration, subscribeSessionReset } from './session'

interface PickerResponse { action?: string; docs?: Array<{ id?: string; mimeType?: string }> }
interface PickerInstance { setVisible: (visible: boolean) => void; dispose: () => void }
interface PickerView {
  setIncludeFolders: (value: boolean) => PickerView
  setSelectFolderEnabled: (value: boolean) => PickerView
  setMimeTypes: (value: string) => PickerView
  setFileIds: (value: string) => PickerView
  setMode: (value: string) => PickerView
}
interface PickerBuilder {
  addView: (view: PickerView) => PickerBuilder
  setOAuthToken: (token: string) => PickerBuilder
  setDeveloperKey: (key: string) => PickerBuilder
  setAppId: (projectNumber: string) => PickerBuilder
  setOrigin: (origin: string) => PickerBuilder
  setTitle: (title: string) => PickerBuilder
  setLocale: (locale: string) => PickerBuilder
  setCallback: (callback: (response: PickerResponse) => void) => PickerBuilder
  build: () => PickerInstance
}
interface PickerAPI {
  DocsView: new (viewId?: string) => PickerView
  PickerBuilder: new () => PickerBuilder
  ViewId: { FOLDERS: string }
  DocsViewMode: { LIST: string }
  Action: { PICKED: string; CANCEL: string }
}
interface APIWindow {
  gapi?: { load: (module: string, options: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }) => void }
  google?: { picker?: PickerAPI }
}

const developerKey = (import.meta.env.VITE_GOOGLE_PICKER_API_KEY as string | undefined)?.trim()
const projectNumber = (import.meta.env.VITE_GOOGLE_CLOUD_PROJECT_NUMBER as string | undefined)?.trim()
let pickerLibrary: Promise<void> | undefined

function pickerWindow(): APIWindow { return window as unknown as APIWindow }

export function hasPickerConfiguration(): boolean { return Boolean(developerKey && projectNumber && /^\d+$/.test(projectNumber)) }

function preparePicker(): Promise<void> {
  if (pickerWindow().google?.picker) return Promise.resolve()
  if (pickerLibrary) return pickerLibrary
  const pending = new Promise<void>((resolve, reject) => {
    let script: HTMLScriptElement | undefined
    let done = false
    const cleanup = () => {
      clearTimeout(timeout)
      script?.removeEventListener('load', loadModule)
      script?.removeEventListener('error', fail)
    }
    const fail = () => {
      if (done) return
      done = true
      cleanup()
      script?.remove()
      pickerLibrary = undefined
      reject(appError('Không tải được Google Picker.', { retryable: true, recovery: 'Kiểm tra kết nối và quyền Google Picker API, rồi thử cấp quyền thư mục lại.' }))
    }
    const success = () => {
      if (done) return
      if (!pickerWindow().google?.picker) { fail(); return }
      done = true
      cleanup()
      resolve()
    }
    const loadModule = () => pickerWindow().gapi?.load('picker', { callback: success, onerror: fail, timeout: 15000, ontimeout: fail })
    const timeout = setTimeout(fail, 20000)
    if (pickerWindow().gapi) loadModule()
    else {
      document.querySelector<HTMLScriptElement>('script[data-google-picker]')?.remove()
      script = document.createElement('script')
      script.dataset.googlePicker = 'true'
      script.src = 'https://apis.google.com/js/api.js'
      script.async = true
      script.defer = true
      script.addEventListener('load', loadModule)
      script.addEventListener('error', fail)
      document.head.appendChild(script)
    }
  })
  pickerLibrary = pending
  return pending
}

// Picker is a real per-file authorization step for drive.file. It never changes
// Drive sharing/ownership. Restrict the view and validate the returned folder ID
// so this shared website cannot silently switch to another person's library.
export async function authorizeLibraryFolder(folderId: string): Promise<void> {
  if (!hasPickerConfiguration()) throw appError('Website chưa cấu hình Google Picker để cấp quyền thư mục có sẵn.', {
    reason: 'pickerNotConfigured',
    recovery: 'Bật Google Picker API, đặt VITE_GOOGLE_PICKER_API_KEY và VITE_GOOGLE_CLOUD_PROJECT_NUMBER trong cùng project OAuth rồi build lại. Không cần Client Secret.',
  })
  const generation = getSessionGeneration()
  const token = await getValidToken()
  await preparePicker()
  assertSessionCurrent(generation)
  const api = pickerWindow().google!.picker!
  await new Promise<void>((resolve, reject) => {
    let picker: PickerInstance | undefined
    let finished = false
    let unsubscribe = () => {}
    const finish = (error?: unknown) => {
      if (finished) return
      finished = true
      unsubscribe()
      picker?.setVisible(false)
      picker?.dispose()
      if (error) reject(error)
      else resolve()
    }
    unsubscribe = subscribeSessionReset(() => finish(new DOMException('Đã hủy cấp quyền thư mục.', 'AbortError')))
    try {
      const view = new api.DocsView(api.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes('application/vnd.google-apps.folder')
        .setMode(api.DocsViewMode.LIST)
        .setFileIds(folderId)
      picker = new api.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(developerKey!)
        .setAppId(projectNumber!)
        .setOrigin(window.location.origin)
        .setTitle('Chọn dòng thư mục gốc một lần rồi bấm Chọn')
        .setLocale('vi')
        .setCallback((response) => {
          if (response.action === api.Action.CANCEL) finish(appError('Bạn đã hủy chọn thư mục.', { reason: 'pickerCancelled' }))
          if (response.action !== api.Action.PICKED) return
          const selected = response.docs?.[0]
          if (selected?.id !== folderId || selected.mimeType && selected.mimeType !== 'application/vnd.google-apps.folder') {
            finish(appError('Thư mục được chọn không phải thư viện gốc đã cấu hình.', { recovery: `Chọn đúng thư mục có ID ${folderId}.` }))
          } else finish()
        })
        .build()
      picker.setVisible(true)
    } catch (error) { finish(error) }
  })
  assertSessionCurrent(generation)
}
