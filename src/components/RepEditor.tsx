import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Phase, PhaseKind, RepMetrics } from '../types'
import {
  applyPoints,
  boundaryLabel,
  phaseLabel,
  repBlocks,
  repPoints,
  repSegments,
  BOUNDARIES,
  type Boundary,
  type RepPoints,
} from '../lib/repEdit'
import { formatSeconds } from '../lib/timing'

// Timeline colour class per phase kind: down (eccentric) red, up (concentric) green,
// holds amber (a held pause at an extreme, drawn distinctly from the moving phases).
const SEG_CLASS: Record<PhaseKind, string> = {
  eccentric: 'down',
  concentric: 'up',
  holdTop: 'hold',
  holdBottom: 'hold',
}

// Which vertical zone a boundary handle's grip sits in, so coincident points (a collapsed
// hold) never stack on top of each other and both stay grabbable.
const HANDLE_ZONE: Record<Boundary, 'edge' | 'top' | 'bottom'> = {
  start: 'edge',
  enter1: 'top',
  leave1: 'bottom',
  enter2: 'top',
  end: 'edge',
}

// Advanced video tooling: rewatch the set and fine-tune each rep on a zoomed-in editor by
// dragging its phase boundaries — including the start/end of each hold — directly on the
// bar (frame-nudge for precision). Controlled: edits are pushed up via onChange.
export const RepEditor = ({
  blob,
  reps,
  startsWith,
  fps,
  onChange,
}: {
  blob: Blob
  reps: RepMetrics[]
  startsWith: Phase
  fps: number
  onChange: (reps: RepMetrics[]) => void
}) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const minimapRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<Boundary | null>(null)
  // Live rep loop range + whether the current playback is a rep-loop, read from the
  // coarse timeupdate handler without re-binding it every render.
  const loopRangeRef = useRef<{ start: number; end: number } | null>(null)
  const loopingRef = useRef(false)

  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(false)
  const [selected, setSelected] = useState(0)
  const [activeBoundary, setActiveBoundary] = useState<Boundary>('start')

  const step = 1 / (fps > 0 ? fps : 30)
  const fallbackEnd = reps.reduce((m, r) => Math.max(m, r.endMs / 1000), 1)
  const dur = duration > 0 && Number.isFinite(duration) ? duration : fallbackEnd

  useEffect(() => {
    const url = URL.createObjectURL(blob)
    const v = videoRef.current
    if (v) v.src = url
    return () => URL.revokeObjectURL(url)
  }, [blob])

  // MediaRecorder blobs often report duration = Infinity until you seek to the end.
  const onLoadedMetadata = () => {
    const v = videoRef.current
    if (!v) return
    if (!Number.isFinite(v.duration) || v.duration === 0) {
      const onSeeked = () => {
        setDuration(Number.isFinite(v.duration) ? v.duration : 0)
        v.currentTime = 0
        v.removeEventListener('seeked', onSeeked)
      }
      v.addEventListener('seeked', onSeeked)
      v.currentTime = 1e7
    } else {
      setDuration(v.duration)
    }
  }

  const onTimeUpdate = () => {
    const v = videoRef.current
    if (!v) return
    const range = loopRangeRef.current
    if (loopingRef.current && range && v.currentTime >= range.end) {
      // timeupdate is coarse — snap back to the rep start and keep looping.
      v.currentTime = range.start
      setCurrentTime(range.start)
      return
    }
    setCurrentTime(v.currentTime)
  }

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current
      if (!v) return
      const clamped = Math.min(Math.max(0, t), dur || 0)
      v.currentTime = clamped
      setCurrentTime(clamped)
    },
    [dur],
  )

  // Clamp the selection so removing a rep elsewhere can't leave it out of range.
  const sel = reps.length > 0 ? Math.min(selected, reps.length - 1) : -1
  const rep = sel >= 0 ? reps[sel] : undefined
  const points = useMemo(() => (rep ? repPoints(rep, startsWith) : null), [rep, startsWith])
  const blocks = useMemo(() => (points ? repBlocks(points, startsWith) : []), [points, startsWith])

  const repStart = points?.start ?? 0
  const repEnd = points?.end ?? 0

  // The zoom window frames the selected rep with a little padding for trimming the
  // start/end outward. Recomputed only when the selection (or duration) changes so it
  // stays rock-steady while dragging a handle.
  const zoom = useMemo(() => {
    if (!points) return { a: 0, b: Math.max(1, dur) }
    const span = Math.max(0.001, points.end - points.start)
    const pad = Math.max(0.4, span * 0.3)
    const a = Math.max(0, points.start - pad)
    const b = dur > 0 ? Math.min(dur, points.end + pad) : points.end + pad
    return { a, b: b > a ? b : a + span }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, dur])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      if (loop && points) {
        loopRangeRef.current = { start: points.start, end: points.end }
        loopingRef.current = true
        if (v.currentTime < points.start - 0.02 || v.currentTime >= points.end - 0.02) seek(points.start)
      } else {
        loopingRef.current = false
        loopRangeRef.current = null
      }
      void v.play()
    } else {
      v.pause()
    }
  }

  // Toggle looping. Crucially this takes effect IMMEDIATELY, even mid-playback: the
  // timeupdate handler reads loopingRef (not the React `loop` state), so we must sync the
  // ref here — otherwise turning the loop off while playing would keep snapping back.
  const toggleLoop = () => {
    setLoop((on) => {
      const next = !on
      const v = videoRef.current
      if (next && points) {
        loopRangeRef.current = { start: points.start, end: points.end }
        loopingRef.current = true
        if (v && !v.paused && (v.currentTime < points.start - 0.02 || v.currentTime >= points.end - 0.02)) {
          seek(points.start)
        }
      } else {
        loopingRef.current = false
        loopRangeRef.current = null
      }
      return next
    })
  }

  // Keep an in-flight loop tracking the live rep bounds (edits / reselection).
  useEffect(() => {
    if (loopingRef.current && points) loopRangeRef.current = { start: points.start, end: points.end }
  }, [points])

  // Whole-clip percentage (minimap) and zoom-window percentage (editor).
  const mpct = (sec: number) => `${dur > 0 ? Math.min(100, Math.max(0, (sec / dur) * 100)) : 0}%`
  const zpct = (sec: number) => {
    const w = zoom.b - zoom.a
    return `${w > 0 ? Math.min(100, Math.max(0, ((sec - zoom.a) / w) * 100)) : 0}%`
  }

  const boundaryTime = (b: Boundary): number => (points ? points[b] : 0)

  // Apply a new time to one boundary of the selected rep (clamped to its neighbours and
  // to the surrounding reps), then move the playhead there.
  const applyBoundary = (which: Boundary, t: number) => {
    if (!rep || !points) return
    const prevEnd = sel > 0 ? reps[sel - 1]!.endMs / 1000 : 0
    const nextStart = sel < reps.length - 1 ? reps[sel + 1]!.startMs / 1000 : dur
    const next: RepPoints = { ...points }
    const clamp = (lo: number, hi: number) => Math.min(Math.max(t, lo), hi)
    let landed = t
    if (which === 'start') landed = next.start = clamp(prevEnd, points.enter1)
    else if (which === 'enter1') landed = next.enter1 = clamp(points.start, points.leave1)
    else if (which === 'leave1') landed = next.leave1 = clamp(points.enter1, points.enter2)
    else if (which === 'enter2') landed = next.enter2 = clamp(points.leave1, points.end)
    else landed = next.end = clamp(points.enter2, nextStart)
    onChange(reps.map((r, i) => (i === sel ? applyPoints(r, next, startsWith, fps) : r)))
    seek(landed)
  }

  const nudge = (frames: number) => applyBoundary(activeBoundary, boundaryTime(activeBoundary) + frames * step)

  const timeFromPointer = (ref: HTMLDivElement | null, clientX: number, lo: number, hi: number) => {
    if (!ref) return lo
    const rect = ref.getBoundingClientRect()
    const f = Math.min(Math.max(0, (clientX - rect.left) / rect.width), 1)
    return lo + f * (hi - lo)
  }

  // --- Boundary handle dragging (zoom editor) ---
  const onHandleDown = (e: ReactPointerEvent, which: Boundary) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = which
    setActiveBoundary(which)
    videoRef.current?.pause()
  }
  const onHandleMove = (e: ReactPointerEvent) => {
    if (draggingRef.current) applyBoundary(draggingRef.current, timeFromPointer(zoomRef.current, e.clientX, zoom.a, zoom.b))
  }
  const onHandleUp = () => {
    draggingRef.current = null
  }

  // --- Scrubbing (empty zoom track or the minimap) ---
  const onZoomDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = null
    videoRef.current?.pause()
    loopingRef.current = false
    seek(timeFromPointer(zoomRef.current, e.clientX, zoom.a, zoom.b))
  }
  const onZoomMove = (e: ReactPointerEvent) => {
    if (!draggingRef.current && e.buttons > 0) seek(timeFromPointer(zoomRef.current, e.clientX, zoom.a, zoom.b))
  }

  const repAt = (t: number) => reps.findIndex((r) => t >= r.startMs / 1000 && t <= r.endMs / 1000)
  const onMinimapDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    videoRef.current?.pause()
    loopingRef.current = false
    const t = timeFromPointer(minimapRef.current, e.clientX, 0, dur)
    const hit = repAt(t) // tapping a rep selects it
    if (hit >= 0 && hit !== sel) {
      setSelected(hit)
      setActiveBoundary('start')
    }
    seek(t)
  }
  const onMinimapMove = (e: ReactPointerEvent) => {
    if (e.buttons > 0) seek(timeFromPointer(minimapRef.current, e.clientX, 0, dur))
  }

  const selectRep = (i: number) => {
    setSelected(i)
    setActiveBoundary('start')
    const r = reps[i]
    if (r) seek(r.startMs / 1000)
  }

  const inRep = currentTime >= repStart - 1e-3 && currentTime <= repEnd + 1e-3

  return (
    <div className="editor">
      <div className="editor__videowrap">
        <video
          ref={videoRef}
          className="replay"
          playsInline
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      </div>

      {/* Whole-set minimap: tap a rep to focus it, drag to scrub. */}
      <div className="minimap" ref={minimapRef} onPointerDown={onMinimapDown} onPointerMove={onMinimapMove}>
        {sel >= 0 && (
          <div className="minimap__band" style={{ left: mpct(repStart), width: mpct(repEnd - repStart) }} />
        )}
        {reps.map((r, i) => {
          const rs = r.startMs / 1000
          const re = r.endMs / 1000
          return (
            <div key={r.index} className={`minimap__rep${i === sel ? ' is-selected' : ''}`} title={`Rep ${i + 1}`}>
              <span className="minimap__num" style={{ left: mpct((rs + re) / 2) }}>
                {i + 1}
              </span>
              {repSegments(r, startsWith).map((s, j) => (
                <span
                  key={j}
                  className={`minimap__seg seg--${SEG_CLASS[s.kind]}`}
                  style={{ left: mpct(s.startSec), width: mpct(s.endSec - s.startSec) }}
                />
              ))}
            </div>
          )
        })}
        <span className="minimap__playhead" style={{ left: mpct(currentTime) }} />
      </div>

      <div className="legend">
        <span className="legend__item">
          <i className="legend__dot seg--down" /> Down
        </span>
        <span className="legend__item">
          <i className="legend__dot seg--up" /> Up
        </span>
        <span className="legend__item">
          <i className="legend__dot seg--hold" /> Hold
        </span>
      </div>

      {/* Zoomed editor for the selected rep. */}
      {points && (
        <div className="zoom" ref={zoomRef} onPointerDown={onZoomDown} onPointerMove={onZoomMove}>
          <div className="zoom__rest" style={{ left: 0, width: zpct(repStart) }} />
          <div className="zoom__rest" style={{ left: zpct(repEnd), right: 0 }} />

          {blocks.map((b, j) => {
            const w = b.endSec - b.startSec
            if (w <= 1e-6) return null
            const wide = w / Math.max(0.001, zoom.b - zoom.a) > 0.12
            return (
              <div
                key={j}
                className={`zoom__block seg--${SEG_CLASS[b.kind]}`}
                style={{ left: zpct(b.startSec), width: `calc(${zpct(b.endSec)} - ${zpct(b.startSec)})` }}
              >
                {wide && (
                  <span className="zoom__blocklabel">
                    {phaseLabel(b.kind)}
                    <em>{formatSeconds(w * 1000)}</em>
                  </span>
                )}
              </div>
            )
          })}

          {BOUNDARIES.map((b) => (
            <button
              key={b}
              className={`zhandle zhandle--${HANDLE_ZONE[b]}${activeBoundary === b ? ' is-active' : ''}`}
              style={{ left: zpct(boundaryTime(b)) }}
              onPointerDown={(e) => onHandleDown(e, b)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
              role="slider"
              aria-label={`${boundaryLabel(b, startsWith)} of rep ${sel + 1}`}
              aria-valuenow={Math.round(boundaryTime(b) * 1000)}
            >
              <span className="zhandle__line" />
              <span className="zhandle__pill">{boundaryLabel(b, startsWith)}</span>
            </button>
          ))}

          <span className={`zoom__playhead${inRep ? '' : ' is-out'}`} style={{ left: zpct(currentTime) }} />
        </div>
      )}

      <div className="transport">
        <button className="tbtn" aria-label="Jump to rep start" onClick={() => points && seek(points.start)}>
          ⏮
        </button>
        <button className="tbtn" aria-label="Nudge active boundary back one frame" onClick={() => nudge(-1)}>
          ◁
        </button>
        <button className="tbtn tbtn--play" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="tbtn" aria-label="Nudge active boundary forward one frame" onClick={() => nudge(1)}>
          ▷
        </button>
        <button className="tbtn" aria-label="Jump to rep end" onClick={() => points && seek(points.end)}>
          ⏭
        </button>
        <button
          className={`tbtn tbtn--loop${loop ? ' is-active' : ''}`}
          aria-pressed={loop}
          aria-label="Loop selected rep"
          title="Loop the selected rep while playing"
          onClick={toggleLoop}
        >
          🔁
        </button>
        <span className="transport__time">
          {formatSeconds(currentTime * 1000)} / {formatSeconds(dur * 1000)}
        </span>
      </div>

      <div className="rep-picker">
        {reps.map((r, i) => (
          <button key={r.index} className={`rep-pip${i === sel ? ' is-active' : ''}`} onClick={() => selectRep(i)}>
            {i + 1}
          </button>
        ))}
      </div>

      {rep && points && (
        <div className="card editor__panel">
          <div className="editor__row">
            <strong>Rep {sel + 1}</strong>
            <span className="muted small">
              {formatSeconds(rep.eccentricMs)} ↓ / {formatSeconds(rep.concentricMs)} ↑
              {(rep.holdTopMs ?? 0) + (rep.holdBottomMs ?? 0) > 0
                ? ` · ${formatSeconds((rep.holdTopMs ?? 0) + (rep.holdBottomMs ?? 0))} ⏸`
                : ''}
            </span>
          </div>
          <div className="bchips">
            {BOUNDARIES.map((b) => (
              <button
                key={b}
                className={`bchip${activeBoundary === b ? ' is-active' : ''}`}
                onClick={() => {
                  setActiveBoundary(b)
                  seek(boundaryTime(b))
                }}
              >
                <span className="bchip__label">{boundaryLabel(b, startsWith)}</span>
                <span className="bchip__time">{boundaryTime(b).toFixed(2)}s</span>
              </button>
            ))}
          </div>
          <p className="muted small">
            Drag a boundary on the bar, or pick one and use ◁ ▷ to nudge it frame-by-frame. Pull a “{boundaryLabel('enter1', startsWith)}” /
            “{boundaryLabel('leave1', startsWith)}” pair apart to set a pause.
          </p>
        </div>
      )}
    </div>
  )
}
