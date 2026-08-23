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

// The two capabilities that justify a language interface at all. A ranking or
// a single ward can be a button; "hot but not classed vulnerable" cannot,
// because the combination space is far larger than any menu.
test('multi-condition filtering finds the tension cases', async () => {
  const { filterWards } = await import('../lib/facts.mjs')
  const hotNotVulnerable = filterWards([
    { metric: 'lst', op: 'gt', ref: 'median' },
    { metric: 'hvi', op: 'lt', ref: 'median' },
  ])
  assert.ok(hotNotVulnerable.matchCount > 0 && hotNotVulnerable.matchCount < 48)
  // Every returned ward really satisfies every condition.
  const { WARDS, CITY } = await import('../lib/facts.mjs')
  for (const m of hotNotVulnerable.matches) {
    const w = WARDS.find((x) => x.ward === m.ward)
    assert.ok(w.lst > CITY.lst.median, `${m.ward} lst`)
    assert.ok(w.hvi < CITY.hvi.median, `${m.ward} hvi`)
  }
})

test('a filter refuses conditions it cannot evaluate rather than guessing', async () => {
  const { filterWards } = await import('../lib/facts.mjs')
  assert.equal(filterWards([{ metric: 'nonsense', op: 'gt', ref: 'median' }]), null)
  assert.equal(filterWards([{ metric: 'lst', op: 'approximately', ref: 'median' }]), null)
  assert.equal(filterWards([{ metric: 'lst', op: 'gt', ref: 'warm-ish' }]), null)
  assert.equal(filterWards([]), null)
})

test('an impossible filter reports zero matches, not an error', async () => {
  const { filterWards } = await import('../lib/facts.mjs')
  const none = filterWards([
    { metric: 'lst', op: 'gt', ref: 'max' },
    { metric: 'ndvi', op: 'lt', ref: 'min' },
  ])
  assert.equal(none.matchCount, 0)
  assert.deepEqual(none.matches, [])
})

test('the router accepts filter and similar, and clamps both', async () => {
  const { parseRoute, gatherFacts } = await import('../api/analyze.js')
  const f = parseRoute('{"intent":"filter","conditions":[{"metric":"lst","op":"gt","ref":"median"},{"metric":"junk","op":"gt","ref":"median"}]}')
  assert.equal(f.conditions.length, 1, 'the unusable condition is dropped, not guessed at')
  assert.ok(gatherFacts(f).matchCount > 0)

  const sim = parseRoute('{"intent":"similar","ward":"Odhav","differOn":"junk"}')
  assert.equal(sim.differOn, 'ndvi', 'falls back to a real metric')
  assert.ok(gatherFacts(sim).matches.length > 0)
})

// Policy text is where a language model is most convincing and least reliable,
// so the measures are chosen by thresholds and only described by the model.
// These tests are about discrimination: rules that fire everywhere are the
// same failure as the interchangeable paragraphs they replace.
test('measures discriminate between wards instead of firing everywhere', async () => {
  const { interventionsFor } = await import('../lib/interventions.mjs')
  const hot = interventionsFor('Odhav')
  const cool = interventionsFor('Paldi')
  assert.ok(hot.matchedCount > cool.matchedCount)
  assert.equal(cool.matchedCount, 0, 'the coolest ward should trigger nothing')
  assert.ok(hot.matchedCount <= hot.consideredCount)
})

test('every fired measure carries the numbers that fired it', async () => {
  const { interventionsFor } = await import('../lib/interventions.mjs')
  const { WARDS } = await import('../lib/facts.mjs')
  const r = interventionsFor('Odhav')
  const w = WARDS.find((x) => x.ward === 'Odhav')
  for (const m of r.matched) {
    assert.ok(m.evidence.length > 0, `${m.id} has no evidence`)
    assert.ok(m.unknowns.length > 0, `${m.id} claims to know everything`)
    for (const e of m.evidence) {
      assert.ok(Number.isFinite(e.value), `${m.id}: evidence value is not a number`)
      // Anything a reader sees exists in both languages; a Chinese panel with
      // English caveats undercuts exactly the credibility this layer is for.
      assert.ok(e.label.en && e.label.zh, `${m.id}: evidence label is not bilingual`)
    }
    assert.ok(m.measure.en && m.measure.zh, `${m.id}: measure name is not bilingual`)
    for (const u of m.unknowns) assert.ok(u.en && u.zh, `${m.id}: unknown is not bilingual`)
  }
  // Evidence values are the ward's real values, not restatements.
  const lstEv = r.matched.flatMap((m) => m.evidence).find((e) => e.label.en === 'Land surface temp')
  assert.equal(lstEv.value, w.lst)
})

test('the data gaps travel with every answer', async () => {
  const { interventionsFor, DATA_GAPS } = await import('../lib/interventions.mjs')
  assert.ok(DATA_GAPS.some((g) => g.id === 'population-structure'))
  for (const g of DATA_GAPS) {
    assert.ok(g.missing.en && g.missing.zh, `${g.id}: not bilingual`)
    assert.ok(g.consequence.en && g.consequence.zh, `${g.id}: consequence not bilingual`)
  }
  for (const ward of ['Odhav', 'Paldi']) {
    const r = interventionsFor(ward)
    assert.equal(r.dataGaps.length, DATA_GAPS.length, `${ward} dropped the gaps`)
    assert.match(r.disclaimer.en, /not a ranked plan/)
    assert.ok(r.disclaimer.zh.length > 0)
  }
})

test('OSM counts sharpen the evidence without being required', async () => {
  const { interventionsFor } = await import('../lib/interventions.mjs')
  const { WARDS } = await import('../lib/facts.mjs')
  const code = String(WARDS.find((w) => w.ward === 'Odhav').lgdCode)
  const withoutOsm = interventionsFor('Odhav')
  assert.equal(withoutOsm.osmAvailable, false)
  assert.equal(withoutOsm.builtEnvironment, null)

  const withOsm = interventionsFor('Odhav', {
    [code]: { ok: true, buildings: 1200, trees: 4, greenAreaKm2: 0.02, amenities: 9, waterPoints: 1,
      publicBuildings: [{ name: 'Odhav Municipal School', kind: 'school' }] },
  })
  assert.equal(withOsm.osmAvailable, true)
  assert.equal(withOsm.builtEnvironment.buildings, 1200)
  const centre = withOsm.matched.find((m) => m.id === 'cooling-centre')
  assert.equal(centre.siting.candidates[0].name, 'Odhav Municipal School')
  assert.match(centre.siting.note.en, /not as chosen locations/)
  assert.ok(centre.siting.note.zh.includes('不是已选定'))
})

test('a ward with no mapped public building says so rather than inventing one', async () => {
  const { interventionsFor } = await import('../lib/interventions.mjs')
  const { WARDS } = await import('../lib/facts.mjs')
  const code = String(WARDS.find((w) => w.ward === 'Odhav').lgdCode)
  const r = interventionsFor('Odhav', { [code]: { ok: true, buildings: 10, trees: 0, greenAreaKm2: 0, amenities: 0, waterPoints: 0, publicBuildings: [] } })
  const centre = r.matched.find((m) => m.id === 'cooling-centre')
  assert.deepEqual(centre.siting.candidates, [])
  assert.match(centre.siting.note.en, /gap in the map, not proof/)
  assert.ok(centre.siting.note.zh.includes('地图的缺失'))
})
