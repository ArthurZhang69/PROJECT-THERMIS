/**
 * Verify the 48 pre-generated ward analyses against the fact table.
 *
 * These strings were written by a model offline and hardcoded. Nothing has
 * ever checked them against the data they claim to describe. This is the
 * number-consistency check the upgrade plan specifies, pointed at the text
 * that is live on the site today.
 */
import { readFileSync } from 'node:fs'

const { wards } = JSON.parse(readFileSync('data/wards.json', 'utf8'))
const byName = new Map(wards.map((w) => [w.ward.toLowerCase(), w]))

const html = readFileSync('index.html', 'utf8')
const block = html.slice(html.indexOf('const WARD_ANALYSIS'))
const entries = [...block.matchAll(/"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/g)]

const CLAIMS = [
  { label: 'LST',  re: /LST of \*\*([\d.]+)°C|\*\*LST ([\d.]+)°C|\*\*([\d.]+)°C LST/g, field: 'lst',        tol: 0.06 },
  { label: 'NDVI', re: /NDVI of \*\*([\d.]+)|\*\*NDVI ([\d.]+)/g,                      field: 'ndvi',       tol: 0.0006 },
  { label: 'pop',  re: /\*\*([\d,]+) residents\*\*|of \*\*([\d,]+)\*\*/g,              field: 'population', tol: 1.5 },
  { label: 'HVI',  re: /HVI Class (\d)/g,                                              field: 'hviClass',   tol: 0 },
]

let checked = 0, bad = 0
const misses = []

for (const [, name, text] of entries) {
  const w = byName.get(name.toLowerCase())
  if (!w) { misses.push(`名称对不上事实表: ${name}`); continue }
  for (const { label, re, field, tol } of CLAIMS) {
    for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
      const raw = m.slice(1).find((x) => x !== undefined)
      if (raw === undefined) continue
      const claimed = Number(String(raw).replace(/,/g, ''))
      if (!Number.isFinite(claimed)) continue
      checked++
      if (Math.abs(claimed - w[field]) > tol) {
        bad++
        misses.push(`${name} · ${label}: 文案说 ${claimed}，数据是 ${w[field]}`)
      }
    }
  }
}

console.log(`静态文案数字核对：${entries.length} 个区，共检出 ${checked} 处数字`)
console.log(`  一致 ${checked - bad} / 不一致 ${bad}`)
if (misses.length) {
  console.log('\n不一致明细：')
  misses.forEach((m) => console.log('  ✗ ' + m))
}
