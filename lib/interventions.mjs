import { WARDS, CITY, resolveWard, METRIC_LABELS } from './facts.mjs'

/**
 * Which heat measures a ward's measured conditions match.
 *
 * The 48 hand-written analyses this replaces all ended with a recommendation,
 * and those recommendations were interchangeable: shuffle them between wards
 * and almost nobody could tell. That is the failure mode for policy text from
 * a language model — fluent, plausible, and not actually derived from the
 * place it names.
 *
 * So the model does not choose measures here. Rules do, from thresholds on
 * measured values, and each fired rule carries the numbers that fired it. The
 * model's only job downstream is to say in prose what the rules already
 * decided.
 *
 * Two things this deliberately does NOT do:
 *   - Rank measures by cost or benefit. No cost data exists, and a made-up
 *     ranking would be the most damaging kind of confidence.
 *   - Target vulnerable groups. There is no age or income data at ward level
 *     in this dataset — see DATA_GAPS. A measure aimed at "the elderly" here
 *     would be aimed at nobody.
 */

export const DATA_GAPS = [
  {
    id: 'population-structure',
    missing: { en: 'Age, income and household composition by ward', zh: '分区的年龄、收入与家庭结构' },
    consequence: { en: 'Measures cannot be targeted at specific vulnerable groups, only at places. "Prioritise the elderly" is not something this tool can support.', zh: '措施只能落到「地方」，无法针对特定脆弱人群。「优先照顾老年人」这类判断，本工具给不了依据。' },
    wouldNeed: { en: 'Census of India ward-level tables, or municipal household survey data', zh: '印度人口普查的分区表，或市政入户调查数据' },
  },
  {
    id: 'building-fabric',
    missing: { en: 'Roof material, building height, structural suitability', zh: '屋顶材质、建筑高度、结构适用性' },
    consequence: { en: 'Whether a roof can take a cool coating, or a building can host a cooling centre, is unknown. Counts of buildings are not counts of candidates.', zh: '某个屋顶能否做冷涂装、某栋楼能否承载降温中心，都是未知。建筑数量不等于可用候选数量。' },
    wouldNeed: { en: 'Municipal building register, or classification from high-resolution imagery', zh: '市政建筑登记册，或高分辨率影像的分类结果' },
  },
  {
    id: 'cost-and-tenure',
    missing: { en: 'Land ownership, budget, existing programme coverage', zh: '土地权属、预算、现有项目覆盖情况' },
    consequence: { en: 'No measure here is costed or checked against what the city already runs. These are candidates for assessment, not a plan.', zh: '这里没有任何一项措施经过成本测算，也未与市政府已在执行的项目比对。它们是待评估的候选项，不是方案。' },
    wouldNeed: { en: 'AMC land records and Heat Action Plan implementation data', zh: 'AMC 土地记录与高温行动计划的执行数据' },
  },
]

const pct = (v, d = 1) => Number(v.toFixed(d))

/**
 * City-wide distribution of the OSM-derived measures, computed from whatever
 * the extraction actually returned.
 *
 * The first version compared green cover against a flat 5% of ward area, a
 * number chosen before any data existed. Ahmedabad's median mapped green cover
 * is 0.15% of ward area, so that test was true everywhere and the rule it
 * guarded never changed its mind. Thresholds have to come from the
 * distribution, not from what sounded reasonable in advance.
 */
let osmStatsCache = null
function osmStats(osmByCode) {
  if (osmStatsCache?.src === osmByCode) return osmStatsCache.stats
  const rows = WARDS
    .map((w) => ({ w, o: osmByCode?.[String(w.lgdCode)] }))
    .filter(({ o }) => o?.ok)
    .map(({ w, o }) => ({
      greenShare: (o.greenAreaKm2 ?? 0) / w.areaKm2,
      buildingDensity: (o.buildings ?? 0) / w.areaKm2,
    }))
  const q = (arr, p) => {
    if (!arr.length) return null
    const a = [...arr].sort((x, y) => x - y)
    const i = (a.length - 1) * p
    const lo = Math.floor(i)
    return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo)
  }
  const stats = rows.length >= 12 ? {
    n: rows.length,
    greenShare: { q1: q(rows.map((r) => r.greenShare), 0.25), median: q(rows.map((r) => r.greenShare), 0.5) },
    buildingDensity: { median: q(rows.map((r) => r.buildingDensity), 0.5), q3: q(rows.map((r) => r.buildingDensity), 0.75) },
  } : null
  osmStatsCache = { src: osmByCode, stats }
  return stats
}

/**
 * Fields OSM records so sparsely here that a low count says more about the map
 * than about the ward. They are shown, with this warning attached, and they
 * never gate a rule — 46 of 48 wards record zero drinking water points, and a
 * rule keyed on that would fire everywhere and mean nothing.
 */
