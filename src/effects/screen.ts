// Screen-level (DOM) effects: full-screen flashes, warning border, shake.

// Restart a CSS animation class on an element, then remove it after `ms`.
function restartClass(el: HTMLElement, cls: string, ms: number, alsoRemove: string[] = []) {
  el.classList.remove(cls, ...alsoRemove)
  void el.offsetWidth // force reflow
  el.classList.add(cls)
  setTimeout(() => el.classList.remove(cls), ms)
}

export function triggerNukeScreenEffects() {
  // Screen flash
  const flashEl = document.getElementById('nuke-screen-flash')
  if (flashEl) restartClass(flashEl, 'active', 3000)

  // Warning border
  const borderEl = document.getElementById('nuke-warning-border')
  if (borderEl) restartClass(borderEl, 'active', 5000)

  // Screen shake
  const globe = document.getElementById('globe-container')
  if (globe) restartClass(globe, 'nuke-shake', 1300)
}

export function triggerCombatScreenEffects() {
  // Subtle screen flash
  const flashEl = document.getElementById('nuke-screen-flash')
  if (flashEl) restartClass(flashEl, 'combat-flash', 600, ['active'])

  // Subtle screen shake
  const globe = document.getElementById('globe-container')
  if (globe) restartClass(globe, 'combat-shake', 500)
}

export function triggerBuildNukeScreenEffect() {
  const flashEl = document.getElementById('nuke-screen-flash')
  if (flashEl) restartClass(flashEl, 'radiation-flash', 1500, ['active', 'combat-flash'])
}

export function triggerBetrayalScreenEffect() {
  const borderEl = document.getElementById('nuke-warning-border')
  if (borderEl) restartClass(borderEl, 'betrayal-flash', 2000, ['active'])
}
