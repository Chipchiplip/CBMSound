import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appError, type DriveTrack, type UploadResumeState } from '../types'
import { uploadFileResumable, type UploadCallbacks } from './upload'
import { getFileMetadata } from './drive'
import { getTokenState, getValidToken, invalidateAccessToken } from './auth'

vi.mock('./auth', () => ({ getTokenState: vi.fn(), getValidToken: vi.fn(), invalidateAccessToken: vi.fn() }))
vi.mock('./drive', () => ({ getFileMetadata: vi.fn() }))

interface RequestRecord { method: string; url: string; headers: Record<string, string>; body: Blob | string | null }
interface ResponseStep { status?: number; headers?: Record<string, string>; body?: string; error?: boolean; hang?: boolean }
const responses: ResponseStep[] = []
const requests: RequestRecord[] = []
const sessionUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test'

class FakeXHR {
  method = ''
  url = ''
  headers: Record<string, string> = {}
  status = 0
  responseText = ''
  timeout = 0
  responseType = ''
  upload: { onprogress?: (event: ProgressEvent) => void } = {}
  onload?: () => void
  onerror?: () => void
  ontimeout?: () => void
  onabort?: () => void
  responseHeaders: Record<string, string> = {}
  aborted = false
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(name: string, value: string) { this.headers[name] = value }
  getResponseHeader(name: string) { return this.responseHeaders[name] || null }
  abort() { this.aborted = true; this.onabort?.() }
  send(body: Blob | string | null) {
    requests.push({ method: this.method, url: this.url, headers: this.headers, body })
    const response = responses.shift()
    if (!response) throw new Error('Unexpected request in upload test')
    if (response.hang) return
    globalThis.setTimeout(() => {
      if (this.aborted) return
      if (body instanceof Blob) this.upload.onprogress?.({ loaded: body.size } as ProgressEvent)
      if (response.error) { this.onerror?.(); return }
      this.status = response.status || 200
      this.responseText = response.body || ''
      this.responseHeaders = response.headers || {}
      this.onload?.()
    }, 0)
  }
}

