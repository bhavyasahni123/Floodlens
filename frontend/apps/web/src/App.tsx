import { useEffect, useState } from 'react';
import './App.css';
import Planner from './components/Planner';
import Welcome from './components/Welcome';

// The planner lives at #plan so the browser back button returns to the welcome page.
const isPlanRoute = () => window.location.hash === '#plan';

export default function App() {
  const [planning, setPlanning] = useState(isPlanRoute);

  useEffect(() => {
    const onHash = () => setPlanning(isPlanRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!planning) return <Welcome onStart={() => (window.location.hash = 'plan')} />;
  return <Planner onHome={() => (window.location.hash = '')} />;
}
