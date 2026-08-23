import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  getWard, compareWards, findSimilar, rankWards, cityStats, resolveWard,
  filterWards, checkNumbers, checkCausalLanguage, WARDS,
} from '../lib/facts.mjs'
import { interventionsFor } from '../lib/interventions.mjs'

// Built-environment counts are optional: the rules run on satellite measures
// alone and simply gain sharper evidence when the OSM extraction has been run.
let OSM = null
try {
  const here = dirname(fileURLToPath(import.meta.url))
  OSM = JSON.parse(readFileSync(join(here, '..', 'data', 'osm.json'), 'utf8')).wards
} catch { OSM = null }

const WARD_NAMES = WARDS.map((w) => w.ward)

/**
 * Two calls with a deterministic layer between them.
 *
 * Call 1 sees the question and returns a routing decision — no data. The tools
 * then compute every figure. Call 2 sees only those computed figures and writes
 * prose around them; it never sees the dataset, so it has nothing to misreport.
 * Splitting it this way is what makes the number check downstream meaningful:
 * any digit in the answer that is not in the fact bundle is provably invented.
 */
export const ROUTER_PROMPT = `You route questions for THERMIS, a heat-vulnerability map of Ahmedabad's 48 municipal wards.
Return JSON only.

Decide "intent":
- "ward"     — about one named ward.
- "compare"  — contrasts two named wards.
- "rank"     — asks which wards are highest/lowest on something.
- "filter"   — asks which wards satisfy two or more conditions at once
               ("hot but not classed vulnerable", "dense and still green").
- "similar"  — asks for wards resembling one ward on some measure while
               differing on another ("somewhere like Odhav but greener").
- "intervention" — asks what could be done about a named ward: measures,
               governance options, "what should the city do here".
- "city"     — about the city as a whole or the dataset itself.
- "help"     — about the map, the layers, the score, or how to use this.
- "unclear"  — you cannot tell.

Shapes:
{"intent":"ward","ward":string}
{"intent":"compare","wardA":string,"wardB":string}
{"intent":"rank","metric":"lst"|"ndvi"|"population"|"popDensity"|"hvi","order":"desc"|"asc","n":integer 3-10}
{"intent":"filter","conditions":[{"metric":<metric>,"op":"gt"|"gte"|"lt"|"lte","ref":"min"|"q1"|"median"|"q3"|"max"|"mean"|<number>}]}
{"intent":"similar","ward":string,"similarOn":<metric>,"differOn":<metric>,"outcome":<metric>}
{"intent":"intervention","ward":string}
{"intent":"city"}
{"intent":"help","topic":string}
{"intent":"unclear","clarify":string}

Ward names must be copied from this list exactly:
${WARD_NAMES.join(', ')}

"hottest"/"最热" is metric "lst" order "desc". "greenest"/"绿化最好" is "ndvi" order "desc".
"most vulnerable"/"最脆弱" is "hvi" order "desc".

For "filter", give one condition per clause the user stated, at most four.
Prefer a named quantile over a made-up number: "hotter than average" is
{"metric":"lst","op":"gt","ref":"median"}.

For "similar", default similarOn to "popDensity", differOn to "ndvi" and
outcome to "lst" unless the question names others.

You never answer the question and never state a figure. Routing only.`

export const WRITER_PROMPT = `You write one short paragraph for THERMIS, a heat-vulnerability map of Ahmedabad.

You are given a FACTS object computed from Sentinel-2 / MODIS-derived ward statistics.

ABSOLUTE RULES
1. Every number you write must appear in FACTS. Never compute, round differently,
   estimate, or carry a number over from another ward. If a figure is not in
   FACTS, do not mention it.
2. Never assert causation. This is cross-sectional remote-sensing data; it cannot
   identify causes. Banned: because, due to, causes, caused by, leads to, results
   in, driven by, explains, responsible for — and their Chinese equivalents
   (因为/由于/导致/造成/使得/引起/之所以).
   Use instead: "alongside", "together with", "at the same time", "is associated
   with", "伴随", "同时", "相关".
3. Describe what is measured and how it ranks. Do not recommend a measure
   unless FACTS.matched contains it. When FACTS.matched is present, report only
   those measures, attribute each to the evidence beside it, and never add one
   of your own. When FACTS.matched is empty, say plainly that no measure's
   target conditions are met here — that is a result, not a failure. Never rank
   measures by cost, urgency or benefit; FACTS contains no such basis.
4. Reply in the language named by REPLY LANGUAGE. Three sentences at most.
   Plain prose, no lists, no markdown headings.

If FACTS contains "caveat", your last sentence must convey it.`

const ALLOWED_METRICS = ['lst', 'ndvi', 'population', 'popDensity', 'hvi']