export const SPARSE_FIELDS = {
  trees: { en: 'Individual trees are barely mapped in this city — a count of zero is almost certainly under-recording, not an absence of trees.', zh: '这座城市的独立树木几乎没有被测绘 —— 计数为 0 几乎可以肯定是记录缺失，而不是真的没有树。' },
  waterPoints: { en: '46 of 48 wards record no drinking water point at all, so this field reflects mapping coverage rather than provision.', zh: '48 个区里有 46 个记录为零饮水点，所以这个字段反映的是测绘覆盖，不是实际供给。' },
}

/**
 * Each rule states what it needs, what fired it, and what it cannot see.
 * `optional` fields sharpen the evidence when OSM data is present and are
 * simply absent otherwise — the rule still fires on the satellite measures.
 */
const RULES = [
  {
    id: 'street-trees',
    measure: { en: 'Street tree planting', zh: '行道树种植' },
    needs: ['ndvi', 'lst'],
    fires: (w) => w.ndvi < CITY.ndvi.median && w.lst > CITY.lst.median,
    evidence: (w, osm) => {
      const e = [
        { label: { en: 'NDVI', zh: 'NDVI' }, value: w.ndvi, rank: w.ndviRank, of: CITY.wardCount, comparedTo: CITY.ndvi.median },
        { label: { en: 'Land surface temp', zh: '地表温度' }, value: w.lst, rank: w.lstRank, of: CITY.wardCount, comparedTo: CITY.lst.median },
      ]
      if (osm?.greenAreaKm2 != null) {
        e.push({ label: { en: 'Green cover share (%)', zh: '绿地覆盖占比（%）' }, value: pct((osm.greenAreaKm2 / w.areaKm2) * 100, 2) })
      }
      return e
    },
    unknowns: [{ en: 'Pavement width and utility corridors decide where a tree can physically go.', zh: '人行道宽度与地下管线走廊决定了树实际能种在哪里。' }],
  },
  {
    id: 'cool-roofs',
    measure: { en: 'Cool roof coating programme', zh: '冷屋顶涂装' },
    needs: ['lst', 'popDensity'],
    fires: (w, osm, stats) => {
      if (!(w.lst > CITY.lst.median)) return false
      // With building counts, use them: a cool-roof programme is sized by roofs,
      // not by residents. Without them, population density stands in.
      if (stats && osm?.buildings != null) return (osm.buildings / w.areaKm2) > stats.buildingDensity.median
      return w.popDensity > CITY.popDensity.median
    },
    evidence: (w, osm) => {
      const e = [
        { label: { en: 'Land surface temp', zh: '地表温度' }, value: w.lst, rank: w.lstRank, of: CITY.wardCount, comparedTo: CITY.lst.median },
        { label: { en: 'Population density', zh: '人口密度' }, value: w.popDensity, rank: w.popDensityRank, of: CITY.wardCount, comparedTo: CITY.popDensity.median },
      ]
      if (osm?.buildings != null) {
        e.push({ label: { en: 'Buildings mapped in OSM', zh: 'OSM 已测绘建筑' }, value: osm.buildings })
        e.push({ label: { en: 'Buildings per km²', zh: '每平方公里建筑数' }, value: Math.round(osm.buildings / w.areaKm2) })
      }
      return e
    },
    unknowns: [{ en: 'Roof material and ownership are unknown; the building count is not a count of eligible roofs.', zh: '屋顶材质与产权未知；建筑数量不等于可施工屋顶数量。' }],
  },
  {
    id: 'cooling-centre',
    measure: { en: 'Daytime cooling centre', zh: '日间降温中心' },
    needs: ['lst', 'population'],
    fires: (w) => w.lst > CITY.lst.median && w.population > CITY.population.median,
    evidence: (w) => [
      { label: { en: 'Population', zh: '人口' }, value: w.population, rank: w.populationRank, of: CITY.wardCount, comparedTo: CITY.population.median },
      { label: { en: 'Land surface temp', zh: '地表温度' }, value: w.lst, rank: w.lstRank, of: CITY.wardCount, comparedTo: CITY.lst.median },
    ],
    siting: (w, osm) => osm?.publicBuildings?.length
      ? { candidates: osm.publicBuildings.slice(0, 6), note: { en: 'Public buildings mapped in OSM, offered as siting candidates to check — not as chosen locations.', zh: 'OSM 中已测绘的公共建筑，作为待核实的选址候选提供 —— 不是已选定的地点。' } }
      : (osm ? { candidates: [], note: { en: 'No public building is mapped in OSM for this ward, so no siting candidate can be offered. That is a gap in the map, not proof that none exists.', zh: '本区在 OSM 中没有任何已测绘的公共建筑，因此无法给出选址候选。这是地图的缺失，不能证明现实中不存在。' } } : null),
    unknowns: [{ en: 'Opening hours, capacity and whether the building is already in use are all unknown.', zh: '开放时间、容量、以及该建筑是否已被占用，均为未知。' }],
  },
  {
    id: 'water-points',
    measure: { en: 'Public drinking water points', zh: '公共饮水点' },
    needs: ['population', 'lst'],
    // Deliberately not gated on osm.waterPoints. That field is a coverage
    // artefact here, and a condition that is true for 46 of 48 wards is not a
    // condition — it is a rule that fires everywhere and discriminates nothing.
    fires: (w) => w.lst > CITY.lst.q3 && w.population > CITY.population.median,
    evidence: (w, osm) => {
      const e = [
        { label: { en: 'Population', zh: '人口' }, value: w.population, rank: w.populationRank, of: CITY.wardCount },
        { label: { en: 'Land surface temp', zh: '地表温度' }, value: w.lst, rank: w.lstRank, of: CITY.wardCount, comparedTo: CITY.lst.median },
      ]
      return e
    },
    unknowns: [{ en: 'OSM under-records water points; a low count may mean poor mapping rather than poor provision.', zh: 'OSM 对饮水点记录不全；数量低可能是测绘不足，而非供给不足。' }],
  },
  {
    id: 'new-green-space',
    measure: { en: 'New park or green space', zh: '新增公园绿地' },
    needs: ['ndvi', 'popDensity'],
    fires: (w, osm, stats) => {
      if (!(w.popDensity > CITY.popDensity.median)) return false
      if (stats && osm?.greenAreaKm2 != null) {
        // Bottom quartile of mapped green cover, measured against this city
        // rather than against an absolute share invented beforehand.
        return (osm.greenAreaKm2 / w.areaKm2) <= stats.greenShare.q1
      }
      return w.ndvi < CITY.ndvi.q1
    },
    evidence: (w, osm) => {
      const e = [
        { label: { en: 'NDVI', zh: 'NDVI' }, value: w.ndvi, rank: w.ndviRank, of: CITY.wardCount, comparedTo: CITY.ndvi.q1 },
        { label: { en: 'Population density', zh: '人口密度' }, value: w.popDensity, rank: w.popDensityRank, of: CITY.wardCount },
      ]
      if (osm?.greenAreaKm2 != null) {
        e.push({ label: { en: 'Green cover share (%)', zh: '绿地覆盖占比（%）' }, value: pct((osm.greenAreaKm2 / w.areaKm2) * 100, 2) })
      }
      return e
    },
    unknowns: [{ en: 'Land availability and ownership decide whether a site exists at all.', zh: '土地是否可用、归谁所有，决定了选址是否存在。' }],
  },
]

