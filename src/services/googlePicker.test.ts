import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const token = vi.hoisted(() => ({ getValidToken: vi.fn() }))
vi.mock('./auth', () => token)

let callback: (response: { action: string; docs?: Array<{ id: string; mimeType: string }> }) => void
const viewCalls = { fileIds: vi.fn(), mimeTypes: vi.fn(), selectFolders: vi.fn() }
const pickerInstance = { setVisible: vi.fn(), dispose: vi.fn() }

function fakePicker() {
  class DocsView {
    setIncludeFolders() { return this }
    setSelectFolderEnabled(value: boolean) { viewCalls.selectFolders(value); return this }
    setMimeTypes(value: string) { viewCalls.mimeTypes(value); return this }
    setFileIds(value: string) { viewCalls.fileIds(value); return this }
    setMode() { return this }
  }
  class PickerBuilder {
    addView() { return this }
    setOAuthToken() { return this }
    setDeveloperKey() { return this }
    setAppId() { return this }
    setOrigin() { return this }
    setTitle() { return this }
    setLocale() { return this }
    setCallback(value: typeof callback) { callback = value; return this }
    build() { return pickerInstance }
  }
  Object.assign(window, { google: { picker: {
    DocsView, PickerBuilder, ViewId: { FOLDERS: 'folders' }, DocsViewMode: { LIST: 'list' }, Action: { PICKED: 'picked', CANCEL: 'cancel' },
  } } })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_GOOGLE_PICKER_API_KEY', 'test-key')
  vi.stubEnv('VITE_GOOGLE_CLOUD_PROJECT_NUMBER', '12345')
  Object.values(viewCalls).forEach((mock) => mock.mockReset())
  Object.values(pickerInstance).forEach((mock) => mock.mockReset())
  token.getValidToken.mockResolvedValue('test-token')
  fakePicker()
})
afterEach(() => { vi.unstubAllEnvs(); window.google = undefined })

describe('root folder Picker authorization', () => {
  it('restricts the Picker to exactly the configured folder', async () => {
    const picker = await import('./googlePicker')
    const selected = picker.authorizeLibraryFolder('configured-root')
    await vi.waitFor(() => expect(pickerInstance.setVisible).toHaveBeenCalledWith(true))
    expect(viewCalls.fileIds).toHaveBeenCalledWith('configured-root')
    expect(viewCalls.mimeTypes).toHaveBeenCalledWith('application/vnd.google-apps.folder')
    callback({ action: 'picked', docs: [{ id: 'configured-root', mimeType: 'application/vnd.google-apps.folder' }] })
    await expect(selected).resolves.toBeUndefined()
    expect(pickerInstance.dispose).toHaveBeenCalledTimes(1)
  })

  it('never changes the shared root if another folder is returned', async () => {
    const picker = await import('./googlePicker')
    const selected = picker.authorizeLibraryFolder('configured-root')
    const rejected = expect(selected).rejects.toThrow('không phải thư viện gốc')
    await vi.waitFor(() => expect(pickerInstance.setVisible).toHaveBeenCalledWith(true))
    callback({ action: 'picked', docs: [{ id: 'other-root', mimeType: 'application/vnd.google-apps.folder' }] })
    await rejected
  })

  it('disposes the Picker and rejects a pending selection on logout', async () => {
    const picker = await import('./googlePicker')
    const session = await import('./session')
    const selected = picker.authorizeLibraryFolder('configured-root')
    const rejected = expect(selected).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(pickerInstance.setVisible).toHaveBeenCalledWith(true))
    session.invalidateSession()
    callback({ action: 'picked', docs: [{ id: 'configured-root', mimeType: 'application/vnd.google-apps.folder' }] })
    await rejected
    expect(pickerInstance.dispose).toHaveBeenCalledTimes(1)
  })

  it('explains missing API key/project config before trying any token request', async () => {
    vi.stubEnv('VITE_GOOGLE_PICKER_API_KEY', '')
    token.getValidToken.mockClear()
    const picker = await import('./googlePicker')
    expect(picker.hasPickerConfiguration()).toBe(false)
    await expect(picker.authorizeLibraryFolder('configured-root')).rejects.toMatchObject({ reason: 'pickerNotConfigured' })
    expect(token.getValidToken).not.toHaveBeenCalled()
  })
})
