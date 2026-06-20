import { useEffect } from 'react'
import { useRoute, redirect, type Route } from './hooks/useRouter'
import { useApp } from './state/store'
import { BottomNav } from './components/BottomNav'
import { ProfilesScreen } from './screens/ProfilesScreen'
import { HomeScreen } from './screens/HomeScreen'
import { TrackingScreen } from './screens/TrackingScreen'
import { HistoryScreen } from './screens/HistoryScreen'
import { SetDetailScreen } from './screens/SetDetailScreen'

const FULLSCREEN: Route['name'][] = ['track']

const navTab = (name: Route['name']): Route['name'] => (name === 'setDetail' ? 'history' : name)

export const App = () => {
  const route = useRoute()
  const app = useApp()

  // No profile yet → force the profiles screen (it's where you make one).
  useEffect(() => {
    if (!app.profileId && route.name !== 'profiles') redirect({ name: 'profiles' })
  }, [app.profileId, route.name])

  const screen = (() => {
    switch (route.name) {
      case 'profiles':
        return <ProfilesScreen />
      case 'home':
        return <HomeScreen />
      case 'track':
        return <TrackingScreen />
      case 'history':
        return <HistoryScreen />
      case 'setDetail':
        return <SetDetailScreen id={route.id} />
    }
  })()

  const showNav = !FULLSCREEN.includes(route.name)

  return (
    <div className={`app${showNav ? '' : ' app--full'}`}>
      <main className="app__main">{screen}</main>
      {showNav && <BottomNav active={navTab(route.name)} />}
    </div>
  )
}
