import { describe, expect, it } from 'vitest'
import { parseByteRange } from './range'
import { formatBytes, uploadProgress } from '../utils/uploadPresentation'
import { isAudioFile, isSupportedAudio } from '../types'

describe('parseByteRange', () => {
  it('parses closed, open-ended and suffix byte ranges', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseByteRange('bytes=80-', 100)).toEqual({ start: 80, end: 99 })
    expect(parseByteRange('bytes=-12', 100)).toEqual({ start: 88, end: 99 })
  })

  it('accepts a missing range and rejects malformed or reversed ranges', () => {
    expect(parseByteRange(null, 100)).toBeUndefined()
    expect(parseByteRange('items=0-10', 100)).toBe('invalid')
    expect(parseByteRange('bytes=10-9', 100)).toBe('invalid')
    expect(parseByteRange('bytes=-0', 100)).toBe('invalid')
  })

  it('does not silently accept a multipart range the player cannot proxy', () => {
    expect(parseByteRange('bytes=0-2,7-8', 12)).toBe('invalid')
  })
})

describe('file and upload display helpers', () => {
  it('accepts the advertised audio extensions when browsers provide no MIME type', () => {
    expect(isAudioFile({ name: 'concert.FLAC', type: '' })).toBe(true)
    expect(isAudioFile({ name: 'cover.txt', type: '' })).toBe(false)
    expect(isSupportedAudio({ name: 'voice.ogg', mimeType: 'application/octet-stream' })).toBe(true)
  })

  it('formats binary sizes and reports only confirmed upload progress', () => {
    expect(formatBytes(1024 * 1024 * 200)).toBe('200.0 MB')
    expect(uploadProgress({ id: 'a', file: new File([], 'a.mp3'), state: 'uploading', sentBytes: 1024, confirmedBytes: 512, totalBytes: 2048 })).toBe(25)
  })
})
