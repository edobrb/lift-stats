# Lift Stats

Track the major lifts — **pull-up, squat, bench press, deadlift** — with your phone
camera. Pose tracking, rep counting and frame-precise eccentric/concentric timing all
run **on-device**. No backend, no account; everything is stored locally and works
offline as an installable PWA.

## What it does

- **Create profiles** and switch between athletes (local only).
- **Pick an exercise**, optionally enter a weight (kg/lb), and start tracking.
- **Live camera overlay** while recording: skeleton, rep count, current phase
  (eccentric / concentric) and a live phase timer.
- **Per-rep metrics**: eccentric & concentric duration (ms **and** frame counts),
  range of motion, mean & peak velocity, time-under-tension, velocity loss.
- **Review before saving**: see the per-rep breakdown and **remove any misdetected
  reps** (tap ✕) before the set is stored.
- **Saved video clip** of each set (stored locally in IndexedDB).
- **History** of every set with a per-rep breakdown and charts.

## How it works

| Concern | Approach |
|---|---|
| Pose tracking | MediaPipe **PoseLandmarker** (`@mediapipe/tasks-vision`), GPU with CPU fallback, model + wasm **self-hosted** for offline use |
| Frame timing | `requestVideoFrameCallback` → frame-precise `mediaTime` + `presentedFrames` (rAF fallback) |
| Rep / phase detection | per-exercise 1-D vertical signal → median + **One-Euro** smoothing → a hysteresis/ROM-gated state machine (`src/lib/repDetector.ts`) |
| Storage | IndexedDB via `idb` (profiles, sets, video blobs) |
| Offline | `vite-plugin-pwa` precaches the app + the ~5.7 MB pose model; the one needed wasm runtime is cached on first use (CacheFirst) |

Eccentric vs concentric labelling uses the gravity invariant: for an upright side-on
camera the load moving **down** (image-y increasing) is the eccentric phase and moving
**up** is concentric — true for all four lifts. `startsWith` only decides where a rep
boundary falls, so squat (starts at the top) and deadlift (starts at the bottom) each
count one rep per full cycle.

## Getting started

```bash
npm install            # also copies the MediaPipe wasm + downloads the pose model
npm run dev            # http://localhost:5173
```

`npm install` runs `scripts/setup-assets.mjs`, which copies the MediaPipe wasm runtime
out of `node_modules` and downloads `pose_landmarker_lite.task` into
`public/mediapipe/`. If you were offline during install, run it later:

```bash
npm run setup:assets
```

### Testing on a phone

Camera capture requires a **secure context**. `localhost` is fine on the same machine,
but a phone on your LAN needs HTTPS:

```bash
npm run dev:https      # serves over HTTPS (self-signed cert) on your LAN IP
```

Open the printed `https://<your-ip>:5173` on the phone and accept the certificate
warning. On iOS, tap **Start camera** (camera start requires a user gesture).

### Build

```bash
npm run build          # type-check + production bundle into dist/
npm run preview        # serve the built app
npm run check          # run the rep-detector test against synthetic lift signals
```

## Filming tips

- **Squat / Deadlift / Bench**: film from the **side**, whole body (or both wrists for
  bench) in frame, well lit, phone steady (a small tripod helps).
- **Pull-up**: film from the front or slightly to the side; keep your torso visible
  from full hang to chin-over-bar.

## Notes & limitations

- Velocity and ROM are **relative** (normalized to frame height), not absolute m/s —
  good for comparing reps within and across sets, not for calibrated VBT numbers.
- Offline precache includes the app + the ~5.7 MB model. The ~11 MB wasm runtime is
  cached the first time you start tracking, so do one set while online to be fully
  offline-ready afterwards.
- `npm audit` reports a dev-server-only esbuild/Vite advisory; `npm audit --omit=dev`
  is clean — it never affects the production bundle.
- Tested target browsers: Chrome (Android/desktop) and Safari 15.4+ (iOS). iOS Safari
  records MP4; Chrome records WebM — the app probes supported types automatically.
