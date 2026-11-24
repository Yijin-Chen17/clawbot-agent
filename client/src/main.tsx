import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

if (typeof window !== 'undefined') {
  const PRELOAD_RELOAD_KEY = 'clawbot_preload_reloaded_at';
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    const lastReload = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) || '0');
    if (Date.now() - lastReload > 15000) {
      sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now()));
      window.location.reload();
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
