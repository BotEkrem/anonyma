import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/styles.css';

// After a deploy, a tab still running the old build asks for chunks that are
// gone. Vite reports that here: reload once to get the new build (not again
// within a minute, so a chunk that is really missing cannot loop).
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem('anonyma-chunk-reload') ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem('anonyma-chunk-reload', String(Date.now()));
  } catch {
    /* no storage: still reload once */
  }
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
