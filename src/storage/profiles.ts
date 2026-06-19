import { getDb } from './db'
import { makeId } from '../lib/id'
import type { Profile } from '../types'

export const listProfiles = async (): Promise<Profile[]> => {
  const all = await (await getDb()).getAll('profiles')
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export const getProfile = async (id: string): Promise<Profile | undefined> =>
  (await getDb()).get('profiles', id)

export const createProfile = async (name: string): Promise<Profile> => {
  const profile: Profile = { id: makeId(), name: name.trim() || 'Athlete', createdAt: Date.now() }
  await (await getDb()).put('profiles', profile)
  return profile
}

/** Deletes a profile and all of its sets + videos atomically. */
export const deleteProfile = async (id: string): Promise<void> => {
  const db = await getDb()
  const tx = db.transaction(['profiles', 'sets', 'videos'], 'readwrite')
  // Read the set keys inside the same transaction so a concurrent save can't
  // leave an orphaned set/video behind.
  const setKeys = await tx.objectStore('sets').index('by-profile').getAllKeys(id)
  tx.objectStore('profiles').delete(id)
  for (const key of setKeys) {
    tx.objectStore('sets').delete(key)
    tx.objectStore('videos').delete(key)
  }
  await tx.done
}
