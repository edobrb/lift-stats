import { navigate, type Route } from '../hooks/useRouter'

const ITEMS: { name: Route['name']; label: string; icon: string; route: Route }[] = [
  { name: 'home', label: 'Train', icon: '🎥', route: { name: 'home' } },
  { name: 'history', label: 'History', icon: '📊', route: { name: 'history' } },
  { name: 'profiles', label: 'Profile', icon: '👤', route: { name: 'profiles' } },
]

export const BottomNav = ({ active }: { active: Route['name'] }) => (
  <nav className="bottomnav">
    {ITEMS.map((item) => (
      <button
        key={item.name}
        className={`bottomnav__item${active === item.name ? ' is-active' : ''}`}
        onClick={() => navigate(item.route)}
      >
        <span className="bottomnav__icon">{item.icon}</span>
        <span>{item.label}</span>
      </button>
    ))}
  </nav>
)
