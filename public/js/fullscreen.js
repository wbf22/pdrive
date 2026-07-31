/**
 * Shared fullscreen helpers with a graceful fallback for browsers that
 * don't support the native Fullscreen API (e.g. older iOS Safari).
 *
 * `initFullscreenButton` wires a toolbar button to a viewer wrapper element.
 * When native fullscreen is available it uses the Fullscreen API; otherwise
 * it toggles an `.app-fullscreen` overlay class. The returned function
 * detaches the listeners.
 */
export function isFullscreenSupported() {
  return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled)
}

export function isFullscreenElement(el) {
  return document.fullscreenElement === el || document.webkitFullscreenElement === el
}

export function requestFullscreen(el) {
  if (el.requestFullscreen) return el.requestFullscreen()
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen()
  return Promise.reject(new Error('Fullscreen not supported'))
}

export function exitFullscreen() {
  if (document.exitFullscreen) return document.exitFullscreen()
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen()
  return Promise.resolve()
}

export function initFullscreenButton(btn, wrapper) {
  const supported = isFullscreenSupported()

  const update = () => {
    const isFs = isFullscreenElement(wrapper) || wrapper.classList.contains('app-fullscreen')
    btn.textContent = isFs ? '⛶ Exit' : '⛶ Fullscreen'
    btn.title = isFs ? 'Exit Fullscreen' : 'Fullscreen'
  }

  const toggle = () => {
    if (supported) {
      if (isFullscreenElement(wrapper)) {
        exitFullscreen()
      } else {
        requestFullscreen(wrapper).catch(() => {})
      }
    } else {
      wrapper.classList.toggle('app-fullscreen')
      update()
    }
  }

  const onChange = () => {
    if (!isFullscreenElement(wrapper)) wrapper.classList.remove('app-fullscreen')
    update()
  }

  btn.addEventListener('click', toggle)
  wrapper.addEventListener('fullscreenchange', onChange)
  wrapper.addEventListener('webkitfullscreenchange', onChange)
  update()

  return () => {
    btn.removeEventListener('click', toggle)
    wrapper.removeEventListener('fullscreenchange', onChange)
    wrapper.removeEventListener('webkitfullscreenchange', onChange)
  }
}
