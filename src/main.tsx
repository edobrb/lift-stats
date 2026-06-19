import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import './styles.css'

// Register the service worker so the app (and the bundled pose model) work offline.
registerSW({ immediate: true })

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

// Intentionally not wrapped in <StrictMode>: its dev-only double mount/unmount
// would tear down and re-acquire the camera and WebGL pose context.
createRoot(root).render(<App />)
