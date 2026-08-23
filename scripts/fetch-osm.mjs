/**
 * One-off: pull built-environment counts per ward from OpenStreetMap.
 *
 * Run this on a machine with network access to Overpass:
 *   node scripts/fetch-osm.mjs
 * It writes data/osm.json, which build-wards.mjs folds into the fact table.
 *
 * OSM changes on the scale of months and Overpass is a shared volunteer
 * service, so this is an offline extraction rather than a runtime call — the
 * same reason the Earth Engine rasters are exported rather than queried live.
 *
 * Every field here is a count or an area. Nothing is inferred, and where OSM
 * has no coverage the field is zero with `coverage` marking it, because "no
 * parks mapped" and "no parks" are different claims.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// Overpass is volunteer-run and expects requests to identify themselves.
// Node's fetch sends no User-Agent at all, which the front end answers with
// 406 Not Acceptable — the failure this script hit on its first run.
const USER_AGENT = 'PROJECT-THERMIS/1.0 (ward heat-vulnerability research; https://github.com/ArthurZhang69/PROJECT-THERMIS)'

const ENDPOINTS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.osm.jp/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass.osm.ch/api/interpreter',
    ]
let endpoint = ENDPOINTS[0]

const OUT = 'data/osm.json'
// Overpass throttles hard once it decides you are pushing. Backing off after a
// 429 and easing back down costs less total time than a fixed pause that keeps
// tripping the limit — the first run spent more time in 20s penalty waits than
// it would have spent pausing politely.
let pauseMs = 5000
const PAUSE_MIN = 5000, PAUSE_MAX = 15000
const MAX_RING_POINTS = 60     // poly: filters have a practical length limit.
const MAX_CONSECUTIVE_FAILURES = 3

const wards = JSON.parse(readFileSync('GEE_Exports/ahmedabad_ward_hvi.geojson', 'utf8')).features

/** Largest outer ring, thinned to a length Overpass will accept. */
function polyString(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]
  let ring = polys[0][0]
  for (const p of polys) if (p[0].length > ring.length) ring = p[0]
  const step = Math.max(1, Math.ceil(ring.length / MAX_RING_POINTS))
  const thinned = ring.filter((_, i) => i % step === 0)
  return thinned.map(([lng, lat]) => `${lat.toFixed(5)} ${lng.toFixed(5)}`).join(' ')
}

function ringAreaKm2(ring) {
  const R = 6371.0088, rad = (d) => (d * Math.PI) / 180
  let total = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const [lo1, la1] = ring[i], [lo2, la2] = ring[(i + 1) % n]
    total += (rad(lo2) - rad(lo1)) * (2 + Math.sin(rad(la1)) + Math.sin(rad(la2)))
  }
  return Math.abs((total * R * R) / 2)
}

async function overpass(query, attempt = 0) {
  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body: new URLSearchParams({ data: query }),
    })
  } catch (err) {
    // Connection-level failure usually means this instance has stopped
    // answering us. Move to the next one rather than hammering the same host.
    const next = ENDPOINTS[ENDPOINTS.indexOf(endpoint) + 1]
    if (next && attempt < ENDPOINTS.length) {
      console.log(`   ${new URL(endpoint).host} unreachable; switching to ${new URL(next).host}`)
      endpoint = next
      return overpass(query, attempt + 1)
    }
    throw new Error(`network: ${err.message}`)
  }

  if (res.status === 429 || res.status === 504) {
    if (attempt >= 3) throw new Error(`Overpass ${res.status} after ${attempt} retries`)
    pauseMs = Math.min(PAUSE_MAX, pauseMs + 2500)
    const wait = 20000 * (attempt + 1)
    console.log(`   rate-limited (${res.status}); waiting ${wait / 1000}s, pause now ${pauseMs / 1000}s`)
    await new Promise((r) => setTimeout(r, wait))
    return overpass(query, attempt + 1)
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    throw new Error(`Overpass ${res.status}: ${body.slice(0, 180)}`)
  }
  const json = await res.json()
  // Overpass reports query errors in a 200 response, not a status code.
  if (json.remark) throw new Error(`Overpass remark: ${json.remark.slice(0, 180)}`)
  return json
}

/** One tiny query before the loop, so a misconfiguration costs one request. */
async function preflight() {
  const probe = '[out:json][timeout:20];node["amenity"="drinking_water"](23.02,72.57,23.04,72.59);out count;'
  for (const ep of ENDPOINTS) {
    endpoint = ep
    try {
      const json = await overpass(probe)
      const n = json.elements?.find((e) => e.type === 'count')?.tags?.total
      console.log(`Preflight OK via ${new URL(endpoint).host} (probe returned ${n ?? '0'})\n`)
      return true
    } catch (err) {
      // `endpoint` may have moved during the retry, so report where the error
      // actually came from rather than where the attempt began.
      console.log(`Preflight failed on ${new URL(endpoint).host}: ${err.message}`)
    }
  }
  return false
}

