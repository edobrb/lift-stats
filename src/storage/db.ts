import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { LiftSet, Profile, SetVideo } from '../types'

interface LiftDB extends DBSchema {
  profiles: { key: string; value: Profile }
  sets: {
    key: string
    value: LiftSet
    indexes: { 'by-profile': string; 'by-profile-exercise': [string, string] }
  }
  videos: { key: string; value: SetVideo }
}

let dbPromise: Promise<IDBPDatabase<LiftDB>> | null = null

export const getDb = (): Promise<IDBPDatabase<LiftDB>> => {
  if (!dbPromise) {
    dbPromise = openDB<LiftDB>('lift-stats', 1, {
      // Schema lives only here; bump the version to add stores/indexes later.
      upgrade(db) {
        db.createObjectStore('profiles', { keyPath: 'id' })
        const sets = db.createObjectStore('sets', { keyPath: 'id' })
        sets.createIndex('by-profile', 'profileId')
        sets.createIndex('by-profile-exercise', ['profileId', 'exercise'])
        db.createObjectStore('videos', { keyPath: 'setId' })
      },
    })
  }
  return dbPromise
}

/** Ask the browser not to evict our data (best-effort; protects saved video blobs). */
export const requestPersistentStorage = async (): Promise<boolean> => {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}

export const storageEstimate = async (): Promise<{ usage: number; quota: number; pct: number }> => {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0, pct: 0 }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota, pct: quota ? usage / quota : 0 }
}
