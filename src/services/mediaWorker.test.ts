// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const code = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
const file = { size: 100, mimeType: 'audio/mpeg', modifiedTime: '2026-10-10T00:00:00.000Z' }

function harness() {
  const listeners = new Map<string, (event: unknown) => void>()
  const upstream = vi.fn<typeof fetch>()
  const tab = { id: 'tab-1', postMessage: vi.fn<(message: { type: string; requestId?: string }) => void>() }
  const context = createContext({
    URL, Request, Response, ReadableStream, AbortController, DOMException, crypto,
    setTimeout, clearTimeout, fetch: upstream,
    self: {
      registration: { scope: 'https://example.com/CBMSound/' },
      clients: { get: vi.fn(async (id: string) => id === tab.id ? tab : undefined), claim: vi.fn() },
      skipWaiting: vi.fn(),
      addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    },
  })
  runInContext(code, context)
  const serve = runInContext('serveMedia', context) as (request: Request, clientId: string, id: string) => Promise<Response>
  const message = (data: object, source = tab.id) => listeners.get('message')!({ source: { id: source }, data })
  const session = (expiresAt = Date.now() + 10000) => message({ type: 'SET_SESSION', token: 'test-token', expiresAt, files: { song: file } })
  return { serve, upstream, tab, message, session, listeners }
}

function rangeResponse(start: number, end: number, size = 100): Response {
  return new Response(new Uint8Array(end - start + 1), { status: 206, headers: {
    'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1),
  } })
}

function hiddenRangeResponse(length: number, bodyLength = length): Response {
  return new Response(new Uint8Array(bodyLength), { status: 206, headers: { 'Content-Length': String(length) } })
}

