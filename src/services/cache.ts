import { openDB } from 'idb'
import type { DriveTrack } from '../types'
import { assertSessionCurrent, getSessionGeneration, subscribeSessionReset } from './session'

let dbPromise: ReturnType<typeof openDB> | undefined

function database() {
  dbPromise ??= openDB('cbm-sound', 1, {
    upgrade(db) {
      db.createObjectStore('snapshots')
      db.createObjectStore('settings')
    },
  })
  return dbPromise
}

export interface CachedSnapshot {
  tracks: DriveTrack[]
  syncedAt: string | null
}

export async function getCachedSnapshot(key: string): Promise<CachedSnapshot | undefined> {
  const snapshot = await (await database()).get('snapshots', key) as CachedSnapshot | DriveTrack[] | undefined
  // Previous builds stored an array without a remote-sync timestamp. It may be
  // shown as old cache, but must never be described as recently synchronized.
  if (Array.isArray(snapshot)) return { tracks: snapshot, syncedAt: null }
  return snapshot
}

export async function getCachedTracks(key: string): Promise<DriveTrack[] | undefined> {
  return (await getCachedSnapshot(key))?.tracks
}

async function put(store: string, key: string, value: unknown): Promise<void> {
  const generation = getSessionGeneration()
  const db = await database()
  assertSessionCurrent(generation)
  const transaction = db.transaction(store, 'readwrite')
  const unsubscribe = subscribeSessionReset(() => {
    try { transaction.abort() } catch { /* An already committed transaction cannot be aborted. */ }
  })
  try {
    await transaction.store.put(value, key)
    await transaction.done
    assertSessionCurrent(generation)
  } finally { unsubscribe() }
}

export async function setCachedTracks(key: string, tracks: DriveTrack[], syncedAt: string | null = new Date().toISOString()): Promise<void> {
  await put('snapshots', key, { tracks, syncedAt } satisfies CachedSnapshot)
}

export async function getLibraryFolderId(): Promise<string | undefined> {
  return (await database()).get('settings', 'libraryFolderId')
}

export async function setLibraryFolderId(id: string): Promise<void> {
  await put('settings', 'libraryFolderId', id)
}

export async function getLocalPreference<T>(key: string): Promise<T | undefined> {
  return (await database()).get('settings', key)
}

export async function setLocalPreference<T>(key: string, value: T): Promise<void> {
  await put('settings', key, value)
}
