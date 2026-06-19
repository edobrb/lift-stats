// One-Euro filter (Casiez et al.) — low-latency jitter removal for a noisy 1-D signal.
// Pure functions: each step returns a fresh state. Time is in seconds.

export interface OneEuroConfig {
  minCutoff: number // lower = smoother but more lag
  beta: number // higher = less lag on fast movements
  dCutoff: number // cutoff for the derivative used to drive adaptive smoothing
}

export const DEFAULT_ONE_EURO: OneEuroConfig = {
  minCutoff: 1.4,
  beta: 0.02,
  dCutoff: 1.0,
}

export interface OneEuroState {
  initialized: boolean
  lastTime: number
  xPrev: number
  dxPrev: number
}

export const createOneEuro = (): OneEuroState => ({
  initialized: false,
  lastTime: 0,
  xPrev: 0,
  dxPrev: 0,
})

const smoothingAlpha = (cutoff: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}

export const oneEuroStep = (
  state: OneEuroState,
  value: number,
  time: number,
  cfg: OneEuroConfig = DEFAULT_ONE_EURO,
): { state: OneEuroState; value: number } => {
  if (!state.initialized) {
    return {
      state: { initialized: true, lastTime: time, xPrev: value, dxPrev: 0 },
      value,
    }
  }
  const dt = Math.max(1e-3, time - state.lastTime)
  const dx = (value - state.xPrev) / dt
  const aD = smoothingAlpha(cfg.dCutoff, dt)
  const dxHat = state.dxPrev + aD * (dx - state.dxPrev)
  const cutoff = cfg.minCutoff + cfg.beta * Math.abs(dxHat)
  const aX = smoothingAlpha(cutoff, dt)
  const xHat = state.xPrev + aX * (value - state.xPrev)
  return {
    state: { initialized: true, lastTime: time, xPrev: xHat, dxPrev: dxHat },
    value: xHat,
  }
}
