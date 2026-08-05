const scriptPromises = {}

// Load a classic <script> on demand (returns a cached promise so repeated
// calls don't re-inject it). Used for heavy third-party libs like pdf.js and
// mammoth so they aren't downloaded and parsed on every app startup.
export function loadScript(src) {
  if (scriptPromises[src]) return scriptPromises[src]
  scriptPromises[src] = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => {
      delete scriptPromises[src]
      reject(new Error(`Failed to load ${src}`))
    }
    document.head.appendChild(script)
  })
  return scriptPromises[src]
}