export function parseRoute(content) {
  const raw = typeof content === 'string' ? JSON.parse(content) : content
  const intent = ['ward', 'compare', 'rank', 'filter', 'similar', 'intervention', 'city', 'help', 'unclear'].includes(raw?.intent) ? raw.intent : 'unclear'
  if (intent === 'ward') return { intent, ward: str(raw.ward, 60) }
  if (intent === 'compare') return { intent, wardA: str(raw.wardA, 60), wardB: str(raw.wardB, 60) }
  if (intent === 'filter') {
    const conditions = Array.isArray(raw.conditions) ? raw.conditions.slice(0, 4).map((c) => ({
      metric: ALLOWED_METRICS.includes(c?.metric) ? c.metric : null,
      op: ['gt', 'gte', 'lt', 'lte'].includes(c?.op) ? c.op : null,
      ref: typeof c?.ref === 'number' ? c.ref
        : (['min', 'q1', 'median', 'q3', 'max', 'mean'].includes(c?.ref) ? c.ref : null),
    })).filter((c) => c.metric && c.op && c.ref !== null) : []
    return { intent, conditions }
  }
  if (intent === 'similar') {
    const metric = (v, fallback) => ALLOWED_METRICS.includes(v) ? v : fallback
    return {
      intent,
      ward: str(raw.ward, 60),
      similarOn: metric(raw.similarOn, 'popDensity'),
      differOn: metric(raw.differOn, 'ndvi'),
      outcome: metric(raw.outcome, 'lst'),
    }
  }
  if (intent === 'intervention') return { intent, ward: str(raw.ward, 60) }
  if (intent === 'rank') {
    const n = Number(raw.n)
    return {
      intent,
      metric: ALLOWED_METRICS.includes(raw.metric) ? raw.metric : 'lst',
      order: raw.order === 'asc' ? 'asc' : 'desc',
      n: Number.isFinite(n) ? Math.min(10, Math.max(3, Math.round(n))) : 5,
    }
  }
  if (intent === 'help') return { intent, topic: str(raw.topic, 120) }
  if (intent === 'unclear') return { intent, clarify: str(raw.clarify, 200) }
  return { intent: 'city' }
}

/** Route to tools. Returns null when the route names something we don't have. */
export function gatherFacts(route) {
  switch (route.intent) {
    case 'ward': return getWard(route.ward)
    case 'compare': return compareWards(route.wardA, route.wardB)
    case 'rank': return rankWards(route.metric, { n: route.n, order: route.order })
    case 'filter': return route.conditions?.length ? filterWards(route.conditions) : null
    case 'similar': return findSimilar(route.ward, {
      similarOn: route.similarOn, differOn: route.differOn, outcome: route.outcome, k: 3,
    })
    case 'intervention': return interventionsFor(route.ward, OSM)
    case 'city': return cityStats()
    default: return null
  }
}

async function callModel(messages, { baseUrl, apiKey, model, json = false, timeoutMs = 20000 }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer))

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    const err = new Error(`upstream ${upstream.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
    err.reason = `upstream_${upstream.status}`
    throw err
  }
  return (await upstream.json()).choices?.[0]?.message?.content ?? ''
}

function send(res, status, body) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.json(body)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  const question = String(req.body?.question ?? '').trim()
  // The interface language, not a guess from the question: a Chinese reader
  // clicking a ward sends an English prompt built by the app, and should still
  // get Chinese prose back.
  const lang = req.body?.lang === 'zh' ? 'zh' : 'en'
  if (!question) return send(res, 400, { error: 'question is required' })
  if (question.length > 500) return send(res, 400, { error: 'question is too long' })

  const baseUrl = process.env.AI_BASE_URL?.replace(/\/$/, '')
  const apiKey = process.env.AI_API_KEY
  const model = process.env.AI_MODEL
  if (!baseUrl || !apiKey || !model) return send(res, 503, { error: 'analyzer is not configured' })
  const cfg = { baseUrl, apiKey, model }

  try {
    const route = parseRoute(await callModel(
      [{ role: 'system', content: ROUTER_PROMPT }, { role: 'user', content: question }],
      { ...cfg, json: true },
    ))

    if (route.intent === 'unclear') return send(res, 200, { route, answer: route.clarify, facts: null })
    if (route.intent === 'help') return send(res, 200, { route, answer: null, facts: null })

    const facts = gatherFacts(route)
    if (!facts) {
      const named = route.ward ?? route.wardA ?? ''
      return send(res, 200, {
        route,
        facts: null,
        answer: null,
        unresolved: named || null,
        // Naming the miss beats answering about the wrong ward.
        note: named && !resolveWard(named) ? `No ward matching "${named}".` : null,
      })
    }

    // Two attempts: the retry names the specific violation, which is far more
    // effective than asking again and hoping.
    let answer = null, validation = null
    for (let attempt = 0; attempt < 2 && !answer; attempt++) {
      const messages = [
        { role: 'system', content: WRITER_PROMPT },
        { role: 'user', content: `REPLY LANGUAGE: ${lang === 'zh' ? 'Chinese (简体中文)' : 'English'}\n\nQUESTION: ${question}\n\nFACTS:\n${JSON.stringify(facts, null, 1)}` },
      ]
      if (validation) messages.push({ role: 'user', content: `Your previous reply was rejected: ${validation}. Rewrite it.` })

      const draft = (await callModel(messages, cfg)).trim()
      const nums = checkNumbers(draft, facts)
      const causal = checkCausalLanguage(draft)
      if (nums.ok && causal.ok) { answer = draft; validation = null; break }
      validation = [
        nums.ok ? null : `it contained numbers not present in FACTS (${nums.unsupported.join(', ')})`,
        causal.ok ? null : 'it asserted causation, which this data cannot support',
      ].filter(Boolean).join('; ')
    }

    return send(res, 200, {
      route,
      facts,
      answer,
      // A rejected answer is reported as rejected. The client shows the facts.
      rejected: answer ? null : validation,
    })
  } catch (error) {
    console.error('THERMIS analyze failed:', error.message)
    return send(res, 502, {
      error: 'analysis failed',
      reason: error.reason ?? (error.name === 'AbortError' ? 'upstream_timeout' : 'gateway_error'),
    })
  }
}

function str(v, n) { return v ? String(v).slice(0, n) : null }
