import { PhoneView } from './views/PhoneView'
import { ProjectorView } from './views/ProjectorView'

function App() {
  const path = window.location.pathname
  if (path === '/screen') return <ProjectorView />
  return <PhoneView />
}

export default App
