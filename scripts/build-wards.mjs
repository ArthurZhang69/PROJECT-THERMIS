/**
 * Merge the five per-attribute ward files into one fact table.
 *
 * The five GeoJSONs carry the same 48 polygons with one attribute each, so the
 * geometry is stored five times and no single file can answer "how does this
 * ward compare on everything at once" — which is the only question an
 * attribution agent ever asks. This collapses them into one record per ward
 * and precomputes every comparison the agent is allowed to make.
 *
 * Everything derived here is arithmetic. The language model never computes a
 * number; it only ever reads one back.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'GEE_Exports'
const read = (f) => JSON.parse(readFileSync(`${SRC}/${f}`, 'utf8'))

const FILES = {
  lst: ['ahmedabad_ward_lst.geojson', 'mean'],
  ndvi: ['ahmedabad_ward_ndvi.geojson', 'mean'],
  population: ['ahmedabad_ward_population.geojson', 'sum'],
  hvi: ['ahmedabad_ward_hvi.geojson', 'mean'],
  hviClass: ['ahmedabad_ward_hvi.geojson', 'hvi_class'],
  heatIndexClass: ['ahmedabad_ward_heat_index.geojson', 'heat_index'],
}

// Spherical excess over a lat/lng ring — good to well under a percent at
// city scale, and we only need it to turn population into a density.
function ringAreaKm2(ring) {
  const R = 6371.0088
  const rad = (d) => (d * Math.PI) / 180
  let total = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const [lon1, lat1] = ring[i]
    const [lon2, lat2] = ring[(i + 1) % n]
    total += (rad(lon2) - rad(lon1)) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)))
  }
  return Math.abs((total * R * R) / 2)
}

function polygonAreaKm2(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]
  // Outer ring minus holes, summed over parts.
  return polys.reduce((sum, rings) =>
    sum + rings.reduce((a, ring, i) => a + (i === 0 ? ringAreaKm2(ring) : -ringAreaKm2(ring)), 0), 0)
}

// ── assemble ──────────────────────────────────────────────────
const base = read(FILES.lst[0])
const wards = new Map()

for (const feat of base.features) {
  const p = feat.properties
  wards.set(p.ward_lgd_c, {
    ward: p.sourceward,
    wardNo: p.sourcewa_1,
    lgdCode: p.ward_lgd_c,
    areaKm2: round(polygonAreaKm2(feat.geometry), 3),
    centroid: centroid(feat.geometry),
  })
}

for (const [key, [file, field]] of Object.entries(FILES)) {
  for (const feat of read(file).features) {
    const w = wards.get(feat.properties.ward_lgd_c)
    if (w) w[key] = feat.properties[field]
  }
}

const rows = [...wards.values()]
if (rows.length !== 48) throw new Error(`expected 48 wards, got ${rows.length}`)

for (const w of rows) {
  for (const k of ['lst', 'ndvi', 'population', 'hvi']) {
    if (typeof w[k] !== 'number' || !Number.isFinite(w[k])) throw new Error(`${w.ward}: ${k} missing`)
  }
  w.lst = round(w.lst, 2)
  w.ndvi = round(w.ndvi, 4)
  w.hvi = round(w.hvi, 4)
  w.population = Math.round(w.population)
  w.popDensity = Math.round(w.population / w.areaKm2)
}

// ── derived comparisons ───────────────────────────────────────
// Percentile and rank are what let the agent say "8th lowest of 48" instead
// of an adjective it made up. Rank 1 = highest value.
const METRICS = ['lst', 'ndvi', 'population', 'popDensity', 'hvi']
const city = { wardCount: rows.length }

for (const m of METRICS) {
  const sorted = [...rows].sort((a, b) => b[m] - a[m])
  sorted.forEach((w, i) => {
    w[`${m}Rank`] = i + 1
    w[`${m}Percentile`] = round(((rows.length - i - 1) / (rows.length - 1)) * 100, 1)
  })
  const vals = rows.map((w) => w[m]).sort((a, b) => a - b)
  city[m] = {
    min: vals[0],
    q1: quantile(vals, 0.25),
    median: quantile(vals, 0.5),
    q3: quantile(vals, 0.75),
    max: vals[vals.length - 1],
    mean: round(vals.reduce((s, v) => s + v, 0) / vals.length, 4),
  }
  for (const w of rows) w[`${m}VsMedian`] = round(w[m] - city[m].median, m === 'ndvi' || m === 'hvi' ? 4 : 2)
}

rows.sort((a, b) => a.ward.localeCompare(b.ward))
writeFileSync('data/wards.json', JSON.stringify({ city, wards: rows }, null, 2))
console.log(`wards.json: ${rows.length} wards`)
console.log(`  LST      median ${city.lst.median}°C   range ${city.lst.min}–${city.lst.max}`)
console.log(`  NDVI     median ${city.ndvi.median}     range ${city.ndvi.min}–${city.ndvi.max}`)
console.log(`  density  median ${city.popDensity.median}/km²  range ${city.popDensity.min}–${city.popDensity.max}`)

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f }
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const v = sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo)
  return round(v, 4)
}
function centroid(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]
  let sx = 0, sy = 0, n = 0
  for (const rings of polys) for (const [x, y] of rings[0]) { sx += x; sy += y; n++ }
  return { lng: round(sx / n, 5), lat: round(sy / n, 5) }
}
