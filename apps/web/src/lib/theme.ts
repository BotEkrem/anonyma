export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'anonyma-theme';

export function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark') {
      return value;
    }
  } catch {
    /* ignore */
  }
  return systemTheme();
}

/** No saved choice: follow the device, light (Mist) when it says nothing. */
function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The theme the page is showing now (theme-init.js sets it before React). */
export function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : readStoredTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  // The browser bar follows the theme too (it was fixed to the dark color).
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#e7e4ec' : '#141415');
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

export function toggleTheme(current: Theme): Theme {
  const next: Theme = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}
