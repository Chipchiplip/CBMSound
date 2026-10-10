import { parseBlob, parseBuffer } from 'music-metadata'
import type { DriveTrack } from '../types'
import { getTokenState, invalidateAccessToken } from './auth'
import { readResponseBytes } from './media'

const REMOTE_METADATA_LIMIT = 4 * 1024 * 1024
const COVER_LIMIT = 400 * 1024

export type MusicTags = Pick<DriveTrack, 'artist' | 'album' | 'duration' | 'artwork'>

export async function readMetadataFromFile(file: File): Promise<MusicTags> {
  try {
    const metadata = await parseBlob(file, { skipCovers: false })
    return {
      artist: metadata.common.artist,
      album: metadata.common.album,
      duration: metadata.format.duration,
      artwork: metadata.common.picture?.[0] ? await pictureToDataUrl(metadata.common.picture[0]) : undefined,
    }
  } catch {
    return {}
  }
}

export async function readMetadataFromDrive(track: DriveTrack, signal?: AbortSignal): Promise<MusicTags> {
  try {
    const token = getTokenState()?.accessToken
    if (!token || signal?.aborted) return {}
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(track.id)}?alt=media`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Range: `bytes=0-${REMOTE_METADATA_LIMIT - 1}`,
      },
      signal,
      cache: 'no-store',
    })
    if (response.status === 401) invalidateAccessToken(token)
    if (!response.ok || ![200, 206].includes(response.status)) {
      await response.body?.cancel()
      return {}
    }
    // Accept 200 for small files only, with the same hard streaming budget.
    const chunks = await readResponseBytes(response, REMOTE_METADATA_LIMIT, signal)
    if (signal?.aborted) return {}
    const buffer = new Uint8Array(chunks.reduce((sum, item) => sum + item.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
    const metadata = await parseBuffer(buffer, {
      mimeType: track.mimeType,
      size: track.size,
    })
    // parseBuffer's tokenizer uses buffer.length as its file size, even when a
    // different size is supplied above. For CBR MP3 this makes a 4 MiB prefix
    // look like a complete ~1:44 recording. Preserve tags from the prefix, but
    // only expose duration when we actually received the complete Drive file.
    return parseTags(metadata, buffer.byteLength === track.size)
  } catch {
    return {}
  }
}

async function parseTags(metadata: Awaited<ReturnType<typeof parseBlob>>, completeFile = true): Promise<MusicTags> {
  return {
    artist: metadata.common.artist,
    album: metadata.common.album,
    ...(completeFile ? { duration: metadata.format.duration } : {}),
    artwork: metadata.common.picture?.[0] ? await pictureToDataUrl(metadata.common.picture[0]) : undefined,
  }
}

async function pictureToDataUrl(picture: { data: Uint8Array; format: string }): Promise<string | undefined> {
  const type = picture.format.startsWith('image/') ? picture.format : 'image/jpeg'
  const blob = new Blob([new Uint8Array(picture.data).buffer as ArrayBuffer], { type })
  if (blob.size <= COVER_LIMIT) return blobToDataUrl(blob)
  if (typeof createImageBitmap !== 'function') return undefined
  try {
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    return undefined
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
