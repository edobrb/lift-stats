import type { Landmark } from '../types'

// Thin functional wrapper around MediaPipe PoseLandmarker. The library is imported
// lazily (it touches `self`/`document` at module load and is several MB) so the
// heavy wasm + model only download once tracking actually starts.

export interface PoseEngine {
  detect: (video: HTMLVideoElement, timestampMs: number) => Landmark[] | null
  close: () => void
  delegate: 'GPU' | 'CPU'
}

const asset = (path: string): string => import.meta.env.BASE_URL + path

export const createPoseEngine = async (): Promise<PoseEngine> => {
  const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision')
  const vision = await FilesetResolver.forVisionTasks(asset('mediapipe/wasm'))
  const modelAssetPath = asset('mediapipe/models/pose_landmarker_lite.task')

  const build = (delegate: 'GPU' | 'CPU') =>
    PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    })

  // GPU is much faster, but on some iOS Safari builds WebGL2 fails LAZILY — the
  // failure surfaces on the first detect, not at createFromOptions. So we probe
  // the GPU graph with one detection before committing, and fall back to CPU.
  const buildEngine = async (): Promise<{
    lm: Awaited<ReturnType<typeof build>>
    delegate: 'GPU' | 'CPU'
  }> => {
    try {
      const gpu = await build('GPU')
      const probe = document.createElement('canvas')
      probe.width = 16
      probe.height = 16
      gpu.detectForVideo(probe, 0) // throws here if the GPU graph is broken
      return { lm: gpu, delegate: 'GPU' }
    } catch {
      return { lm: await build('CPU'), delegate: 'CPU' }
    }
  }

  const { lm: landmarker, delegate } = await buildEngine()

  // detectForVideo requires strictly increasing ms timestamps for the lifetime of
  // the instance. Callers pass a monotonic clock (performance.now); this clamp is a
  // safety net against ties/regressions so the engine can be reused across sets.
  let lastTs = 0
  const detect = (video: HTMLVideoElement, timestampMs: number): Landmark[] | null => {
    const ts = timestampMs > lastTs ? timestampMs : lastTs + 1
    lastTs = ts
    const result = landmarker.detectForVideo(video, ts)
    return result.landmarks[0] ?? null
  }

  return { detect, close: () => landmarker.close(), delegate }
}