/**
 * @param osmByCode  Optional { [lgdCode]: {buildings, trees, ...} }. Absent
 *   means the satellite-only rules still run; present means they run with
 *   sharper evidence and siting candidates.
 */
export function interventionsFor(name, osmByCode = null) {
  const w = resolveWard(name)
  if (!w) return null
  const osm = osmByCode?.[String(w.lgdCode)]?.ok ? osmByCode[String(w.lgdCode)] : null

  const stats = osm ? osmStats(osmByCode) : null
  const matched = RULES
    .filter((r) => r.needs.every((f) => Number.isFinite(w[f])) && r.fires(w, osm, stats))
    .map((r) => ({
      id: r.id,
      measure: r.measure,
      evidence: r.evidence(w, osm),
      siting: r.siting ? r.siting(w, osm) : null,
      unknowns: r.unknowns,
    }))

  return {
    ward: w.ward,
    builtEnvironment: osm
      ? {
          buildings: osm.buildings, trees: osm.trees,
          greenAreaKm2: osm.greenAreaKm2,
          greenSharePct: pct((osm.greenAreaKm2 / w.areaKm2) * 100),
          publicAmenities: osm.amenities, waterPoints: osm.waterPoints,
          source: 'OpenStreetMap',
          // Shown so a reader can see the number and the reason not to trust it
          // in the same glance.
          sparse: Object.fromEntries(
            Object.entries(SPARSE_FIELDS).filter(([k]) => osm[k] != null)
          ),
        }
      : null,
    osmAvailable: Boolean(osm),
    matched,
    matchedCount: matched.length,
    consideredCount: RULES.length,
    // Travels with every answer. A measure list without these reads as a plan.
    dataGaps: DATA_GAPS,
    disclaimer: { en: 'These are measures whose target conditions this ward matches, derived from thresholds on measured values. They are candidates for assessment, not a ranked plan, and nothing here is costed.', zh: '以上是「触发条件在本区成立」的措施，由测量值的阈值判定得出。它们是待评估的候选项，不是排好优先级的方案，也没有任何成本测算。' },
  }
}

export const ALL_RULES = RULES.map((r) => ({ id: r.id, measure: r.measure }))
