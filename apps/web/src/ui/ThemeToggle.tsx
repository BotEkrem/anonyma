import { useEffect, useState } from 'react';
import { Moon, Sun, iconStroke } from './icons';
import { applyTheme, currentTheme, toggleTheme, type Theme } from '../lib/theme';

import { squishSwitch } from './pieces';

// The switch is in the header on every page: start loading it with the app.
if (typeof window !== 'undefined') void squishSwitch.preload();

export function ThemeToggle() {
  // Start from the theme already on the page, so light-theme users do not see
  // the dark theme's icon on the first paint.
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    applyTheme(theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync the meta tag once on mount
  }, []);

  const icons = (
    <span className="theme-switch-icons" aria-hidden="true">
      <Sun strokeWidth={iconStroke} />
      <Moon strokeWidth={iconStroke} />
    </span>
  );
  // Until the squish switch loads: the same switch, still (no layout shift).
  const still = (
    <span className="theme-switch">
      <button
        type="button"
        role="switch"
        aria-checked={theme === 'dark'}
        aria-label="Dark theme"
        className="theme-switch-still"
        onClick={() => setTheme((prev) => toggleTheme(prev))}
      >
        {icons}
        <span className="theme-switch-still-thumb" aria-hidden="true" />
      </button>
    </span>
  );

  return (
    <squishSwitch.Piece
      fallback={still}
      className="theme-switch"
      checked={theme === 'dark'}
      onChange={(dark) => {
        const next: Theme = dark ? 'dark' : 'light';
        if (next !== theme) setTheme(toggleTheme(theme));
      }}
      ariaLabel="Dark theme"
      width={58}
      height={32}
      radius={16}
      trackColor="var(--surface-sunken)"
      trackOnColor="var(--surface-sunken)"
      thumbColor="var(--canvas)"
      thumbOnColor="var(--canvas)"
      trackContent={icons}
    />
  );
}
