import test from 'node:test'
import assert from 'node:assert/strict'
import { getWard, compareWards, findSimilar, rankWards, resolveWard, checkNumbers, checkCausalLanguage, WARDS, CITY } from '../lib/facts.mjs'
import { parseRoute, gatherFacts } from '../api/analyze.js'

test('the fact table covers every ward with complete metrics', () => {
  assert.equal(WARDS.length, 48)
  for (const w of WARDS) {
    for (const m of ['lst', 'ndvi', 'population', 'popDensity', 'hvi']) {
      assert.ok(Number.isFinite(w[m]), `${w.ward}.${m}`)
      assert.ok(w[`${m}Rank`] >= 1 && w[`${m}Rank`] <= 48, `${w.ward}.${m}Rank`)
    }
  }
})

test('ranks are consistent with the values they rank', () => {
  const sorted = [...WARDS].sort((a, b) => b.lst - a.lst)
  assert.equal(sorted[0].lstRank, 1)
  assert.equal(sorted[47].lstRank, 48)
  assert.equal(rankWards('lst', { n: 1 }).wards[0].ward, sorted[0].ward)
  assert.equal(rankWards('lst', { n: 1, order: 'asc' }).wards[0].ward, sorted[47].ward)
})

test('ward lookup tolerates case and spacing but refuses ambiguity', () => {
  assert.equal(resolveWard('naroda').ward, 'Naroda')
  assert.equal(resolveWard('  NARODA ').ward, 'Naroda')
  assert.equal(resolveWard('Atlantis'), null)
})

test('vsMedian is a real difference from the real median', () => {
  const w = getWard('Naroda')
  assert.equal(w.metrics.lst.cityMedian, CITY.lst.median)
  const raw = WARDS.find((x) => x.ward === 'Naroda')
  assert.ok(Math.abs((raw.lst - CITY.lst.median) - w.metrics.lst.vsMedian) < 0.011)
})

test('comparison states which ward is higher rather than leaving it implied', () => {
  const c = compareWards('Odhav', 'Paldi')
  assert.equal(c.diffs.lst.higher, 'Odhav')
  assert.ok(c.diffs.lst.difference > 0)
})

// The matching result is the one place the app comes closest to a causal
// claim, so the caveat travels with the numbers rather than living in docs.
test('similar-ward matching always carries its caveat', () => {
  const s = findSimilar('Naroda')
  assert.ok(s.matches.length > 0)
  assert.match(s.caveat, /association, not cause/)
  for (const m of s.matches) assert.ok(m.similarity >= 0.85)
})

test('a number absent from the facts is caught', () => {
  const facts = { ward: 'Naroda', metrics: { lst: { value: 50.7, cityMedian: 48.85 } } }
  assert.ok(checkNumbers('Naroda records 50.7°C against a city median of 48.85°C.', facts).ok)
  const bad = checkNumbers('Naroda records 49.7°C.', facts)
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.unsupported, [49.7])
})

// This is the exact sentence shape that put a wrong figure into production.
test('causal phrasing is rejected in both languages', () => {
  assert.equal(checkCausalLanguage('LST is high, driven by dense industrial land use.').ok, false)
  assert.equal(checkCausalLanguage('绿地少导致该区更热。').ok, false)
  assert.equal(checkCausalLanguage('高温伴随较低的植被指数出现。').ok, true)
  assert.equal(checkCausalLanguage('LST is high alongside a low vegetation index.').ok, true)
})

test('the router clamps anything the model gets wrong', () => {
  const r = parseRoute('{"intent":"rank","metric":"nonsense","order":"sideways","n":900}')
  assert.equal(r.metric, 'lst')
  assert.equal(r.order, 'desc')
  assert.equal(r.n, 10)
  assert.equal(parseRoute('{"intent":"teleport"}').intent, 'unclear')
})

test('an unknown ward yields no facts rather than the wrong ward', () => {
  assert.equal(gatherFacts({ intent: 'ward', ward: 'Atlantis' }), null)
  assert.ok(gatherFacts({ intent: 'ward', ward: 'Naroda' }))
})
