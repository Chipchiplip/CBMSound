// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('./auth', () => ({ getTokenState: vi.fn(() => ({ accessToken: 'test', expiresAt: Date.now() + 10000 })), invalidateAccessToken: vi.fn(), subscribeToken: vi.fn() }))
vi.mock('./session', () => ({ subscribeSessionReset: vi.fn() }))

import { readResponseBytes } from './media'

describe('bounded media downloads', () => {
  it('rejects an oversized Content-Length before reading its body', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': '200000000' } })
    await expect(readResponseBytes(response, 32 * 1024 * 1024)).rejects.toMatchObject({ reason: 'DOWNLOAD_LIMIT' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a response with missing Content-Length as soon as it exceeds budget', async () => {
    const cancel = vi.fn()
    let chunks = 0
    const response = new Response(new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(4)); }, cancel,
    }))
    await expect(readResponseBytes(response, 6)).rejects.toMatchObject({ reason: 'DOWNLOAD_LIMIT' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(chunks).toBeLessThanOrEqual(3)
  })

  it('can read exactly the limit without allocating an unbounded Blob', async () => {
    const result = await readResponseBytes(new Response(new Uint8Array([1, 2, 3, 4])), 4)
    expect([...result[0]]).toEqual([1, 2, 3, 4])
  })

  it('aborts an in-progress read when switching tracks or signing out', async () => {
    const cancel = vi.fn()
    const controller = new AbortController()
    const read = readResponseBytes(new Response(new ReadableStream({ cancel })), 8, controller.signal)
    controller.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
