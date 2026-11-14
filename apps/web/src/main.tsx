import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
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

// A data router so a page can hold a navigation (useBlocker): a live call asks
// before another page ends it. App keeps its own <Routes> under the splat.
const router = createBrowserRouter([{ path: '*', element: <App /> }]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
