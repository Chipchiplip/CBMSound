// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseBuffer } from 'music-metadata'
import type { DriveTrack } from '../types'

const auth = vi.hoisted(() => ({
  getTokenState: vi.fn(() => ({ accessToken: 'metadata-test-token' })),
  invalidateAccessToken: vi.fn(),
}))
vi.mock('./auth', () => auth)
vi.mock('./session', () => ({ subscribeSessionReset: vi.fn() }))

import { readMetadataFromDrive, readMetadataFromFile } from './audioMetadata'

const LIMIT = 4 * 1024 * 1024
const FRAME_SIZE = 1044 // MPEG-1 Layer III, 320 kbps, 44.1 kHz, no padding.
const FRAME_SECONDS = 1152 / 44100

// Real parser fixture: ID3v2 artist plus MPEG headers. No parser mock can hide
// the tokenizer's replacement of the advertised Drive size with prefix length.
function mp3(audioBytes: number): Uint8Array<ArrayBuffer> {
  const artist = new TextEncoder().encode('CBM artist')
  const tagBodySize = 10 + 1 + artist.byteLength
  const data = new Uint8Array(10 + tagBodySize + audioBytes)
  data.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, tagBodySize])
  data.set([0x54, 0x50, 0x45, 0x31, 0, 0, 0, artist.byteLength + 1, 0, 0, 0], 10)
  data.set(artist, 21)
  for (let offset = 10 + tagBodySize; offset + 4 <= data.byteLength; offset += FRAME_SIZE) {
    data.set([0xff, 0xfb, 0xe0, 0], offset)
  }
  return data
}

function track(size: number): DriveTrack {
  return { id: 'long-mp3', name: '80-minute-mix.mp3', mimeType: 'audio/mpeg', size, createdTime: '', modifiedTime: '' }
}

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  fetchMock.mockReset()
  auth.getTokenState.mockReturnValue({ accessToken: 'metadata-test-token' })
  auth.invalidateAccessToken.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('bounded Drive metadata and complete-file duration', () => {
  it('never reports a 4 MiB prefix as the duration of an 80-minute MP3', async () => {
    const prefix = mp3(LIMIT - 31)
    const fullTrack = track(31 + 183750 * FRAME_SIZE) // 80 minutes of MPEG audio.
    const misleading = await parseBuffer(prefix, { mimeType: fullTrack.mimeType, size: fullTrack.size })
    expect(misleading.format.duration).toBeGreaterThan(100)
    expect(misleading.format.duration).toBeLessThan(110)

    fetchMock.mockResolvedValue(new Response(prefix, {
      status: 206,
      headers: { 'Content-Range': `bytes 0-${prefix.byteLength - 1}/${fullTrack.size}` },
    }))
    const tags = await readMetadataFromDrive(fullTrack)
    expect(tags.artist).toBe('CBM artist')
    expect(tags).not.toHaveProperty('duration')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://www.googleapis.com/drive/v3/files/long-mp3?alt=media',
      expect.objectContaining({ headers: { Authorization: 'Bearer metadata-test-token', Range: `bytes=0-${LIMIT - 1}` } }),
    )
  })

  it.each([200, 206])('retains duration when HTTP %s delivers the complete small MP3', async (status) => {
    const complete = mp3(10 * FRAME_SIZE)
    fetchMock.mockResolvedValue(new Response(complete, { status }))
    const tags = await readMetadataFromDrive(track(complete.byteLength))
    expect(tags.artist).toBe('CBM artist')
    expect(tags.duration).toBeCloseTo(10 * FRAME_SECONDS, 4)
  })

  it('keeps complete local-file duration for uploads', async () => {
    const complete = mp3(10 * FRAME_SIZE)
    const tags = await readMetadataFromFile(new File([complete], 'upload.mp3', { type: 'audio/mpeg' }))
    expect(tags.artist).toBe('CBM artist')
    expect(tags.duration).toBeCloseTo(10 * FRAME_SECONDS, 4)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('omits duration for a truncated response even when the file fits in the metadata budget', async () => {
    const prefix = mp3(10 * FRAME_SIZE)
    fetchMock.mockResolvedValue(new Response(prefix, { status: 206 }))
    const tags = await readMetadataFromDrive(track(prefix.byteLength + FRAME_SIZE))
    expect(tags.artist).toBe('CBM artist')
    expect(tags).not.toHaveProperty('duration')
  })

  it('cancels an oversized full-file response instead of downloading it for duration', async () => {
    const cancel = vi.fn()
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      status: 200, headers: { 'Content-Length': String(200 * 1024 * 1024) },
    }))
    expect(await readMetadataFromDrive(track(200 * 1024 * 1024))).toEqual({})
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('invalidates a rejected access token without exposing metadata', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    expect(await readMetadataFromDrive(track(100))).toEqual({})
    expect(auth.invalidateAccessToken).toHaveBeenCalledExactlyOnceWith('metadata-test-token')
  })

  it('does not request metadata after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await readMetadataFromDrive(track(100), controller.signal)).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