function metadataResponse(overrides: object = {}): Response {
  return new Response(JSON.stringify({ size: String(file.size), modifiedTime: file.modifiedTime, trashed: false, capabilities: { canDownload: true }, ...overrides }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => vi.restoreAllMocks())

describe('private media Service Worker', () => {
  it('recovers its RAM session from the owning tab after restart', async () => {
    const worker = harness()
    worker.tab.postMessage.mockImplementation((data) => {
      if (data.type === 'REQUEST_SESSION') worker.message({ type: 'SET_SESSION', requestId: data.requestId, token: 'renewed', expiresAt: Date.now() + 10000, files: { song: file } })
    })
    worker.upstream.mockResolvedValueOnce(rangeResponse(0, 0))
    const result = await worker.serve(new Request('https://example.com/CBMSound/__cbm_media__/song', { headers: { Range: 'bytes=0-0' } }), 'tab-1', 'song')
    expect(result.status).toBe(206)
    expect(worker.tab.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'REQUEST_SESSION' }))
    expect(worker.upstream.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer renewed' }))
    await result.body?.cancel()
  })

  it('does not accept a different tab session as authentication for this request', async () => {
    const worker = harness()
    worker.session()
    const result = await worker.serve(new Request('https://example.com/media'), 'unknown-tab', 'song')
    expect(result.status).toBe(401)
    expect(worker.upstream).not.toHaveBeenCalled()
  })

  it('returns 401 and requests reconnection when the tab has no valid token', async () => {
    const worker = harness()
    worker.tab.postMessage.mockImplementation((data) => {
      if (data.type === 'REQUEST_SESSION') worker.message({ type: 'CLEAR_SESSION', requestId: data.requestId })
    })
    const result = await worker.serve(new Request('https://example.com/media'), 'tab-1', 'song')
    expect(result.status).toBe(401)
    expect(result.headers.get('X-CBM-Error')).toBe('AUTH_REQUIRED')
    expect(worker.upstream).not.toHaveBeenCalled()
  })

  it.each([['bytes=10-19', 10, 19], ['bytes=80-', 80, 99], ['bytes=-12', 88, 99]])('forwards %s as a validated upstream byte interval', async (range, start, end) => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(rangeResponse(start, end))
    const result = await worker.serve(new Request('https://example.com/media', { headers: { Range: range } }), 'tab-1', 'song')
    expect(result.status).toBe(206)
    expect(result.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/100`)
    expect(worker.upstream.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Range: `bytes=${start}-${end}` }))
    expect((await result.arrayBuffer()).byteLength).toBe(end - start + 1)
    expect(worker.upstream).toHaveBeenCalledOnce()
  })

  it('handles HEAD via a one-byte GET without depending on a Drive HEAD body', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(rangeResponse(0, 0))
    const result = await worker.serve(new Request('https://example.com/media', { method: 'HEAD' }), 'tab-1', 'song')
    expect(result.status).toBe(200)
    expect(result.body).toBeNull()
    expect(result.headers.get('Content-Length')).toBe('100')
    expect(result.headers.get('Content-Range')).toBeNull()
    expect(worker.upstream.mock.calls[0][1]?.method).toBe('GET')
    expect(worker.upstream.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Range: 'bytes=0-0' }))
  })

  it('returns 416 without network access for invalid or multipart ranges', async () => {
    const worker = harness()
    worker.session()
    const result = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=0-1,3-4' } }), 'tab-1', 'song')
    expect(result.status).toBe(416)
    expect(result.headers.get('Content-Range')).toBe('bytes */100')
    expect(worker.upstream).not.toHaveBeenCalled()
  })

  it('HEAD with a Range describes the complete GET interval while only probing one byte', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(rangeResponse(10, 10))
    const response = await worker.serve(new Request('https://example.com/media', { method: 'HEAD', headers: { Range: 'bytes=10-29' } }), 'tab-1', 'song')
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Length')).toBe('20')
    expect(response.headers.get('Content-Range')).toBe('bytes 10-29/100')
    expect(response.body).toBeNull()
  })

  it('distinguishes missing Range support so the page can offer bounded fallback', async () => {
    const worker = harness()
    worker.session()
    const cancel = vi.fn()
    worker.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 200 }))
    const result = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=0-0' } }), 'tab-1', 'song')
    expect(result.status).toBe(502)
    expect(result.headers.get('X-CBM-Error')).toBe('RANGE_NOT_SUPPORTED')
    expect(cancel).toHaveBeenCalled()
  })

  it('rejects changed files and mismatched Content-Range rather than manufacturing 206 headers', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(rangeResponse(0, 0, 101)).mockResolvedValueOnce(rangeResponse(2, 2))
    const request = new Request('https://example.com/media', { headers: { Range: 'bytes=0-0' } })
    expect((await worker.serve(request, 'tab-1', 'song')).headers.get('X-CBM-Error')).toBe('FILE_CHANGED')
    expect((await worker.serve(request, 'tab-1', 'song')).headers.get('X-CBM-Error')).toBe('INVALID_UPSTREAM_RANGE')
  })

  it('returns a versioned session acknowledgement so the page can detect an outdated worker', () => {
    const worker = harness()
    const acknowledge = vi.fn()
    worker.listeners.get('message')!({ source: { id: 'tab-1' }, data: { type: 'CLEAR_SESSION' }, ports: [{ postMessage: acknowledge }] })
    expect(acknowledge).toHaveBeenCalledWith({ type: 'SESSION_ACK', protocol: 2 })
  })

  it('reconstructs a CORS-hidden Content-Range only after matching length and fresh Drive metadata', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(hiddenRangeResponse(10)).mockResolvedValueOnce(metadataResponse())
    const response = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=10-19' } }), 'tab-1', 'song')
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 10-19/100')
    expect(response.headers.get('Content-Length')).toBe('10')
    expect((await response.arrayBuffer()).byteLength).toBe(10)
    expect(worker.upstream).toHaveBeenCalledTimes(2)
    expect(worker.upstream.mock.calls[1][0]).toBe('https://www.googleapis.com/drive/v3/files/song?fields=size,modifiedTime,trashed,capabilities(canDownload)')
    expect(worker.upstream.mock.calls[1][1]).toMatchObject({ headers: { Authorization: 'Bearer test-token' }, cache: 'no-store' })
    expect(worker.upstream.mock.calls[1][1]?.signal).toBe(worker.upstream.mock.calls[0][1]?.signal)
  })

  it('requires exposed length evidence when CORS hides Content-Range', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(new Response(new Uint8Array(1), { status: 206 }))
    const response = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=0-0' } }), 'tab-1', 'song')
    expect(response.status).toBe(502)
    expect(response.headers.get('X-CBM-Error')).toBe('RANGE_LENGTH_UNAVAILABLE')
    expect(worker.upstream).toHaveBeenCalledOnce()
  })

  it('rejects a mismatched exposed length before requesting metadata', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(hiddenRangeResponse(2))
    const response = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=0-0' } }), 'tab-1', 'song')
    expect(response.headers.get('X-CBM-Error')).toBe('INVALID_UPSTREAM_LENGTH')
    expect(worker.upstream).toHaveBeenCalledOnce()
  })

  it.each([{ size: '101' }, { modifiedTime: '2026-10-11T00:00:00.000Z' }])('rejects changed metadata when Content-Range is hidden: %j', async (changed) => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(hiddenRangeResponse(1)).mockResolvedValueOnce(metadataResponse(changed))
    const response = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=0-0' } }), 'tab-1', 'song')
    expect(response.status).toBe(409)
    expect(response.headers.get('X-CBM-Error')).toBe('FILE_CHANGED')
  })

  it.each([
    [{ trashed: true }, 404, 'FILE_NOT_FOUND'],
    [{ capabilities: { canDownload: false } }, 403, 'DOWNLOAD_RESTRICTED'],
    [{ capabilities: {} }, 502, 'INVALID_DRIVE_METADATA'],
    [{ size: 'invalid' }, 502, 'INVALID_DRIVE_METADATA'],
  ])('does not infer safe streaming from unusable fresh metadata %j', async (overrides, status, reason) => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(hiddenRangeResponse(1)).mockResolvedValueOnce(metadataResponse(overrides))
    const response = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=0-0' } }), 'tab-1', 'song')
    expect(response.status).toBe(status)
    expect(response.headers.get('X-CBM-Error')).toBe(reason)
  })

  it.each([[403, 'DRIVE_ACCESS_DENIED'], [404, 'FILE_NOT_FOUND'], [429, 'DRIVE_METADATA_UNAVAILABLE']])('preserves metadata HTTP %s instead of accepting the media body', async (status, reason) => {
    const worker = harness()
    worker.session()
    const cancel = vi.fn()
    worker.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 206, headers: { 'Content-Length': '1' } }))
      .mockResolvedValueOnce(new Response('denied', { status }))
    const response = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=0-0' } }), 'tab-1', 'song')
    expect(response.status).toBe(status)
    expect(response.headers.get('X-CBM-Error')).toBe(reason)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('requests fresh authentication when the metadata request returns 401', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(hiddenRangeResponse(1)).mockResolvedValueOnce(new Response('expired', { status: 401 }))
    const response = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=0-0' } }), 'tab-1', 'song')
    expect(response.status).toBe(401)
    expect(response.headers.get('X-CBM-Error')).toBe('AUTH_REQUIRED')
    await vi.waitFor(() => expect(worker.tab.postMessage).toHaveBeenCalledWith({ type: 'MEDIA_AUTH_REQUIRED', rejectedToken: 'test-token' }))
  })

  it.each([[9, 'INCOMPLETE_UPSTREAM_RANGE'], [11, 'INVALID_UPSTREAM_LENGTH']])('detects a body of %s bytes despite a declared verified length of 10', async (bodyLength, reason) => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(hiddenRangeResponse(10, bodyLength)).mockResolvedValueOnce(metadataResponse())
    const response = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=10-19' } }), 'tab-1', 'song')
    await expect(response.arrayBuffer()).rejects.toThrow(reason)
    expect(worker.upstream.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('preserves non-Range GET semantics when reconstructing CORS-hidden headers', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(hiddenRangeResponse(100)).mockResolvedValueOnce(metadataResponse())
    const response = await worker.serve(new Request('https://example.com/media'), 'tab-1', 'song')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Range')).toBeNull()
    expect(response.headers.get('Content-Length')).toBe('100')
    expect((await response.arrayBuffer()).byteLength).toBe(100)
  })

  it('preserves HEAD Range semantics while verifying hidden headers with one media byte', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(hiddenRangeResponse(1)).mockResolvedValueOnce(metadataResponse())
    const response = await worker.serve(new Request('https://example.com/media', { method: 'HEAD', headers: { Range: 'bytes=10-29' } }), 'tab-1', 'song')
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 10-29/100')
    expect(response.headers.get('Content-Length')).toBe('20')
    expect(response.body).toBeNull()
    expect(worker.upstream.mock.calls[0][1]?.headers).toMatchObject({ Range: 'bytes=10-10' })
  })

  it('cancels fresh metadata and the waiting media body on logout', async () => {
    const worker = harness()
    worker.session()
    const cancel = vi.fn()
    worker.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 206, headers: { 'Content-Length': '1' } }))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }))
    const pending = worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=0-0' } }), 'tab-1', 'song')
    await vi.waitFor(() => expect(worker.upstream).toHaveBeenCalledTimes(2))
    worker.message({ type: 'CLEAR_SESSION' })
    const response = await pending
    expect(response.headers.get('X-CBM-Error')).toBe('REQUEST_CANCELLED')
    expect(worker.upstream.mock.calls[1][1]?.signal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a pending upstream stream read immediately on logout', async () => {
    const worker = harness()
    worker.session()
    const cancel = vi.fn()
    worker.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 206, headers: { 'Content-Length': '10' } }))
      .mockResolvedValueOnce(metadataResponse())
    const response = await worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=10-19' } }), 'tab-1', 'song')
    const read = response.arrayBuffer()
    const rejection = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    worker.message({ type: 'CLEAR_SESSION' })
    await rejection
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels upstream reads on logout and removes the client session', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const result = worker.serve(new Request('https://example.com/media', { headers: { Range: 'bytes=0-0' } }), 'tab-1', 'song')
    await vi.waitFor(() => expect(worker.upstream).toHaveBeenCalled())
    const signal = worker.upstream.mock.calls[0][1]?.signal
    worker.message({ type: 'CLEAR_SESSION' })
    expect(signal?.aborted).toBe(true)
    expect((await result).headers.get('X-CBM-Error')).toBe('REQUEST_CANCELLED')
    worker.tab.postMessage.mockImplementation((data) => { if (data.type === 'REQUEST_SESSION') worker.message({ type: 'CLEAR_SESSION', requestId: data.requestId }) })
    expect((await worker.serve(new Request('https://example.com/media'), 'tab-1', 'song')).status).toBe(401)
  })

  it('only intercepts media inside the repository service-worker base path', () => {
    const worker = harness()
    const respondWith = vi.fn()
    worker.listeners.get('fetch')!({ request: new Request('https://example.com/another/__cbm_media__/song'), clientId: 'tab-1', respondWith })
    expect(respondWith).not.toHaveBeenCalled()
  })

  it('returns an ordinary streamed 200 for a GET without a Range header', async () => {
    const worker = harness()
    worker.session()
    worker.upstream.mockResolvedValueOnce(rangeResponse(0, 99))
    const response = await worker.serve(new Request('https://example.com/media'), 'tab-1', 'song')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Range')).toBeNull()
    expect((await response.arrayBuffer()).byteLength).toBe(100)
  })

  it('ignores a late recovery reply after logout instead of restoring the old token', async () => {
    const worker = harness()
    let requestId: string | undefined
    worker.tab.postMessage.mockImplementation((data) => { if (data.type === 'REQUEST_SESSION') requestId = data.requestId })
    const request = worker.serve(new Request('https://example.com/media'), 'tab-1', 'song')
    await vi.waitFor(() => expect(requestId).toBeDefined())
    worker.message({ type: 'CLEAR_SESSION' })
    worker.message({ type: 'SET_SESSION', requestId, token: 'old-token', expiresAt: Date.now() + 10000, files: { song: file } })
    expect((await request).headers.get('X-CBM-Error')).toBe('REQUEST_CANCELLED')
    expect(worker.upstream).not.toHaveBeenCalled()
    worker.tab.postMessage.mockImplementation((data) => { if (data.type === 'REQUEST_SESSION') worker.message({ type: 'CLEAR_SESSION', requestId: data.requestId }) })
    expect((await worker.serve(new Request('https://example.com/media'), 'tab-1', 'song')).status).toBe(401)
  })
})
