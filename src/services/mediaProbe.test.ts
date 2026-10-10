// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveTrack } from '../types'

const auth = vi.hoisted(() => ({ getTokenState: vi.fn(), invalidateAccessToken: vi.fn(), subscribeToken: vi.fn() }))
vi.mock('./auth', () => auth)
vi.mock('./session', () => ({ subscribeSessionReset: vi.fn() }))

class TestChannel {
  port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() }
  port2 = { postMessage: (data: unknown) => queueMicrotask(() => this.port1.onmessage?.({ data })) }
}

function makeWorker(protocol = 2, scriptURL = 'http://localhost:5173/sw.js') {
  return { scriptURL, postMessage: vi.fn((_message: unknown, ports: TestChannel['port2'][]) => ports[0]?.postMessage({ type: 'SESSION_ACK', protocol })) }
}

const track: DriveTrack = { id: 'private-song', name: 'Long song.mp3', size: 200 * 1024 * 1024, mimeType: 'audio/mpeg', createdTime: '', modifiedTime: '2026-10-10T00:00:00Z' }
let media: typeof import('./media')
let current: ReturnType<typeof makeWorker>
let serviceWorker: { controller: ReturnType<typeof makeWorker> | null; register: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }
let registered: { active: ReturnType<typeof makeWorker>; update: ReturnType<typeof vi.fn> }
let fetchMock: ReturnType<typeof vi.fn>
let callbacks: Map<string, Set<() => void>>

beforeEach(async () => {
  vi.resetModules()
  auth.getTokenState.mockReset().mockReturnValue({ accessToken: 'test-only-token', expiresAt: Date.now() + 60_000 })
  auth.invalidateAccessToken.mockReset()
  callbacks = new Map()
  current = makeWorker()
  registered = { active: current, update: vi.fn().mockResolvedValue(undefined) }
  serviceWorker = {
    controller: current,
    register: vi.fn().mockResolvedValue(registered),
    addEventListener: vi.fn((event: string, callback: () => void) => { const listeners = callbacks.get(event) || new Set(); listeners.add(callback); callbacks.set(event, listeners) }),
    removeEventListener: vi.fn((event: string, callback: () => void) => callbacks.get(event)?.delete(callback)),
  }
  vi.stubGlobal('navigator', { serviceWorker })
  vi.stubGlobal('location', { protocol: 'http:', hostname: 'localhost', href: 'http://localhost:5173/' })
  vi.stubGlobal('window', {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  })
  vi.stubGlobal('MessageChannel', TestChannel)
  fetchMock = vi.fn().mockImplementation(async () => new Response(new Uint8Array([1]), { status: 206, headers: { 'Content-Range': `bytes 0-0/${track.size}`, 'Content-Length': '1' } }))
  vi.stubGlobal('fetch', fetchMock)
  media = await import('./media')
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('real media probe protocol', () => {
  it('checks its own worker and actually reads the one-byte response before enabling playback', async () => {
    media.setMediaManifest([track])
    await expect(media.probeRangePlayback(track)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/__cbm_media__/private-song', expect.objectContaining({ headers: { Range: 'bytes=0-0' } }))
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', { type: 'module', scope: '/', updateViaCache: 'none' })
    expect(current.postMessage).toHaveBeenCalledWith(expect.objectContaining({ files: { 'private-song': { size: track.size, mimeType: track.mimeType, modifiedTime: track.modifiedTime } } }), expect.any(Array))
  })

  it.each([0, 2])('rejects a probe that returns %i bytes despite valid local Range headers', async (size) => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(size), { status: 206, headers: { 'Content-Range': `bytes 0-0/${track.size}` } }))
    await expect(media.probeRangePlayback(track)).rejects.toMatchObject({ reason: 'INVALID_PROBE_BODY' })
  })

  it('identifies an unhandled Vite HTML route instead of blaming Drive Range support', async () => {
    fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    await expect(media.probeRangePlayback(track)).rejects.toMatchObject({ reason: 'WORKER_ROUTE_MISSING' })
  })

  it('keeps an ignored upstream Range distinct and never downloads a large file as fallback', async () => {
    fetchMock.mockResolvedValue(new Response('RANGE_NOT_SUPPORTED', { status: 502, headers: { 'X-CBM-Error': 'RANGE_NOT_SUPPORTED' } }))
    await expect(media.probeRangePlayback(track)).rejects.toMatchObject({ reason: 'RANGE_NOT_SUPPORTED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('allows bounded fallback for a small file when Range length cannot be verified', async () => {
    fetchMock.mockResolvedValue(new Response('RANGE_LENGTH_UNAVAILABLE', { status: 502, headers: { 'X-CBM-Error': 'RANGE_LENGTH_UNAVAILABLE' } }))
    await expect(media.probeRangePlayback({ ...track, size: 1024 })).resolves.toBe(false)
  })

  it('does not cache a failed activation permanently and succeeds when the app controller arrives later', async () => {
    vi.useFakeTimers()
    serviceWorker.controller = null
    const first = media.registerMediaWorker()
    await vi.advanceTimersByTimeAsync(5001)
    await expect(first).resolves.toBeUndefined()
    serviceWorker.controller = current
    for (const callback of callbacks.get('controllerchange') || []) callback()
    await expect(media.registerMediaWorker()).resolves.toBe(registered)
    expect(serviceWorker.register).toHaveBeenCalledTimes(2)
  })

  it('never sends the token to another app worker or reports it as a usable media route', async () => {
    vi.useFakeTimers()
    const unrelated = makeWorker(2, 'http://localhost:5173/another-app-worker.js')
    serviceWorker.controller = unrelated
    const failed = media.probeRangePlayback(track).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5001)
    expect(await failed).toMatchObject({ reason: 'WORKER_NOT_CONTROLLING' })
    expect(unrelated.postMessage).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('updates a stale worker and waits for a protocol-compatible controller', async () => {
    serviceWorker.controller = makeWorker(1)
    registered.update.mockImplementation(async () => {
      serviceWorker.controller = current
      for (const callback of callbacks.get('controllerchange') || []) callback()
    })
    await expect(media.probeRangePlayback(track)).resolves.toBe(true)
    expect(registered.update).toHaveBeenCalledOnce()
  })

  it('invalidates only the rejected access token on a worker 401', async () => {
    fetchMock.mockResolvedValue(new Response('AUTH_REQUIRED', { status: 401, headers: { 'X-CBM-Error': 'AUTH_REQUIRED' } }))
    await expect(media.probeRangePlayback(track)).rejects.toMatchObject({ status: 401 })
    expect(auth.invalidateAccessToken).toHaveBeenCalledWith('test-only-token')
  })

  it('explains a Drive download restriction rather than showing a streaming size error', async () => {
    fetchMock.mockResolvedValue(new Response('DOWNLOAD_RESTRICTED', { status: 403, headers: { 'X-CBM-Error': 'DOWNLOAD_RESTRICTED' } }))
    await expect(media.probeRangePlayback(track)).rejects.toMatchObject({ status: 403, reason: 'DOWNLOAD_RESTRICTED' })
  })

  it('preserves rate-limit diagnostics when fresh metadata verification cannot finish', async () => {
    fetchMock.mockResolvedValue(new Response('DRIVE_METADATA_UNAVAILABLE', { status: 429, headers: { 'X-CBM-Error': 'DRIVE_METADATA_UNAVAILABLE' } }))
    await expect(media.probeRangePlayback(track)).rejects.toMatchObject({ status: 429, reason: 'DRIVE_METADATA_UNAVAILABLE', retryable: true })
  })
})
