import type { LiftSet, RepMetrics } from '../types'
import { getExercise } from '../config/exercises'
import { aggregateReps } from './metrics'

// Export a single set's data as portable JSON: the full set record (with the reps currently
// shown — including any unsaved boundary edits), the resolved exercise name, and a derived
// summary so the file is useful on its own without the app.

interface SetExport {
  app: 'lift-stats'
  version: 1
  exportedAt: string
  exerciseName: string
  summary: ReturnType<typeof aggregateReps>
  set: LiftSet
}

const buildExport = (set: LiftSet, reps: RepMetrics[]): SetExport => {
  const reindexed = reps.map((r, i) => ({ ...r, index: i + 1 }))
  return {
    app: 'lift-stats',
    version: 1,
    exportedAt: new Date().toISOString(),
    exerciseName: getExercise(set.exercise).name,
    summary: aggregateReps(reindexed),
    set: { ...set, reps: reindexed, repCount: reindexed.length },
  }
}

/** Pretty-printed JSON for a set (with the given reps). */
export const setToJson = (set: LiftSet, reps: RepMetrics[]): string =>
  JSON.stringify(buildExport(set, reps), null, 2)

/** A filesystem-friendly name like `liftstats-squat-2026-06-20.json`. */
export const setExportFilename = (set: LiftSet): string => {
  const date = new Date(set.startedAt)
  const stamp = Number.isFinite(set.startedAt) ? date.toISOString().slice(0, 10) : 'set'
  return `liftstats-${set.exercise}-${stamp}.json`
}

/**
 * Download the set as a `.json` file. Prefers the Web Share API on devices that can share
 * files (so a phone can save it to Files / send it on), falling back to an anchor download.
 */
export const exportSetJson = async (set: LiftSet, reps: RepMetrics[]): Promise<void> => {
  const json = setToJson(set, reps)
  const filename = setExportFilename(set)
  const blob = new Blob([json], { type: 'application/json' })

  // Native share-sheet path (mobile): lets the user save the file or send it anywhere.
  const file = typeof File !== 'undefined' ? new File([blob], filename, { type: 'application/json' }) : null
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return
    } catch (err) {
      // User cancelled the share sheet — don't fall through to a download in that case.
      if (err instanceof DOMException && err.name === 'AbortError') return
    }
  }

  // Anchor-download fallback (desktop and browsers without file sharing).
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
