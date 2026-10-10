// Classic, local script: runs before styles/React without weakening script-src CSP.
(() => {
  let theme = 'light';
  try { if (localStorage.getItem('omnipost.theme') === 'dark') theme = 'dark'; }
  catch { /* Default to warm paper when storage is unavailable. */ }
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
})();
