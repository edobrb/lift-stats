import { getDb } from './db'
import type { ExerciseId, LiftSet, SetVideo } from '../types'

export const saveSet = async (
  set: LiftSet,
  video: { blob: Blob; mime: string } | null,
): Promise<void> => {
  const db = await getDb()
  const tx = db.transaction(['sets', 'videos'], 'readwrite')
  tx.objectStore('sets').put(set)
  if (video) tx.objectStore('videos').put({ setId: set.id, blob: video.blob, mime: video.mime })
  await tx.done
}

/** Update the set record only (leaves any stored video untouched). */
export const updateSet = async (set: LiftSet): Promise<void> => {
  await (await getDb()).put('sets', set)
}

export const listSetsByProfile = async (profileId: string): Promise<LiftSet[]> => {
  const all = await (await getDb()).getAllFromIndex('sets', 'by-profile', profileId)
  return all.sort((a, b) => b.startedAt - a.startedAt)
}

export const listSetsByExercise = async (
  profileId: string,
  exercise: ExerciseId,
): Promise<LiftSet[]> => {
  const all = await (await getDb()).getAllFromIndex('sets', 'by-profile-exercise', [profileId, exercise])
  return all.sort((a, b) => b.startedAt - a.startedAt)
}

export const getSet = async (id: string): Promise<LiftSet | undefined> =>
  (await getDb()).get('sets', id)

export const getSetVideo = async (setId: string): Promise<SetVideo | undefined> =>
  (await getDb()).get('videos', setId)

export const deleteSet = async (id: string): Promise<void> => {
  const db = await getDb()
  const tx = db.transaction(['sets', 'videos'], 'readwrite')
  tx.objectStore('sets').delete(id)
  tx.objectStore('videos').delete(id)
  await tx.done
}
