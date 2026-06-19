// Pure formatting helpers for durations, dates and the relative metrics.

export const formatSeconds = (ms: number): string => {
  if (!isFinite(ms)) return '—'
  return `${(ms / 1000).toFixed(2)}s`
}

/** mm:ss for set/elapsed durations. */
export const formatClock = (ms: number): string => {
  if (!isFinite(ms) || ms < 0) return '0:00'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Tempo string like "2.10s ↓ / 1.30s ↑" (eccentric / concentric). */
export const formatTempo = (eccentricMs: number, concentricMs: number): string =>
  `${formatSeconds(eccentricMs)} ↓ / ${formatSeconds(concentricMs)} ↑`

/** ROM is a fraction of frame height; show as a percentage. */
export const formatRom = (rom: number): string => `${Math.round(rom * 100)}%`

/** Velocity is in normalized frame-heights per second (a relative metric). */
export const formatVelocity = (v: number): string => `${(v * 100).toFixed(0)} u/s`

export const formatDate = (epochMs: number): string => {
  const d = new Date(epochMs)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(1)} ${units[i]}`
}
