/* Runs before first paint (blocking, external so the CSP needs no inline script). Replays what
   src/app/theme.ts last applied; the React app takes over from there. */
(function () {
  var saved = null
  try { saved = JSON.parse(localStorage.getItem('shelf.theme') || 'null') } catch (e) { /* defaults */ }
  if (!saved || !saved.vars) return
  var root = document.documentElement
  root.setAttribute('data-theme', saved.theme)
  root.setAttribute('data-tone', saved.tone)
  for (var name in saved.vars) root.style.setProperty(name, saved.vars[name])
  root.style.backgroundColor = saved.bg
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', saved.bg)
})()
