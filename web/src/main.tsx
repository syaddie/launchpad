import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@phosphor-icons/web/duotone/style.css';
import './styles.css';
import './designs.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable on a phone's home screen, and opens even when the server can't be reached (see public/sw.js).
// Service workers need HTTPS or localhost, so on the plain-HTTP LAN address this quietly does nothing.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker', e)));
}
