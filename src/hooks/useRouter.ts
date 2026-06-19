import { useSyncExternalStore } from 'react'

export type Route =
  | { name: 'profiles' }
  | { name: 'home' }
  | { name: 'track' }
  | { name: 'review' }
  | { name: 'history' }
  | { name: 'setDetail'; id: string }

const toHash = (route: Route): string => {
  switch (route.name) {
    case 'profiles':
      return '#/profiles'
    case 'home':
      return '#/'
    case 'track':
      return '#/track'
    case 'review':
      return '#/review'
    case 'history':
      return '#/history'
    case 'setDetail':
      return `#/history/${encodeURIComponent(route.id)}`
  }
}

const parse = (hash: string): Route => {
  const path = hash.replace(/^#/, '')
  if (path === '' || path === '/') return { name: 'home' }
  if (path === '/profiles') return { name: 'profiles' }
  if (path === '/track') return { name: 'track' }
  if (path === '/review') return { name: 'review' }
  if (path === '/history') return { name: 'history' }
  const detail = path.match(/^\/history\/(.+)$/)
  if (detail && detail[1]) return { name: 'setDetail', id: decodeURIComponent(detail[1]) }
  return { name: 'home' }
}

export const navigate = (route: Route): void => {
  window.location.hash = toHash(route)
}

/** Replace history entry (used for redirects so Back doesn't loop). */
export const redirect = (route: Route): void => {
  window.history.replaceState(null, '', toHash(route))
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

const subscribe = (cb: () => void): (() => void) => {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export const useRoute = (): Route => {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => '',
  )
  return parse(hash)
}
