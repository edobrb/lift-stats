import { useSyncExternalStore } from 'react'
import type { ExerciseId, WeightUnit } from '../types'

// Minimal functional store: a value + listeners, consumed via useSyncExternalStore.

interface Store<T> {
  get: () => T
  set: (patch: Partial<T> | ((s: T) => T)) => void
  subscribe: (cb: () => void) => () => void
}

const createStore = <T>(initial: T, onChange?: (s: T) => void): Store<T> => {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (patch) => {
      state = typeof patch === 'function' ? (patch as (s: T) => T)(state) : { ...state, ...patch }
      onChange?.(state)
      listeners.forEach((l) => l())
    },
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

// ---- App preferences (persisted) ------------------------------------------

export interface AppState {
  profileId: string | null
  unit: WeightUnit
  recordVideo: boolean
}

const APP_KEY = 'lift-stats:prefs'

const loadApp = (): AppState => {
  const fallback: AppState = { profileId: null, unit: 'kg', recordVideo: true }
  try {
    const raw = localStorage.getItem(APP_KEY)
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<AppState>) } : fallback
  } catch {
    return fallback
  }
}

export const appStore = createStore<AppState>(loadApp(), (s) => {
  try {
    localStorage.setItem(APP_KEY, JSON.stringify(s))
  } catch {
    /* storage may be unavailable in private mode */
  }
})

// ---- Transient session (not persisted) ------------------------------------

export interface PendingSession {
  exercise: ExerciseId
  weight: number | null
}

export interface SessionState {
  pending: PendingSession | null
}

export const sessionStore = createStore<SessionState>({ pending: null })

// Hooks bound to each store.
export const useApp = (): AppState =>
  useSyncExternalStore(appStore.subscribe, appStore.get)

export const useSession = (): SessionState =>
  useSyncExternalStore(sessionStore.subscribe, sessionStore.get)
