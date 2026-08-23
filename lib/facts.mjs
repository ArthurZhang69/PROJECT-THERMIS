/**
 * The tool layer. Every number the user ever reads is produced here.
 *
 * The language model is not given the dataset. It is given the output of these
 * functions and asked to write a sentence around it. That boundary is the whole
 * safety argument: a model that never holds the numbers cannot misreport them,
 * and the number-consistency check downstream can prove it didn't.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const DB = JSON.parse(readFileSync(join(here, '..', 'data', 'wards.json'), 'utf8'))

export const CITY = DB.city
export const WARDS = DB.wards

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const INDEX = new Map(WARDS.map((w) => [norm(w.ward), w]))

export const METRIC_LABELS = {
  lst: { label: 'Land surface temperature', unit: '°C', higherIsWorse: true },
  ndvi: { label: 'Vegetation index (NDVI)', unit: '', higherIsWorse: false },
  population: { label: 'Population', unit: '', higherIsWorse: null },
  popDensity: { label: 'Population density', unit: '/km²', higherIsWorse: null },
  hvi: { label: 'Heat vulnerability index', unit: '', higherIsWorse: true },
}

/** Resolve a user-supplied name to a ward, tolerating spacing and partial input. */
export function resolveWard(name) {
  const key = norm(name)
  if (!key) return null
  if (INDEX.has(key)) return INDEX.get(key)
  const partial = WARDS.filter((w) => norm(w.ward).includes(key) || key.includes(norm(w.ward)))
  return partial.length === 1 ? partial[0] : null
}

/** Everything the app can honestly say about one ward, counted not generated. */
export function getWard(name) {
  const w = resolveWard(name)
  if (!w) return null
  return {
    ward: w.ward,
    metrics: Object.fromEntries(Object.keys(METRIC_LABELS).map((m) => [m, {
      value: w[m],
      rank: w[`${m}Rank`],
      of: CITY.wardCount,
      percentile: w[`${m}Percentile`],
      vsMedian: w[`${m}VsMedian`],
      cityMedian: CITY[m].median,
    }])),
    hviClass: w.hviClass,
    areaKm2: w.areaKm2,
  }
}

/** Side-by-side difference on every metric. Direction is stated, not implied. */
export function compareWards(nameA, nameB) {
  const a = resolveWard(nameA), b = resolveWard(nameB)
  if (!a || !b) return null
  return {
    wards: [a.ward, b.ward],
    diffs: Object.fromEntries(Object.keys(METRIC_LABELS).map((m) => [m, {
      [a.ward]: a[m],
      [b.ward]: b[m],
      difference: round(a[m] - b[m], m === 'ndvi' || m === 'hvi' ? 4 : 2),
      higher: a[m] === b[m] ? null : (a[m] > b[m] ? a.ward : b.ward),
    }])),
  }
}

/**
 * Quasi-counterfactual: wards that resemble this one on `similarOn` but sit far
 * from it on `differOn`, with the resulting gap in `outcome`.
 *
 * This is matching, not identification. It is the strongest honest move
 * available on cross-sectional data — it narrows the comparison without
 * pretending the remaining differences are controlled. Callers must surface
 * `caveat` wherever they surface the numbers.
 */
export function findSimilar(name, { similarOn = 'popDensity', differOn = 'ndvi', outcome = 'lst', k = 3 } = {}) {
  const w = resolveWard(name)
  if (!w) return null
  const spread = CITY[similarOn].max - CITY[similarOn].min || 1
  const pool = WARDS
    .filter((o) => o.lgdCode !== w.lgdCode)
    .map((o) => ({
      ward: o.ward,
      similarity: round(1 - Math.abs(o[similarOn] - w[similarOn]) / spread, 3),
      [similarOn]: o[similarOn],
      [differOn]: o[differOn],
      [outcome]: o[outcome],
      differGap: round(o[differOn] - w[differOn], 4),
      outcomeGap: round(o[outcome] - w[outcome], 2),
    }))
    // Close on the matched variable first, then as far as possible on the contrast.
    .filter((o) => o.similarity >= 0.85)
    .sort((a, b) => Math.abs(b.differGap) - Math.abs(a.differGap))
    .slice(0, k)

  return {
    ward: w.ward,
    matchedOn: similarOn,
    contrastedOn: differOn,
    outcome,
    reference: { [similarOn]: w[similarOn], [differOn]: w[differOn], [outcome]: w[outcome] },
    matches: pool,
    caveat: 'Matched on one variable only. Remaining differences — industrial land use, building materials, surface cover — are uncontrolled, so this shows association, not cause.',
  }
}

/** Top or bottom N on a metric. */
export function rankWards(metric, { n = 5, order = 'desc' } = {}) {
  if (!METRIC_LABELS[metric]) return null
  const sorted = [...WARDS].sort((a, b) => order === 'desc' ? b[metric] - a[metric] : a[metric] - b[metric])
  return {
    metric,
    order,
    cityMedian: CITY[metric].median,
    wards: sorted.slice(0, n).map((w) => ({ ward: w.ward, value: w[metric], rank: w[`${metric}Rank`] })),
  }
}

/** Distribution summary for every metric. */
export function cityStats() {
  return { wardCount: CITY.wardCount, metrics: Object.fromEntries(Object.keys(METRIC_LABELS).map((m) => [m, CITY[m]])) }
}

/**
 * Pull every number out of a piece of prose and check each one appears in the
 * facts that produced it. A model that invents, rounds wrongly, or borrows a
 * neighbour's figure fails here — which is exactly how a wrong LST reached
 * production in the hand-written analyses this replaces.
 */
export function checkNumbers(text, facts) {
  const allowed = new Set()
  const collect = (v) => {
    if (typeof v === 'number') {
      allowed.add(round(v, 4)); allowed.add(round(v, 2)); allowed.add(round(v, 1)); allowed.add(Math.round(v))
      allowed.add(round(Math.abs(v), 2)); allowed.add(round(Math.abs(v), 1)); allowed.add(Math.round(Math.abs(v)))
    } else if (Array.isArray(v)) v.forEach(collect)
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  collect(facts)

  const found = [...String(text).matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')))
  const unsupported = found.filter((n) => Number.isFinite(n) && !allowed.has(n) && !allowed.has(round(n, 1)))
  return { ok: unsupported.length === 0, checked: found.length, unsupported }
}

/**
 * Cross-sectional remote sensing cannot identify causes, so the agent is not
 * allowed to write as though it had. Wording is checked rather than trusted:
 * "driven by dense industrial land use" is the failure mode, and it is fluent
 * enough that nobody reviewing the output would flag it.
 */
const CAUSAL = [
  /因为/, /由于/, /导致/, /造成/, /使得/, /引起/, /所以.*才/, /之所以/,
  /\bbecause\b/i, /\bcause[sd]?\b/i, /\bcausing\b/i, /\bdue to\b/i,
  /\bleads? to\b/i, /\bresults? in\b/i, /\bdriv(?:en|es|ing) by\b/i, /\bdriven\b/i,
  /\bexplains?\b/i, /\bresponsible for\b/i,
]
export function checkCausalLanguage(text) {
  const hits = CAUSAL.filter((re) => re.test(text)).map((re) => String(re))
  return { ok: hits.length === 0, hits }
}

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f }
