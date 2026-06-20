import type { ExerciseConfig } from '../config/exercises'
import type { RepMetrics } from '../types'
import { createPoseEngine } from './pose'
import { extractSignal } from './signal'
import { createRepDetector, stepRepDetector, finalizeRepDetector } from './repDetector'

// Re-run the FULL detection pipeline (pose → 1-D signal → rep/hold detector) over a
// recorded clip, producing fresh reps with the CURRENT detector version. Useful to
// backfill holds onto old recordings and to re-apply any future detector improvement.
//
// We step frame-by-frame by SEEKING (not realtime playback): this processes every
// frame, runs faster than wall-clock when decode is quick, and keeps timing exact.
// Times are taken straight from the video's own timeline, so the resulting reps line
// up with the footage in the editor (no rebasing needed).

export interface AnalyzeResult {
  reps: RepMetrics[]
  fps: number
  durationMs: number
}

export interface AnalyzeOptions {
  fps?: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export const analyzeVideo = async (
  blob: Blob,
  cfg: ExerciseConfig,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> => {
  // Clamp fps to a sane range: a stored Infinity (from a degenerate set) would make dt=0
  // and spin the seek loop forever; NaN/0/negative fall back to 30.
  const fps = Number.isFinite(opts.fps) && (opts.fps as number) > 0 ? Math.min(opts.fps as number, 120) : 30
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url

  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new DOMException('Recompute cancelled', 'AbortError')
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onMeta = () => {
        cleanup()
        resolve()
      }
      const onErr = () => {
        cleanup()
        reject(new Error('Could not load the recorded video.'))
      }
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onMeta)
        video.removeEventListener('error', onErr)
      }
      video.addEventListener('loadedmetadata', onMeta)
      video.addEventListener('error', onErr)
    })

    // MediaRecorder blobs often report duration = Infinity until seeked to the end.
    let duration = video.duration
    if (!Number.isFinite(duration) || duration === 0) {
      duration = await new Promise<number>((resolve) => {
        const finish = () => {
          video.removeEventListener('seeked', onSeeked)
          video.removeEventListener('error', onSeeked)
          clearTimeout(timer)
          resolve(Number.isFinite(video.duration) ? video.duration : 0)
        }
        const onSeeked = () => finish()
        // Don't hang if the probe seek never resolves (drops/errors); fall through to the
        // "no readable duration" error below after a short wait.
        const timer = setTimeout(finish, 5000)
        video.addEventListener('seeked', onSeeked)
        video.addEventListener('error', onSeeked)
        video.currentTime = 1e7
      })
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('The recording has no readable duration.')
    }

    // Seek and wait for the frame to land. A corrupt/partially-decodable clip can drop a
    // seek silently (no 'seeked' ever fires), so guard with a timeout and the 'error' event
    // and honour the abort signal — otherwise recompute hangs forever on a bad recording.
    const seekTo = (t: number) =>
      new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener('seeked', onSeeked)
          video.removeEventListener('error', onErr)
          opts.signal?.removeEventListener('abort', onAbort)
          clearTimeout(timer)
        }
        const onSeeked = () => {
          cleanup()
          resolve()
        }
        const onErr = () => {
          cleanup()
          reject(new Error('The recording could not be decoded while seeking.'))
        }
        const onAbort = () => {
          cleanup()
          reject(new DOMException('Recompute cancelled', 'AbortError'))
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('Seeking stalled while reading the recording.'))
        }, 5000)
        video.addEventListener('seeked', onSeeked)
        video.addEventListener('error', onErr)
        opts.signal?.addEventListener('abort', onAbort)
        video.currentTime = Math.min(t, duration)
      })

    const engine = await createPoseEngine()
    throwIfAborted() // the engine download (~5.7MB) can outlast a cancel — bail before looping
    try {
      const detector = createRepDetector(cfg)
      const reps: RepMetrics[] = []
      const dt = 1 / fps
      let frame = 0
      for (let t = 0; t < duration - 1e-3; t += dt, frame += 1) {
        throwIfAborted()
        await seekTo(t)
        if (video.videoWidth > 0) {
          let landmarks = null
          try {
            landmarks = engine.detect(video, Math.round(t * 1000) + 1)
          } catch {
            landmarks = null
          }
          if (landmarks) {
            const sample = extractSignal(landmarks, cfg)
            if (sample) reps.push(...stepRepDetector(detector, sample.y, t, frame))
          }
        }
        opts.onProgress?.(Math.min(1, t / duration))
      }
      reps.push(...finalizeRepDetector(detector))
      opts.onProgress?.(1)
      return { reps, fps, durationMs: duration * 1000 }
    } finally {
      engine.close()
    }
  } finally {
    try {
      video.pause()
    } catch {
      /* ignore */
    }
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
