/* Runs before first paint (blocking, external so the CSP needs no inline script). Mirrors src/app/theme.ts. */
(function () {
  var bg = { dark: '#0b0c0e', oled: '#000000', light: '#f6f6f7', sepia: '#f3ead9' }
  var theme = 'dark'
  var accent = null
  try {
    var prefs = JSON.parse(localStorage.getItem('shelf.preferences') || '{}')
    theme = prefs.theme || theme
    accent = prefs.accent
  } catch (e) { /* defaults */ }
  if (theme === 'system') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  var root = document.documentElement
  root.setAttribute('data-theme', theme)
  if (accent) root.style.setProperty('--accent', accent)
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta && bg[theme]) meta.setAttribute('content', bg[theme])
  root.style.backgroundColor = bg[theme] || bg.dark
})()
