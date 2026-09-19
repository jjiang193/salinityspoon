import { useState } from 'react';

type Theme = 'light' | 'dark';

/**
 * Light is the clinical default; dark stays for the demo table and for anyone
 * reading at night. index.html applies the saved choice before first paint, so
 * this only has to flip it.
 *
 * The charts need no notification: every colour they draw is a CSS variable,
 * so they re-theme with the rest of the page.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
  );

  function flip() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* private window: the choice simply lasts until reload */
    }
    setTheme(next);
  }

  return (
    <button type="button" className="theme-toggle" onClick={flip}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
