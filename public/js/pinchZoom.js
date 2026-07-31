/**
 * Shared two-finger pinch-to-zoom / pan gesture helper.
 *
 * Attaches touch listeners to an element and reports pinch gestures via
 * callbacks so each viewer can apply the math to its own transform model.
 *
 *   attachPinchZoom(el, {
 *     getZoom,                    // () => current zoom (number)
 *     onPinch(zoom, midX, midY, panDx, panDy),  // pinch + two-finger pan
 *     onEnd,                      // () => fired when all touches lift (optional)
 *   })
 *
 * `midX`/`midY` are the current two-finger midpoint in client coords, and
 * `panDx`/`panDy` is the midpoint movement since the last event. `zoom` is
 * the unclamped scale relative to the gesture start.
 */
export function attachPinchZoom(el, { getZoom, onPinch, onEnd }) {
  let active = false
  let startDist = 0
  let startZoom = 1
  let lastMidX = 0
  let lastMidY = 0

  el.addEventListener('touchstart', onStart, { passive: false })
  el.addEventListener('touchmove', onMove, { passive: false })
  el.addEventListener('touchend', onEndHandler, { passive: false })
  el.addEventListener('touchcancel', onEndHandler, { passive: false })

  function onStart(e) {
    if (e.touches.length === 2) {
      active = true
      const [t0, t1] = e.touches
      startDist = Math.max(1, Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY))
      startZoom = getZoom()
      lastMidX = (t0.clientX + t1.clientX) / 2
      lastMidY = (t0.clientY + t1.clientY) / 2
      if (e.cancelable) e.preventDefault()
    }
  }

  function onMove(e) {
    if (!active || e.touches.length !== 2) return
    if (e.cancelable) e.preventDefault()
    const [t0, t1] = e.touches
    const dist = Math.max(1, Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY))
    const midX = (t0.clientX + t1.clientX) / 2
    const midY = (t0.clientY + t1.clientY) / 2
    onPinch(startZoom * (dist / startDist), midX, midY, midX - lastMidX, midY - lastMidY)
    lastMidX = midX
    lastMidY = midY
  }

  function onEndHandler(e) {
    if (e.touches.length < 2) {
      active = false
      if (e.touches.length === 0 && onEnd) onEnd()
    }
  }

  return function detach() {
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEndHandler)
    el.removeEventListener('touchcancel', onEndHandler)
  }
}
