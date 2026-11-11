// Applies the saved theme before the first paint. A file of its own, not an
// inline script: the page's CSP (script-src 'self') blocks inline scripts.
(function () {
  try {
    var t = localStorage.getItem('anonyma-theme');
    if (t !== 'light' && t !== 'dark') {
      // No saved choice: follow the device, light when it says nothing.
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
