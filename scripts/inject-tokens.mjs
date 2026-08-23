/**
 * Substitute client tokens into the served HTML at build time.
 *
 * These tokens have to reach the browser — mapboxgl.accessToken is read
 * synchronously at load, and a Static Street View request carries its key in
 * the image URL. What they do not have to do is sit in git.
 *
 * The earlier GitHub Actions workflow did this same substitution and then
 * published the result to a public gh-pages branch, which is what exposed the
 * keys. Here the output is build artefact only: Vercel serves it, nothing
 * commits it, and the repository keeps no key-shaped strings — so GitHub's
 * scanner has nothing to alert on, correctly or otherwise.
 *
 * Protection comes from the restrictions on the tokens themselves: a URL
 * restriction on the Mapbox token, an HTTP-referrer restriction on the Google
 * key. Both must list the deployed domain.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const TARGETS = ['index.html', 'thermis_map.html']
const TOKENS = [
  { placeholder: 'YOUR_MAPBOX_TOKEN_HERE', env: 'MAPBOX_TOKEN', required: true, label: 'Mapbox' },
  { placeholder: 'YOUR_GOOGLE_MAPS_KEY_HERE', env: 'GOOGLE_MAPS_KEY', required: false, label: 'Street View' },
]

let failed = false

for (const file of TARGETS) {
  let html
  try { html = readFileSync(file, 'utf8') } catch { continue }

  for (const { placeholder, env, required, label } of TOKENS) {
    if (!html.includes(placeholder)) continue
    const value = process.env[env]
    if (!value) {
      // A required token missing means the map will not render. Failing the
      // build is louder than shipping a page that silently does nothing.
      if (required) { console.error(`✗ ${env} is not set — ${label} cannot work. Set it in the Vercel project.`); failed = true }
      else console.warn(`· ${env} not set — ${label} disabled (optional).`)
      continue
    }
    html = html.split(placeholder).join(value)
    console.log(`✓ ${file}: ${label} token injected`)
  }
  writeFileSync(file, html)
}

if (failed) process.exit(1)
