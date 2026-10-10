export type Theme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'omnipost.theme';

// The CSP-safe head script restores the saved theme before the first paint.
export function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); }
  catch { /* A blocked/full store must not disable the session's theme toggle. */ }
}