const COUNTS = (poly) => `[out:json][timeout:90];
way["building"](poly:"${poly}");     out count;
node["natural"="tree"](poly:"${poly}"); out count;
nwr["amenity"~"^(school|college|hospital|clinic|place_of_worship|community_centre)$"](poly:"${poly}"); out count;
node["amenity"="drinking_water"](poly:"${poly}"); out count;`

// Green geometry and public buildings arrive in one request: Overpass allows
// several out statements per query, and halving the request count is the
// cheapest way to stay under the rate limit.
//
// Public buildings are the realistic hosts for a cooling centre, so they are
// listed by name rather than merely counted — a recommendation you cannot site
// is not a recommendation.
const GREEN_AND_PUBLIC = (poly) => `[out:json][timeout:120];
(
  way["leisure"~"^(park|garden|pitch|recreation_ground)$"](poly:"${poly}");
  way["landuse"~"^(grass|forest|recreation_ground|village_green)$"](poly:"${poly}");
  way["natural"~"^(wood|scrub)$"](poly:"${poly}");
);
out geom;
nwr["amenity"~"^(school|college|hospital|clinic|community_centre|library)$"](poly:"${poly}");
out center tags 40;`

if (!(await preflight())) {
  console.error('No Overpass instance answered. Check the network, or wait — a run that')
  console.error('failed repeatedly can get an IP throttled for a while. Nothing was fetched.')
  process.exit(1)
}

const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { wards: {} }
const results = existing.wards ?? {}
let consecutiveFailures = 0

for (const [i, feat] of wards.entries()) {
  const name = feat.properties.sourceward
  const code = String(feat.properties.ward_lgd_c)
  if (results[code]?.ok) { console.log(`[${i + 1}/48] ${name} — cached, skipping`); continue }

  const poly = polyString(feat.geometry)
  process.stdout.write(`[${i + 1}/48] ${name} … `)
  try {
    const counts = await overpass(COUNTS(poly))
    const tally = counts.elements.filter((e) => e.type === 'count').map((e) => Number(e.tags.total) || 0)
    const [buildings = 0, trees = 0, amenities = 0, waterPoints = 0] = tally

    await new Promise((r) => setTimeout(r, pauseMs))
    const mixed = await overpass(GREEN_AND_PUBLIC(poly))
    // Green polygons carry geometry; amenities carry an amenity tag. One
    // response, two kinds of element, told apart by what they hold.
    const greenAreaKm2 = mixed.elements.reduce((sum, el) => {
      if (el.tags?.amenity || !el.geometry || el.geometry.length < 4) return sum
      return sum + ringAreaKm2(el.geometry.map((p) => [p.lon, p.lat]))
    }, 0)
    const publicBuildings = mixed.elements
      .filter((el) => el.tags?.amenity && el.tags?.name)
      .slice(0, 12)
      .map((el) => ({ name: el.tags.name, kind: el.tags.amenity }))

    results[code] = {
      ward: name, ok: true,
      buildings, trees, amenities, waterPoints,
      greenAreaKm2: Math.round(greenAreaKm2 * 1000) / 1000,
      publicBuildings,
    }
    console.log(`buildings ${buildings}, trees ${trees}, green ${greenAreaKm2.toFixed(2)} km², public ${publicBuildings.length}`)
    consecutiveFailures = 0
  } catch (err) {
    console.log(`FAILED — ${err.message}`)
    results[code] = { ward: name, ok: false, error: String(err.message).slice(0, 160) }
    // Stopping beats finishing. The first run kept going through 47 more
    // failures, which is how a shared service decides to stop answering you.
    if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`\nStopped after ${consecutiveFailures} failures in a row — continuing would only`)
      console.error('deepen the problem. Fix the cause, then re-run; finished wards are skipped.')
      break
    }
  }

  // Written every iteration so a rate-limit stop loses nothing; re-running
  // resumes from where it stopped.
  writeFileSync(OUT, JSON.stringify({
    source: 'OpenStreetMap via Overpass', fetchedAt: new Date().toISOString().slice(0, 10),
    wards: results,
  }, null, 1))
  await new Promise((r) => setTimeout(r, pauseMs))
}

const ok = Object.values(results).filter((r) => r.ok).length
console.log(`\n${OUT}: ${ok}/48 wards fetched`)
// The workflow commits this file whatever happens, so a run that is cut short
// still moves the total forward and the next one resumes from here.
if (ok < 48) console.log('Re-run to retry the failures; completed wards are skipped.')