function file(size = 16): File { return new File([new Uint8Array(size)], 'song.mp3', { type: 'audio/mpeg' }) }
function track(size = 16): DriveTrack { return { id: 'stable-id', name: 'song.mp3', size, mimeType: 'audio/mpeg', createdTime: '2026-01-01', modifiedTime: '2026-01-01' } }
function callbacks(extra: Partial<UploadCallbacks> = {}): UploadCallbacks {
  return { onProgress: vi.fn(), onState: vi.fn(), onResume: vi.fn(), ...extra }
}
function session() { return { status: 200, headers: { Location: sessionUrl } } }
function complete(size = 16) { return { status: 201, body: JSON.stringify(track(size)) } }
function error(status: number, reason?: string, retryAfter?: string): ResponseStep {
  return { status, headers: retryAfter ? { 'Retry-After': retryAfter } : {}, body: JSON.stringify({ error: { errors: [{ reason }] } }) }
}
async function finish<T>(pending: Promise<T>): Promise<T> {
  const result = pending.then((value) => ({ value }), (cause: unknown) => ({ cause }))
  await vi.runAllTimersAsync()
  const settled = await result
  if ('cause' in settled) throw settled.cause
  return settled.value
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  responses.length = 0
  requests.length = 0
  vi.mocked(getValidToken).mockReset().mockResolvedValue('test-token')
  vi.mocked(getTokenState).mockReset().mockReturnValue(undefined)
  vi.mocked(invalidateAccessToken).mockReset()
  vi.mocked(getFileMetadata).mockReset().mockResolvedValue(track())
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('resumable uploads', () => {
  it('uses only Drive-confirmed offsets and marks new tracks for the shared library', async () => {
    responses.push(session(), { status: 308, headers: { Range: 'bytes=0-7' } }, complete())
    const cb = callbacks()
    const uploaded = await finish(uploadFileResumable(file(), 'folder', 'stable-id', cb))
    expect(uploaded.id).toBe('stable-id')
    expect(requests[1].headers['Content-Range']).toBe('bytes 0-15/16')
    expect(requests[2].headers['Content-Range']).toBe('bytes 8-15/16')
    expect(JSON.parse(requests[0].body as string)).toMatchObject({ id: 'stable-id', parents: ['folder'], properties: { cbmSoundTrack: '1' } })
    expect(cb.onProgress).toHaveBeenCalledWith(16, 0)
    expect(cb.onProgress).toHaveBeenCalledWith(8, 8)
    expect(cb.onProgress).toHaveBeenLastCalledWith(16, 16)
    expect(requests.every((request) => request.headers.Authorization === 'Bearer test-token')).toBe(true)
    expect(getValidToken).toHaveBeenCalledWith(undefined, false)
  })

  it('never advances the confirmed offset when a 308 has no Range', async () => {
    responses.push(session(), { status: 308 }, complete())
    const cb = callbacks()
    await finish(uploadFileResumable(file(), 'folder', 'stable-id', cb))
    expect(requests[2].headers['Content-Range']).toBe('bytes 0-15/16')
    expect(cb.onProgress).toHaveBeenCalledWith(0, 0)
  })

  it('bounds repeated successful responses that confirm no progress', async () => {
    responses.push(session(), ...Array.from({ length: 6 }, () => ({ status: 308 })))
    const pending = finish(uploadFileResumable(file(), 'folder', 'stable-id', callbacks()))
    await expect(pending).rejects.toThrow('không xác nhận thêm dữ liệu')
    expect(requests).toHaveLength(7)
  })

  it('uses 8 MiB chunks without claiming unsent bytes', async () => {
    const size = 8 * 1024 * 1024 + 16
    responses.push(session(), { status: 308, headers: { Range: `bytes=0-${8 * 1024 * 1024 - 1}` } }, complete(size))
    await finish(uploadFileResumable(file(size), 'folder', 'stable-id', callbacks()))
    expect((requests[1].body as Blob).size).toBe(8 * 1024 * 1024)
    expect((requests[2].body as Blob).size).toBe(16)
  })

  it('retries both session creation and offset probes after network loss', async () => {
    responses.push({ error: true }, session(), { error: true }, { error: true }, { status: 503 }, { status: 308, headers: { Range: 'bytes=0-7' } }, complete())
    await finish(uploadFileResumable(file(), 'folder', 'stable-id', callbacks()))
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2)
    expect(requests.filter((request) => request.headers['Content-Range'] === 'bytes */16')).toHaveLength(3)
    expect(requests.at(-1)?.headers['Content-Range']).toBe('bytes 8-15/16')
  })

  it('recovers a lost final response by probing, without uploading a duplicate', async () => {
    responses.push(session(), { error: true }, complete())
    const cb = callbacks()
    await finish(uploadFileResumable(file(), 'folder', 'stable-id', cb))
    expect(requests).toHaveLength(3)
    expect(requests[2].headers['Content-Range']).toBe('bytes */16')
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  })

  it('recognizes an existing completed file when retrying a stable ID returns 409', async () => {
    responses.push(error(409))
    const result = await finish(uploadFileResumable(file(), 'folder', 'stable-id', callbacks()))
    expect(result).toEqual(track())
    expect(getFileMetadata).toHaveBeenCalledWith('stable-id')
    expect(requests).toHaveLength(1)
  })

  it('checks the original file before replacing an expired session', async () => {
    vi.mocked(getFileMetadata).mockRejectedValueOnce(appError('Missing', { status: 404 }))
    const resume: UploadResumeState = { fileId: 'stable-id', sessionUrl, offset: 8, driveName: 'song.mp3' }
    responses.push(error(404), session(), complete())
    const cb = callbacks({ resume })
    await finish(uploadFileResumable(file(), 'folder', 'stable-id', cb))
    expect(requests[0].headers['Content-Range']).toBe('bytes */16')
    expect(JSON.parse(requests[1].body as string).id).toBe('stable-id')
    expect(requests[2].headers['Content-Range']).toBe('bytes 0-15/16')
    expect(cb.onResume).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'stable-id', offset: 0, sessionUrl: undefined }))
  })

  it('keeps a resumable session on 401 and does not retry until reconnect', async () => {
    responses.push(session(), error(401))
    const cb = callbacks()
    await expect(finish(uploadFileResumable(file(), 'folder', 'stable-id', cb))).rejects.toMatchObject({ status: 401, retryable: false })
    expect(cb.onState).toHaveBeenCalledWith('needsAuth')
    expect(cb.onResume).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'stable-id', sessionUrl, offset: 0 }))
    expect(invalidateAccessToken).toHaveBeenCalledWith('test-token')
    expect(requests).toHaveLength(2)
  })

  it('resumes after reconnect from the server offset instead of stale local progress', async () => {
    responses.push({ status: 308, headers: { Range: 'bytes=0-3' } }, complete())
    await finish(uploadFileResumable(file(), 'folder', 'stable-id', callbacks({ resume: { fileId: 'stable-id', sessionUrl, offset: 8 } })))
    expect(requests[1].headers['Content-Range']).toBe('bytes 4-15/16')
    expect(requests.some((request) => request.method === 'POST')).toBe(false)
  })

  it('uses a token already renewed by the user when an older request returns a late 401', async () => {
    vi.mocked(getValidToken).mockResolvedValueOnce('test-token').mockResolvedValueOnce('test-token').mockResolvedValue('renewed-token')
    vi.mocked(getTokenState).mockReturnValue({ accessToken: 'renewed-token', expiresAt: Date.now() + 3600000, scopes: [] })
    responses.push(session(), error(401), { status: 308, headers: { Range: 'bytes=0-7' } }, complete())
    const cb = callbacks()
    await finish(uploadFileResumable(file(), 'folder', 'stable-id', cb))
    expect(cb.onState).not.toHaveBeenCalledWith('needsAuth')
    expect(requests[2].headers.Authorization).toBe('Bearer renewed-token')
    expect(requests[3].headers['Content-Range']).toBe('bytes 8-15/16')
  })

  it('honors Retry-After for 403 rate limits while permission and storage failures stop', async () => {
    responses.push(session(), error(403, 'userRateLimitExceeded', '12'), { status: 308 }, complete())
    const pending = uploadFileResumable(file(), 'folder', 'stable-id', callbacks())
    await vi.advanceTimersByTimeAsync(11999)
    expect(requests).toHaveLength(2)
    await finish(pending)
    for (const reason of ['insufficientFilePermissions', 'storageQuotaExceeded']) {
      requests.length = 0
      responses.push(session(), error(403, reason))
      await expect(finish(uploadFileResumable(file(), 'folder', 'stable-id', callbacks()))).rejects.toMatchObject({ status: 403, retryable: false, reason })
      expect(requests).toHaveLength(2)
    }
  })

  it('aborts during a retry delay and never starts a later probe', async () => {
    responses.push(session(), { error: true })
    const controller = new AbortController()
    const pending = uploadFileResumable(file(), 'folder', 'stable-id', callbacks({ signal: controller.signal }))
    const assertion = expect(pending).rejects.toMatchObject({ reason: 'uploadCancelled' })
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await vi.runAllTimersAsync()
    await assertion
    expect(requests).toHaveLength(2)
  })

  it('rejects malformed confirmation ranges and does not invent a completed file', async () => {
    responses.push(session(), { status: 308, headers: { Range: 'bytes=0-999' } })
    await expect(finish(uploadFileResumable(file(), 'folder', 'stable-id', callbacks()))).rejects.toThrow('vị trí upload')
    expect(getFileMetadata).not.toHaveBeenCalled()
  })
})
