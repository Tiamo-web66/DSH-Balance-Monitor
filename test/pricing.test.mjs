#!/usr/bin/env node
/**
 * 档位与计价纯函数验证（不出网、不碰宿主）。
 *
 *   node test/pricing.test.mjs
 *
 * 时间基准：官方窗口默认 `[1,4)` + `[6,10)`（UTC 小时）＝ 北京 09:00–12:00 / 14:00–18:00。
 * 用例里的时刻全部显式写 UTC，避免测试随机器时区漂移。
 */
import assert from 'node:assert/strict'

import {
  DEFAULT_OFFICIAL_PEAK,
  DEFAULT_PRICE_SOURCES,
  OFFICIAL_HOLIDAYS,
  PRICE_SOURCES,
  cacheHitRate,
  catalogVendors,
  costOf,
  creditsOf,
  creditsWeight,
  entrySource,
  findPriceEntry,
  findPriceEntryDetailed,
  isPeakHour,
  beijingDayKey,
  makeCallRecord,
  normalizeOfficialPeak,
  normalizePriceEntry,
  parseCredits,
  phaseAt,
  priceAt,
  priceCall,
  pricingFingerprint,
  resolveProviderRate,
  resolveTier,
  nextRelaySwitchAt,
  relayPeakFactor,
  summarizeRecords,
  tierFor,
  toUsd,
  upcomingSwitches,
  wallClockMinutes,
} from '../lib/pricing.js'
import { DEFAULT_PRICE_TABLE, PRICE_TABLE_META } from '../lib/price-table.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    const note = fn()
    passed++
    console.log(`  ok   ${name}${note === undefined ? '' : `  → ${note}`}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
const at = text => Date.parse(text)
function close(actual, expected, tolerance, label) {
  const ok = Math.abs(actual - expected) <= tolerance
  assert.ok(ok, `${label ?? 'value'}: 期望 ${expected} ± ${tolerance}，实际 ${actual}`)
}
function closeCost(call, expected, label) {
  assert.ok(call !== null, `${label ?? 'cost'}: 期望有值，实际 null（未定价）`)
  close(call, expected, 1e-12, label ?? 'cost')
}

// 2026-08-25 是周二（非周末、非假期）——官方峰谷判定的干净基准日
const TUE_PEAK = '2026-08-25T01:30:00Z' // 北京 09:30 → 高峰
const TUE_OFF = '2026-08-25T04:30:00Z' // 北京 12:30 → 低谷
const SAT_PEAK_HOURS = '2026-08-29T01:30:00Z' // 周六，小时落在高峰窗口但应判谷
const SUN_PEAK_HOURS = '2026-08-30T01:30:00Z'
const HOLIDAY = '2026-10-01T02:00:00Z' // 假期表内（国庆），北京 10:00

console.log('\n[官方峰谷：UTC 小时半开区间 [start, end)]')
test('四个边界点：0:59 谷 / 1:00 峰 / 3:59 峰 / 4:00 谷', () => {
  assert.equal(isPeakHour(at('2026-08-25T00:59:59Z')), false)
  assert.equal(isPeakHour(at('2026-08-25T01:00:00Z')), true)
  assert.equal(isPeakHour(at('2026-08-25T03:59:59Z')), true)
  assert.equal(isPeakHour(at('2026-08-25T04:00:00Z')), false)
})
test('第二个窗口：6:00 峰 / 9:59 峰 / 10:00 谷', () => {
  assert.equal(isPeakHour(at('2026-08-25T06:00:00Z')), true)
  assert.equal(isPeakHour(at('2026-08-25T09:59:59Z')), true)
  assert.equal(isPeakHour(at('2026-08-25T10:00:00Z')), false)
})
test('跨午夜窗口兼容（end <= start）：22:00–02:00', () => {
  const config = { ...DEFAULT_OFFICIAL_PEAK, windows: [{ start: 22, end: 2 }] }
  assert.equal(isPeakHour(at('2026-08-25T23:00:00Z'), config), true)
  assert.equal(isPeakHour(at('2026-08-25T01:00:00Z'), config), true)
  assert.equal(isPeakHour(at('2026-08-25T03:00:00Z'), config), false)
})
test('窗口为空 / enabled=false / 非整数小时 → 一律不是高峰', () => {
  assert.equal(isPeakHour(at(TUE_PEAK), { ...DEFAULT_OFFICIAL_PEAK, windows: [] }), false)
  assert.equal(isPeakHour(at(TUE_PEAK), { ...DEFAULT_OFFICIAL_PEAK, enabled: false }), false)
  assert.equal(isPeakHour(at(TUE_PEAK), { ...DEFAULT_OFFICIAL_PEAK, windows: [{ start: 1.5, end: 4 }] }), false)
})

console.log('\n[官方峰谷：周末全谷 / 假期 / 生效时刻]')
test('周六、周日整天判谷（即使小时落在窗口内）', () => {
  assert.equal(isPeakHour(at(SAT_PEAK_HOURS)), false)
  assert.equal(isPeakHour(at(SUN_PEAK_HOURS)), false)
})
test('假期表命中判谷，调休上班的周末仍按周末判谷', () => {
  assert.ok(OFFICIAL_HOLIDAYS.includes('2026-10-01'))
  assert.equal(isPeakHour(at(HOLIDAY)), false)
  // 2026-10-10 是周六（工作日调休）→ 周末规则仍然生效，判谷
  assert.equal(isPeakHour(at('2026-10-10T02:00:00Z')), false)
})
test('生效时刻之前不套峰谷（新规不改写历史）', () => {
  assert.equal(isPeakHour(at('2026-07-15T02:00:00Z')), false)
  assert.equal(isPeakHour(at('2026-08-25T02:00:00Z')), true, '同小时在生效后是高峰')
})
test('北京日历日键：UTC 16:00 即北京次日 00:00', () => {
  assert.equal(beijingDayKey(at('2026-10-01T15:59:59Z')), '2026-10-01')
  assert.equal(beijingDayKey(at('2026-10-01T16:00:00Z')), '2026-10-02')
})

console.log('\n[官方峰谷：相位与切换点]')
test('08:30 处于谷价，下一个切换点是 09:00（进入高峰）', () => {
  const phase = phaseAt(at('2026-08-25T00:30:00Z'))
  assert.equal(phase.inPeak, false)
  assert.equal(phase.nextAtMs, at('2026-08-25T01:00:00Z'))
  assert.equal(phase.nextIntoPeak, true)
  assert.equal(phase.prevAtMs, at('2026-08-24T10:00:00Z'), '上一个切换点是前一天高峰结束')
})
test('高峰中段：前后切换点分别是本窗口起止', () => {
  const phase = phaseAt(at(TUE_PEAK))
  assert.equal(phase.inPeak, true)
  assert.equal(phase.prevAtMs, at('2026-08-25T01:00:00Z'))
  assert.equal(phase.nextAtMs, at('2026-08-25T04:00:00Z'))
  assert.equal(phase.nextIntoPeak, false)
})
test('周末相位带 zoneKind，切换点跨到周一 00:00 北京（= 周日 16:00 UTC）', () => {
  const phase = phaseAt(at(SAT_PEAK_HOURS))
  assert.equal(phase.inPeak, false)
  assert.equal(phase.zoneKind, 'weekend')
  assert.equal(phase.nextAtMs, at('2026-08-30T16:00:00Z'))
})
test('假期相位 zoneKind = holiday', () => {
  assert.equal(phaseAt(at(HOLIDAY)).zoneKind, 'holiday')
})
test('enabled=false / 无窗口 → 无相位', () => {
  assert.equal(phaseAt(at(TUE_PEAK), { ...DEFAULT_OFFICIAL_PEAK, enabled: false }), null)
  assert.equal(phaseAt(at(TUE_PEAK), { ...DEFAULT_OFFICIAL_PEAK, windows: [] }), null)
})

console.log('\n[官方峰谷：未来切换点（侧栏「峰谷表」一键预览）]')
test('工作日：按窗口起止交替，峰↔谷严格交替', () => {
  const list = upcomingSwitches(at('2026-08-25T00:00:00Z'), { limit: 4 })
  assert.deepEqual(list.map(item => new Date(item.atMs).toISOString()), [
    '2026-08-25T01:00:00.000Z', // 北京 09:00 进高峰
    '2026-08-25T04:00:00.000Z', // 12:00 回平价
    '2026-08-25T06:00:00.000Z', // 14:00 进高峰
    '2026-08-25T10:00:00.000Z', // 18:00 回平价
  ])
  assert.deepEqual(list.map(item => item.inPeak), [true, false, true, false])
  assert.deepEqual(list.map(item => item.zoneKind), [null, null, null, null])
})
test('只往前扫：第一个切换点就是相位的 nextAtMs', () => {
  const from = at(TUE_OFF)
  const phase = phaseAt(from)
  assert.equal(upcomingSwitches(from, { limit: 1 })[0].atMs, phase.nextAtMs)
})
test('周末：下一切换点是周一 00:00 北京（周日 16:00 UTC），不是窗口起点', () => {
  const list = upcomingSwitches(at(SAT_PEAK_HOURS), { limit: 2 })
  assert.equal(new Date(list[0].atMs).toISOString(), '2026-08-30T16:00:00.000Z')
  assert.equal(list[0].inPeak, false, '周末结束时先回到平价，不是进高峰')
  assert.equal(list[0].zoneKind, null, '切换点本身已不在全谷区间里')
})
test('按 limit 给满，且严格单调往前（不是只在 48 小时视界里找）', () => {
  const list = upcomingSwitches(at('2026-08-25T00:00:00Z'), { limit: 6 })
  assert.equal(list.length, 6)
  for (let index = 1; index < list.length; index += 1) {
    assert.ok(list[index].atMs > list[index - 1].atMs, `第 ${index} 个没有往前：${JSON.stringify(list)}`)
  }
  assert.ok(list.at(-1).atMs - at('2026-08-25T00:00:00Z') > 24 * 3600_000, '6 个切换点要跨过一天')
  return `6 个 · 最远 ${new Date(list.at(-1).atMs).toISOString().slice(5, 16)}Z`
})
test('全谷期间切换点很稀：周末 24 小时内 0 个（全谷一直到周一 00:00 北京）', () => {
  const from = at(SAT_PEAK_HOURS)
  const list = upcomingSwitches(from, { limit: 6 })
  const within24h = list.filter(item => item.atMs - from <= 24 * 3600_000)
  assert.deepEqual(within24h, [], `24 小时内不该有切换点：${JSON.stringify(within24h)}`)
  // 周末结束（周日 16:00 UTC）+ 周一 09:00 北京进高峰：两个都落在 48 小时内
  const within48h = list.filter(item => item.atMs - from <= 48 * 3600_000)
  assert.equal(within48h.length, 2)
  assert.equal(within48h[0].atMs, at('2026-08-30T16:00:00Z'))
  assert.equal(within48h[1].inPeak, true)
  return '24h 内 0 个 · 48h 内 2 个'
})
test('脏输入与禁用配置返回空数组，不抛；不明时刻按「现在」算', () => {
  assert.deepEqual(upcomingSwitches(NaN), [])
  assert.deepEqual(upcomingSwitches(at(TUE_PEAK), { config: { ...DEFAULT_OFFICIAL_PEAK, enabled: false } }), [])
  assert.equal(upcomingSwitches(at(TUE_PEAK), { limit: 1 }).length, 1, '下限 1')
  assert.equal(upcomingSwitches(at(TUE_PEAK), { limit: 0 }).length, 6, '0 / 非法值 = 用默认 6')
  assert.equal(upcomingSwitches(at(TUE_PEAK), { limit: 999 }).length, 24, '上限 24')
  assert.ok(upcomingSwitches(undefined).length > 0, 'undefined = 现在，不是空数组')
})

console.log('\n[价表：单位价归一 / 调价历史 / 峰谷选列 / 时代分界]')
const peakOffPeakEntry = {
  cacheMiss: 0.3, cacheHit: 0.03, output: 1.2,
  offPeak: { cacheMiss: 0.15, cacheHit: 0.015, output: 0.6 },
  peak: { cacheMiss: 0.3, cacheHit: 0.03, output: 1.2 },
}
test('高峰取 peak 列，低谷取 offPeak 列', () => {
  const peak = tierFor(peakOffPeakEntry, at(TUE_PEAK))
  const off = tierFor(peakOffPeakEntry, at(TUE_OFF))
  assert.equal(peak.source, 'peak')
  assert.equal(peak.cacheMiss, 0.3)
  assert.equal(off.source, 'off-peak')
  assert.equal(off.cacheMiss, 0.15)
})
test('offPeak/peak 缺省时回落条目本身', () => {
  const tier = tierFor({ cacheMiss: 1, cacheHit: 0.1, output: 2 }, at(TUE_PEAK))
  assert.equal(tier.cacheMiss, 1)
})
test('调价历史：取「当时生效」的那一档（before 是结束边界）', () => {
  const entry = {
    cacheMiss: 0.3, cacheHit: 0.03, output: 1.2,
    rateHistory: [
      { before: '2026-09-10T04:00:00Z', cacheMiss: 0.22, cacheHit: 0.022, output: 0.66 },
      { before: '2026-12-31T00:00:00Z', cacheMiss: 0.3, cacheHit: 0.03, output: 1.2 },
    ],
  }
  assert.equal(priceAt(entry, at('2026-09-01T00:00:00Z')).cacheMiss, 0.22)
  assert.equal(priceAt(entry, at('2026-10-01T00:00:00Z')).cacheMiss, 0.3)
  assert.equal(priceAt(entry, at('2027-01-01T00:00:00Z')).cacheMiss, 0.3, '边界之后用条目自身')
})
test('legacyBase：峰谷时代之前按基础价', () => {
  const entry = { ...peakOffPeakEntry, legacyBase: { cacheMiss: 0.14, cacheHit: 0.0028, output: 0.28 } }
  const tier = tierFor(entry, at('2026-08-10T02:00:00Z'))
  assert.equal(tier.cacheMiss, 0.14)
  close(tier.cacheHit, 0.0028, 1e-12, 'cacheHit')
})
test('别名写法（input / cachedInput）与必填校验', () => {
  const unit = normalizePriceEntry({ input: 2, cachedInput: 0.2, output: 10, cacheWrite: 2.5 })
  assert.equal(unit.cacheMiss, 2)
  assert.equal(unit.cacheHit, 0.2)
  assert.equal(unit.cacheWrite, 2.5)
  assert.equal(unit.reasoning, null, 'reasoning 缺省为 null，由 costOf 按 0 处理')
  assert.equal(normalizePriceEntry({ cacheMiss: 1, cacheHit: 0.1 }), null, '缺 output 视为不完整')
  assert.equal(tierFor(null, at(TUE_PEAK)), null)
  assert.equal(tierFor({}, at(TUE_PEAK)), null)
})

console.log('\n[计价：五桶公式 / 长上下文档 / 未定价 ≠ 0]')
const LEGACY_UNIT = { cacheMiss: 0.14, cacheHit: 0.0028, output: 0.28, source: 'off-peak' }
test('五桶公式：input 是互斥桶，cacheWrite 缺省按命中价', () => {
  const buckets = { input: 1000, cacheRead: 500000, cacheWrite: 0, output: 200 }
  closeCost(costOf(buckets, LEGACY_UNIT), 0.001596, '五桶合计') // 140 + 1400 + 56 = 1596 / 1e6
  closeCost(costOf({ cacheWrite: 1000000 }, { cacheHit: 1, cacheMiss: 1, output: 1 }), 1, 'cacheWrite 按命中价')
})
test('推理 token 单独计价（缺省 0）', () => {
  const unit = { cacheMiss: 1, cacheHit: 0.1, output: 1, reasoning: 3 }
  closeCost(costOf({ output: 1000000, reasoning: 1000000 }, unit), 4, 'output + reasoning')
})
test('长上下文档：输入侧合计超阈值时整次请求切档', () => {
  const unit = {
    cacheMiss: 2, cacheHit: 0.2, output: 10,
    longContext: { aboveInputTokens: 1000, cacheMiss: 4, cacheHit: 0.4, output: 15 },
  }
  closeCost(costOf({ input: 1500, output: 100 }, unit), 0.0075, '超阈值走长档') // 6000 + 1500
  closeCost(costOf({ input: 500, output: 100 }, unit), 0.002, '未超阈值走标准档') // 1000 + 1000
})
test('未定价返回 null，而不是 0', () => {
  assert.equal(costOf({ input: 1 }, null), null)
  assert.equal(costOf({ input: 1 }, { cacheHit: 0.1, output: 1 }), null, '缺 cacheMiss')
  const call = priceCall({ buckets: { input: 1000 }, tier: null })
  assert.equal(call.cost, null)
  assert.equal(call.basis, 'unpriced')
})
test('脏桶值按 0，不产生 NaN', () => {
  closeCost(costOf({ input: -5, output: 'x', cacheRead: null }, LEGACY_UNIT), 0, '脏值归零')
})

console.log('\n[站方倍率：快照 + 本地复算峰谷]')
const RELAY_SNAPSHOT = {
  billing: {
    groupRate: 0.09, resolvedRate: 0.09, effectiveRate: 0.09,
    observedAt: '2026-10-12T13:48:37.361999438Z',
    peak: { enabled: false },
  },
}
test('未启用峰谷 → 直接用快照倍率', () => {
  const rate = resolveProviderRate(RELAY_SNAPSHOT, at(TUE_PEAK))
  assert.equal(rate.value, 0.09)
  assert.equal(rate.basis, 'snapshot')
  assert.equal(rate.applied, 1)
  assert.equal(rate.peak, false)
  assert.equal(rate.observedAt, '2026-10-12T13:48:37.361999438Z')
})
test('用户专属覆盖优先于分组倍率', () => {
  const rate = resolveProviderRate({ billing: { groupRate: 1, userRate: 0.5, resolvedRate: 0.5 } }, at(TUE_PEAK))
  assert.equal(rate.value, 0.5)
})
test('仅凭 effectiveRate 的兜底形态也能解析', () => {
  const rate = resolveProviderRate({ billing: { effectiveRate: 0.12 } }, at(TUE_PEAK))
  assert.equal(rate.value, 0.12)
  assert.equal(rate.basis, 'snapshot')
})
test('峰谷时间基于站方 timezone：北京 09:00–12:00 ×2', () => {
  const peak = { enabled: true, start: '09:00', end: '12:00', multiplier: 2, timezone: 'Asia/Shanghai' }
  const snapshot = { billing: { groupRate: 0.09, resolvedRate: 0.09, peak } }
  const inPeak = resolveProviderRate(snapshot, at('2026-08-25T01:30:00Z')) // 北京 09:30
  assert.equal(inPeak.applied, 2)
  close(inPeak.value, 0.18, 1e-12, 'inPeak.value')
  assert.equal(inPeak.basis, 'local-peak')
  const atEnd = resolveProviderRate(snapshot, at('2026-08-25T04:00:00Z')) // 北京 12:00 → 左闭右开
  assert.equal(atEnd.applied, 1)
  close(atEnd.value, 0.09, 1e-12, 'atEnd.value')
})
test('时区缺失 / 时区非法 / 跨天配置 → 因子安全降级为 1', () => {
  assert.equal(relayPeakFactor({ enabled: true, start: '09:00', end: '12:00', multiplier: 2 }, at(TUE_PEAK)), 1)
  assert.equal(relayPeakFactor({ enabled: true, start: '09:00', end: '12:00', multiplier: 2, timezone: 'Nowhere/Nope' }, at(TUE_PEAK)), 1)
  assert.equal(relayPeakFactor({ enabled: true, start: '22:00', end: '02:00', multiplier: 2, timezone: 'Asia/Shanghai' }, at(TUE_PEAK)), 1)
  assert.equal(relayPeakFactor({ enabled: false, start: '09:00', end: '12:00', multiplier: 2, timezone: 'Asia/Shanghai' }, at(TUE_PEAK)), 1)
})
test('multiplier = 0 合法（高峰免费）', () => {
  const factor = relayPeakFactor({ enabled: true, start: '09:00', end: '12:00', multiplier: 0, timezone: 'Asia/Shanghai' }, at('2026-08-25T01:30:00Z'))
  assert.equal(factor, 0)
})
test('拿不到倍率返回 null（界面显示 —，不按 1 处理）', () => {
  assert.equal(resolveProviderRate(null), null)
  assert.equal(resolveProviderRate({ billing: { observedAt: 'x' } }), null)
  assert.equal(resolveProviderRate({ billing: {} }), null)
})
test('站方窗口的下个切换点可本地算出（快照过期判断用）', () => {
  const peak = { enabled: true, start: '09:00', end: '12:00', multiplier: 2, timezone: 'Asia/Shanghai' }
  assert.equal(nextRelaySwitchAt(peak, at('2026-08-25T00:30:00Z')), at('2026-08-25T01:00:00Z'))
  assert.equal(nextRelaySwitchAt(peak, at('2026-08-25T01:30:00Z')), at('2026-08-25T04:00:00Z'))
  assert.equal(nextRelaySwitchAt({ enabled: false }, at(TUE_PEAK)), null)
})
test('wallClockMinutes：按 IANA 时区取当日分钟', () => {
  assert.equal(wallClockMinutes('Asia/Shanghai', at('2026-08-25T01:30:00Z')), 9 * 60 + 30)
  assert.equal(wallClockMinutes('UTC', at('2026-08-25T01:30:00Z')), 1 * 60 + 30)
  assert.equal(wallClockMinutes('Nowhere/Nope', at(TUE_PEAK)), null)
  assert.equal(wallClockMinutes(undefined, at(TUE_PEAK)), null)
})

console.log('\n[积分倍率型站（credits）：静态倍率与相对量]')
test('credits 解析：x0.79 / X 1.62 / 0.11 都能吃，脏值 null', () => {
  assert.equal(parseCredits('x0.79'), 0.79)
  assert.equal(parseCredits('X 1.62'), 1.62)
  assert.equal(parseCredits(0.11), 0.11)
  assert.equal(parseCredits('free'), null)
  assert.equal(parseCredits(''), null)
  assert.equal(parseCredits(null), null)
})
test('按模型取 credits，忽略命名空间前缀', () => {
  const models = [
    { id: 'cn:glm-5.3', credits: 'x0.79' },
    { id: 'cn:deepseek-v4.1-flash', credits: 'x0.11' },
    { id: 'cn:hy3', credits: 'x0.00' },
  ]
  assert.equal(creditsOf(models, 'cn:deepseek-v4.1-flash'), 0.11)
  assert.equal(creditsOf(models, 'deepseek-v4.1-flash'), 0.11, '裸名也能命中')
  assert.equal(creditsOf(models, 'cn:hy3'), 0)
  assert.equal(creditsOf(models, 'cn:unknown'), null)
  assert.equal(creditsOf(null, 'x'), null)
})
test('相对量 = 全部桶 × credits（该类型站没有货币基准）', () => {
  close(creditsWeight({ input: 100, cacheRead: 900, output: 50 }, 0.11), 1050 * 0.11, 1e-9, '相对量')
  close(creditsWeight({ input: 100 }, null), 100, 1e-9, '缺 credits 按 1')
})

console.log('\n[统一入口：三层相乘 / 未定价语义]')
test('三层相乘：官方档位 × 站方倍率 × credits', () => {
  const call = priceCall({
    buckets: { input: 1000, cacheRead: 500000, output: 200 },
    tier: LEGACY_UNIT,
    rate: { value: 0.09, basis: 'snapshot' },
    credits: 0.11,
  })
  closeCost(call.cost, 0.001596 * 0.09 * 0.11, '三层金额')
  assert.equal(call.basis, 'off-peak×snapshot×credits')
})
test('缺单位价 → cost null 且不改写整数倍率', () => {
  const call = priceCall({ buckets: { input: 10 }, tier: null, rate: { value: 0.09 } })
  assert.equal(call.cost, null)
  assert.equal(call.usd, null)
})
test('币种折算：CNY 价表按汇率折美元，汇率非法按 1', () => {
  close(toUsd(1, 'CNY', 7.2), 1 / 7.2, 1e-12, 'CNY→USD')
  close(toUsd(1, 'USD', 7.2), 1, 1e-12, 'USD 不变')
  close(toUsd(1, 'CNY', 0), 1, 1e-12, '非法汇率降级')
})
test('价表查找：精确 → 忽略命名空间 → 别名表', () => {
  const table = {
    models: { 'deepseek-v4.1-flash': { cacheMiss: 0.3, cacheHit: 0.03, output: 1.2 } },
    aliases: { 'deepseek-v4.1-flash-vision-exp': 'deepseek-v4.1-flash' },
  }
  assert.ok(findPriceEntry(table, 'deepseek-v4.1-flash'))
  assert.ok(findPriceEntry(table, 'cn:deepseek-v4.1-flash'), '带命名空间前缀')
  assert.ok(findPriceEntry(table, 'deepseek-v4.1-flash-vision-exp'), '别名')
  assert.equal(findPriceEntry(table, 'unknown'), null)
  assert.equal(findPriceEntry(null, 'x'), null)
})
test('resolveTier：没价表时 priced=false + reason，但仍给出倍率/相位/credits', () => {
  const snapshot = {
    billing: { groupRate: 0.09, resolvedRate: 0.09, peak: { enabled: false } },
    models: [{ id: 'cn:deepseek-v4.1-flash', credits: 'x0.11' }],
  }
  const resolved = resolveTier({ provider: 'wbfd', model: 'cn:deepseek-v4.1-flash', atMs: at(TUE_PEAK), snapshot })
  assert.equal(resolved.priced, false)
  assert.equal(resolved.reason, 'no-price-table')
  assert.equal(resolved.tier, null)
  assert.equal(resolved.rate.value, 0.09)
  assert.equal(resolved.credits, 0.11)
  assert.equal(resolved.phase.inPeak, true)
})
test('resolveTier：有价表时给出档位、相位与切换点', () => {
  const priceTable = { models: { 'deepseek-v4.1-flash': peakOffPeakEntry } }
  const resolved = resolveTier({ model: 'cn:deepseek-v4.1-flash', atMs: at(TUE_OFF), priceTable })
  assert.equal(resolved.priced, true)
  assert.equal(resolved.reason, null)
  assert.equal(resolved.tier.source, 'off-peak')
  assert.equal(resolved.tier.cacheMiss, 0.15)
  assert.equal(resolved.switches.officialNextAtMs, at('2026-08-25T06:00:00Z'))
  assert.equal(resolved.switches.relayNextAtMs, null)
})
test('resolveTier + priceCall 端到端：一次高峰调用 = 高峰列 × 站方倍率', () => {
  const snapshot = { billing: { groupRate: 0.09, resolvedRate: 0.09, peak: { enabled: false } } }
  const priceTable = { models: { 'deepseek-v4.1-flash': peakOffPeakEntry } }
  const resolved = resolveTier({ model: 'deepseek-v4.1-flash', atMs: at(TUE_PEAK), snapshot, priceTable })
  const call = priceCall({ buckets: { input: 1000000 }, tier: resolved.tier, rate: resolved.rate })
  closeCost(call.cost, 0.3 * 0.09, '高峰百万输入 × 0.09')
  assert.equal(call.basis, 'peak×snapshot')
})

console.log('\n[规定：依据变更不重算历史，只影响后续调用]')
const FROZEN_BUCKETS = { input: 1000, cacheRead: 500000, output: 200 }
const SNAPSHOT_009 = { billing: { groupRate: 0.09, resolvedRate: 0.09, peak: { enabled: false } } }
const TABLE_A = { models: { 'deepseek-v4.1-flash': { cacheMiss: 0.14, cacheHit: 0.0028, output: 0.28 } } }
// 表 B：全部单价翻倍（模拟官方调价 / 修正口径）
const TABLE_B = { models: { 'deepseek-v4.1-flash': { cacheMiss: 0.28, cacheHit: 0.0056, output: 0.56 } } }

/** 按某版依据记一条调用。 */
function record({ atMs, priceTable, snapshot = SNAPSHOT_009, buckets = FROZEN_BUCKETS }) {
  const resolved = resolveTier({ provider: 'walk-grok', model: 'deepseek-v4.1-flash', atMs, snapshot, priceTable })
  const basisId = pricingFingerprint({ priceTable })
  return makeCallRecord({ atMs, provider: 'walk-grok', model: 'deepseek-v4.1-flash', buckets, resolved, basisId })
}

test('依据指纹：键序无关、单价或峰谷配置一变就变', () => {
  const reordered = { models: { 'deepseek-v4.1-flash': { output: 0.28, cacheMiss: 0.14, cacheHit: 0.0028 } } }
  assert.equal(pricingFingerprint({ priceTable: TABLE_A }), pricingFingerprint({ priceTable: reordered }), '键序不影响')
  assert.notEqual(pricingFingerprint({ priceTable: TABLE_A }), pricingFingerprint({ priceTable: TABLE_B }))
  assert.notEqual(
    pricingFingerprint({ priceTable: TABLE_A, officialPeak: DEFAULT_OFFICIAL_PEAK }),
    pricingFingerprint({ priceTable: TABLE_A, officialPeak: { ...DEFAULT_OFFICIAL_PEAK, windows: [{ start: 2, end: 5 }] } }),
    '峰谷窗口变化也要换指纹',
  )
  assert.match(pricingFingerprint({ priceTable: TABLE_A }), /^p1-[0-9a-f]{8}$/)
})

test('记录冻结了依据：单价、倍率、credits、金额、basisId 全在行内', () => {
  const row = record({ atMs: at(TUE_PEAK), priceTable: TABLE_A })
  assert.equal(row.cost !== null, true)
  assert.equal(row.unit.cacheMiss, 0.14)
  assert.equal(row.rate.value, 0.09)
  assert.equal(row.basis, 'flat×snapshot') // 表 A 没有峰谷两列 → 回落到条目自身（source: flat）
  assert.match(row.basisId, /^p1-/)
  assert.deepEqual(row.buckets, { input: 1000, output: 200, cacheRead: 500000, cacheWrite: 0, reasoning: 0 })
})

test('★ 换表（单价翻倍）后，旧记录金额一分不动，新记录按新表', () => {
  const before = [record({ atMs: at(TUE_PEAK), priceTable: TABLE_A }), record({ atMs: at(TUE_PEAK), priceTable: TABLE_A })]
  const frozen = summarizeRecords(before)
  closeCost(frozen.cost, 2 * 0.001596 * 0.09, '旧记录合计（表 A 口径）')

  // 依据变更：只影响之后
  const after = record({ atMs: at(TUE_PEAK), priceTable: TABLE_B })
  closeCost(after.cost, 0.001596 * 2 * 0.09, '新记录按表 B（单价翻倍）')
  assert.notEqual(after.basisId, before[0].basisId, '新记录带新指纹')

  // 关键断言：把新记录加进来，旧记录的部分仍然是表 A 的数
  const merged = summarizeRecords([...before, after])
  closeCost(merged.cost - after.cost, frozen.cost, '旧记录未被重算')
  assert.deepEqual(merged.basisIds, [...new Set([before[0].basisId, after.basisId])].sort(), '两版依据并存可辨')
})

test('未定价记录：token 照计、金额不计，且不会把总额变成 0', () => {
  const unpriced = record({ atMs: at(TUE_PEAK), priceTable: null })
  assert.equal(unpriced.cost, null)
  assert.equal(unpriced.cost, null, '未定价不是 0')
  assert.equal(unpriced.buckets.cacheRead, 500000, 'token 照计')
  const only = summarizeRecords([unpriced])
  assert.equal(only.cost, null, '全未定价 → null')
  assert.equal(only.unpriced, 1)
  assert.equal(only.priced, 0)
  assert.equal(only.buckets.input, 1000)

  const mixed = summarizeRecords([unpriced, record({ atMs: at(TUE_PEAK), priceTable: TABLE_A })])
  closeCost(mixed.cost, 0.001596 * 0.09, '只把已定价的算进去')
  assert.equal(mixed.priced, 1)
  assert.equal(mixed.unpriced, 1)
})

test('命中率与宿主 stock 口径一致（分母含缓存读与缓存写）', () => {
  const screenshot = { input: 147678, cacheRead: 19869568, cacheWrite: 0, output: 127642 }
  close(cacheHitRate(screenshot), 19869568 / (19869568 + 147678), 1e-12, '会话命中率')
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null, '分母为 0 → null')
  close(cacheHitRate({ input: 100, cacheRead: 0, cacheWrite: 300 }), 0, 1e-12, '写入计入分母')
  close(summarizeRecords([]).hitRate, null, 0, '空记录')
})

test('summarizeRecords 不接受价表：读历史在结构上无法触发重算', () => {
  const rows = [record({ atMs: at(TUE_PEAK), priceTable: TABLE_A })]
  const first = summarizeRecords(rows)
  const second = summarizeRecords(rows)
  assert.equal(first.cost, second.cost)
  // 传多余参数也不改变结果（没有「当前表」这个入口）
  closeCost(summarizeRecords(rows, TABLE_B).cost, first.cost, '表 B 传进来也不影响历史')
})

console.log('\n[默认价表：来源、结构、覆盖与命中]')
test('默认表带来源信息（MIT 快照 + 哈希 + 币种）', () => {
  assert.equal(PRICE_TABLE_META.origin, 'dsh-cost-meter price snapshot (MIT)')
  assert.match(PRICE_TABLE_META.sourceHash, /^[0-9a-f]{16}$/)
  assert.equal(DEFAULT_PRICE_TABLE.currency, 'USD')
  assert.ok(PRICE_TABLE_META.vendorCount >= 10, '厂商目录应在 10 家以上')
  assert.ok(catalogVendors(DEFAULT_PRICE_TABLE).includes('openai'))
})
test('DeepSeek 主表：峰价 = 谷价两倍，且带调价历史与时代分界价', () => {
  const entry = DEFAULT_PRICE_TABLE.models['deepseek-v4.1-flash']
  close(entry.peak.cacheMiss, entry.offPeak.cacheMiss * 2, 1e-12, '峰=谷×2（未命中）')
  close(entry.peak.output, entry.offPeak.output * 2, 1e-12, '峰=谷×2（输出）')
  assert.equal(entry.rateHistory[0].before, '2026-09-10T04:00:00Z')
  assert.equal(DEFAULT_PRICE_TABLE.models['deepseek-v4-flash'].legacyBase.cacheMiss, 0.14)
})
test('默认表能直接算出 DeepSeek 峰/谷两档金额（不经任何站点）', () => {
  // 2026-09-15 是调价边界（09-10 12:00 北京）之后的周二：用现行价档
  const PEAK = '2026-09-15T01:30:00Z'
  const OFF = '2026-09-15T04:30:00Z'
  const peak = resolveTier({ model: 'deepseek-v4.1-flash', atMs: at(PEAK), priceTable: DEFAULT_PRICE_TABLE })
  const off = resolveTier({ model: 'deepseek-v4.1-flash', atMs: at(OFF), priceTable: DEFAULT_PRICE_TABLE })
  assert.equal(peak.priced, true)
  assert.equal(peak.tier.source, 'peak')
  assert.equal(off.tier.source, 'off-peak')
  const buckets = { input: 1000000, output: 1000000 }
  closeCost(priceCall({ buckets, tier: peak.tier }).cost, 0.3 + 1.2, '峰：百万未命中 + 百万输出')
  closeCost(priceCall({ buckets, tier: off.tier }).cost, 0.15 + 0.6, '谷：半价')
})
test('调价边界之前按当时档位（rateHistory），不套现行价', () => {
  const before = resolveTier({ model: 'deepseek-v4.1-flash', atMs: at(TUE_PEAK), priceTable: DEFAULT_PRICE_TABLE })
  assert.equal(before.tier.cacheMiss, 0.44, '2026-08-25 处于 09-10 边界之前，峰价未命中 0.44')
  close(before.tier.output, 1.32, 1e-12, '峰价输出')
})
test('中转站上的站点 id 也能命中（显式放开全部来源时）', () => {
  const cases = [
    ['cn:deepseek-v4.1-flash', 'deepseek'],
    ['claude-opus-4.6', 'anthropic'], // 点号写法 → anthropic 的连字符键
    ['grok-4.6', 'xai'],
    ['glm-5.2', 'z-ai'],
    ['minimax-m3', 'minimax'],
    ['gpt-5.6-sol', 'openai'], // 自营优先于 opencode-go
    ['grok-4.7', 'openrouter'], // 只有聚合目录收录
  ]
  const found = []
  for (const [model, vendor] of cases) {
    const hit = findPriceEntryDetailed(DEFAULT_PRICE_TABLE, model, { allowSources: PRICE_SOURCES })
    assert.ok(hit !== null, `${model} 应命中`)
    assert.equal(hit.vendor, vendor, `${model} 应命中 ${vendor}，实际 ${hit.vendor}`)
    found.push(`${model}→${hit.vendor}`)
  }
  return found.join(' ')
})

console.log('\n[规定：默认只按官方价计价（转售/聚合来源不参与）]')
test('默认策略：官方价（DeepSeek 主表）照常命中，并标出来源等级', () => {
  const resolved = resolveTier({ model: 'cn:deepseek-v4.1-flash', atMs: at(TUE_PEAK), priceTable: DEFAULT_PRICE_TABLE })
  assert.equal(resolved.priced, true)
  assert.equal(resolved.priceSource.vendor, 'deepseek')
  assert.equal(resolved.priceSource.source, 'official')
})
test('默认策略：只有转售价的模型 → 不给价，原因标 blocked-source', () => {
  for (const model of ['claude-opus-4.6', 'gpt-5.6-sol', 'glm-5.2']) {
    const resolved = resolveTier({ model, atMs: at(TUE_PEAK), priceTable: DEFAULT_PRICE_TABLE })
    assert.equal(resolved.priced, false, `${model} 不该按转售价计价`)
    assert.equal(resolved.reason, 'blocked-source', `${model} 的原因`)
    assert.equal(resolved.blockedSource.source, 'reseller', `${model} 被挡来源等级`)
    assert.equal(resolved.tier, null)
  }
})
test('默认策略：聚合目录（openrouter）同样被挡', () => {
  const resolved = resolveTier({ model: 'grok-4.7', atMs: at(TUE_PEAK), priceTable: DEFAULT_PRICE_TABLE })
  assert.equal(resolved.priced, false)
  assert.equal(resolved.blockedSource.source, 'aggregator')
})
test('显式放开来源后才按转售价计价（逃生门）', () => {
  const resolved = resolveTier({
    model: 'gpt-5.6-sol',
    atMs: at(TUE_PEAK),
    priceTable: DEFAULT_PRICE_TABLE,
    allowSources: ['official', 'reseller'],
  })
  assert.equal(resolved.priced, true)
  assert.equal(resolved.priceSource.source, 'reseller')
})
test('手工填的条目（没有 source 字段）默认可用，且标明来路', () => {
  const manual = { models: { 'my-model': { cacheMiss: 1, cacheHit: 0.1, output: 2 } } }
  const resolved = resolveTier({ model: 'my-model', atMs: at(TUE_PEAK), priceTable: manual })
  assert.equal(resolved.priced, true)
  assert.equal(resolved.priceSource.source, 'manual')
})
test('来源分布可审计：元数据里给出各等级条数', () => {
  const breakdown = PRICE_TABLE_META.sourceBreakdown
  assert.ok(breakdown.official >= 4, 'DeepSeek 主表至少 4 条官方价')
  assert.ok(breakdown.reseller > 0 && breakdown.aggregator > 0)
  assert.equal(
    breakdown.official + breakdown.reseller + breakdown.aggregator + breakdown.unknown,
    PRICE_TABLE_META.modelCount + Object.values(PRICE_TABLE_META.sourceByVendor)
      .reduce((sum, row) => sum + row.official + row.reseller + row.aggregator + row.unknown, 0),
    '各等级条数应等于表内条目总数',
  )
  return `official ${breakdown.official} · reseller ${breakdown.reseller} · aggregator ${breakdown.aggregator} · unknown ${breakdown.unknown}`
})
test('命中出处会带回框架（vendor / key / matchedBy / sourceUrl / checkedAt）', () => {
  // 用一条**官方来源**的条目断言（转售价现在默认不参与计价）
  let picked = null
  for (const [vendor, models] of Object.entries(DEFAULT_PRICE_TABLE.providers)) {
    for (const [id, entry] of Object.entries(models)) {
      if (entrySource(entry) === 'official' && typeof entry.sourceUrl === 'string') {
        picked = { vendor, id, entry }
        break
      }
    }
    if (picked !== null) break
  }
  assert.ok(picked !== null, '默认表里应至少有一条带 sourceUrl 的官方条目')
  const resolved = resolveTier({ model: picked.id, atMs: at(TUE_PEAK), priceTable: DEFAULT_PRICE_TABLE })
  assert.equal(resolved.priced, true)
  assert.equal(resolved.priceSource.vendor, picked.vendor)
  assert.equal(resolved.priceSource.source, 'official')
  assert.equal(resolved.priceSource.matchedBy, 'exact')
  assert.match(resolved.priceSource.sourceUrl, /^https:/)
  return `${picked.vendor}/${picked.id}`
})
test('未定价要能区分原因，而不是一律算 0', () => {
  const noTable = resolveTier({ model: 'x', atMs: at(TUE_PEAK), priceTable: null })
  assert.equal(noTable.reason, 'no-price-table')
  const notInTable = resolveTier({ model: 'cn:space-bunny', atMs: at(TUE_PEAK), priceTable: DEFAULT_PRICE_TABLE })
  assert.equal(notInTable.reason, 'model-not-in-table')
  assert.equal(notInTable.tier, null)
  const incomplete = resolveTier({ model: 'x', atMs: at(TUE_PEAK), priceTable: { models: { x: { cacheHit: 1 } } } })
  assert.equal(incomplete.reason, 'incomplete-price-entry')
})
test('改默认表只影响之后的调用（指纹随之变化）', () => {
  const edited = structuredClone(DEFAULT_PRICE_TABLE)
  edited.models['deepseek-v4.1-flash'].peak.cacheMiss = 0.99
  assert.notEqual(
    pricingFingerprint({ priceTable: DEFAULT_PRICE_TABLE }),
    pricingFingerprint({ priceTable: edited }),
    '改单价 → 新指纹（历史记录仍按旧依据）',
  )
})

console.log('\n[state.json 的 officialPeak 归一：逐字段覆盖 + 打字错保护]')
test('不是普通对象 → undefined（当作没配，回落默认表）', () => {
  assert.equal(normalizeOfficialPeak(undefined), undefined)
  assert.equal(normalizeOfficialPeak(null), undefined)
  assert.equal(normalizeOfficialPeak('2026-08-01'), undefined)
  assert.equal(normalizeOfficialPeak([]), undefined)
  assert.equal(normalizeOfficialPeak(42), undefined)
})
test('空对象 → 每个字段都回落默认', () => {
  const config = normalizeOfficialPeak({})
  assert.deepEqual(config, DEFAULT_OFFICIAL_PEAK)
  assert.notEqual(config, DEFAULT_OFFICIAL_PEAK, '应是新对象，不能把默认表本身交出去')
})
test('只给 holidays → 只改假期，窗口与三个时刻保持默认', () => {
  const config = normalizeOfficialPeak({ holidays: ['2026-08-25'] })
  assert.deepEqual(config.holidays, ['2026-08-25'])
  assert.deepEqual(config.windows, DEFAULT_OFFICIAL_PEAK.windows)
  assert.equal(config.effectiveAt, DEFAULT_OFFICIAL_PEAK.effectiveAt)
  // 2026-08-25 是周二、UTC 01:30 落在高峰窗口；把它列进假期后应判谷
  assert.equal(isPeakHour(at(TUE_PEAK), DEFAULT_OFFICIAL_PEAK), true)
  assert.equal(isPeakHour(at(TUE_PEAK), config), false)
})
test('显式 windows: [] → 峰谷整体停用（相位 null，全部按谷价档）', () => {
  const config = normalizeOfficialPeak({ windows: [] })
  assert.deepEqual(config.windows, [])
  assert.equal(isPeakHour(at(TUE_PEAK), config), false)
  assert.equal(phaseAt(at(TUE_PEAK), config), null)
  assert.deepEqual(upcomingSwitches(at(TUE_PEAK), { config }), [])
})
test('显式 holidays: [] → 有效值（没有假期），不是「打字错」', () => {
  const config = normalizeOfficialPeak({ holidays: [] })
  assert.deepEqual(config.holidays, [])
  assert.equal(isPeakHour(at(HOLIDAY), config), true, '国庆不再判谷')
  assert.equal(isPeakHour(at(HOLIDAY), DEFAULT_OFFICIAL_PEAK), false)
})
test('非空数组里一条都不合法 → 回落默认表（不静默丢假期）', () => {
  const config = normalizeOfficialPeak({ holidays: ['2026/10/01', '国庆', 20261001], windows: [{ start: 99, end: 3 }] })
  assert.deepEqual(config.holidays, DEFAULT_OFFICIAL_PEAK.holidays)
  assert.deepEqual(config.windows, DEFAULT_OFFICIAL_PEAK.windows)
})
test('假期去重、排序、剔除非法项（合法的照留）', () => {
  const config = normalizeOfficialPeak({ holidays: ['2026-12-31', 'bad', '2026-01-01', '2026-12-31'] })
  assert.deepEqual(config.holidays, ['2026-01-01', '2026-12-31'])
})
test('窗口数字串也认，越界/非整数的整条丢掉', () => {
  const config = normalizeOfficialPeak({ windows: [{ start: '6', end: '10' }, { start: 0, end: 24 }, { start: 1.5, end: 4 }] })
  assert.deepEqual(config.windows, [{ start: 6, end: 10 }])
})
test('退化窗口 start === end 当非法丢（否则跨午夜分支会判成全天高峰）', () => {
  // 光看 isPeakHour 的注释会以为「5-5」没影响：实际 `hour >= 5 || hour < 5` 恒真 → 全天峰价
  const naive = { enabled: true, windows: [{ start: 5, end: 5 }], holidays: [] }
  assert.equal(isPeakHour(at('2026-08-25T18:00:00Z'), naive), true, '宿主侧原语义确实是全天高峰')
  const mixed = normalizeOfficialPeak({ windows: [{ start: 5, end: 5 }, { start: 1, end: 4 }] })
  assert.deepEqual(mixed.windows, [{ start: 1, end: 4 }], '退化的丢掉，合法的照留')
  const only = normalizeOfficialPeak({ windows: [{ start: 5, end: 5 }] })
  assert.deepEqual(only.windows, DEFAULT_OFFICIAL_PEAK.windows, '全是退化 → 按打字错回落默认')
})
test('跨午夜窗口（start > end）仍然合法', () => {
  const config = normalizeOfficialPeak({ windows: [{ start: 22, end: 2 }] })
  assert.deepEqual(config.windows, [{ start: 22, end: 2 }])
  assert.equal(isPeakHour(at('2026-08-25T23:00:00Z'), config), true, 'UTC 23 点在窗口内')
  assert.equal(isPeakHour(at('2026-08-25T01:00:00Z'), config), true, 'UTC 01 点也在窗口内')
  assert.equal(isPeakHour(at('2026-08-25T12:00:00Z'), config), false)
})
test('假期只认真实存在的日历日（2026-02-30 这种要丢掉）', () => {
  // Date.parse('2026-02-30') 是有限值（V8 滚到 3-02），但它永远不等于 beijingDayKey()
  // 产出的任何日期 → 那条假期是死的：用户以为配了，那天照峰价算。
  assert.ok(Number.isFinite(Date.parse('2026-02-30')), '前提：Date.parse 确实会放行它')
  const config = normalizeOfficialPeak({ holidays: ['2026-02-30', '2026-12-25', '2026-13-01'] })
  assert.deepEqual(config.holidays, ['2026-12-25'], '只留真实存在的日期')
  assert.equal(isPeakHour(at('2026-12-25T01:30:00Z'), config), false, '留下的那天确实按谷价')
})
test('超大 atMs 不抛（Date 上界之外只判不了日历日，不许崩）', () => {
  // 纯函数要对任意入参是全函数：`new Date(8.64e15).toISOString()` 会抛 RangeError，
  // 而 `beijingDayKey` 原来在 scanSwitch / phaseAt 的探测路径里会被调到。
  assert.equal(beijingDayKey(8.64e15), null, '+8h 平移后越界 → 判不了')
  assert.equal(beijingDayKey(9e15), null)
  assert.doesNotThrow(() => beijingDayKey(-8.64e15), '负上界只是结果古怪，不该抛')
  assert.equal(beijingDayKey(Number.NaN), null)
  assert.equal(beijingDayKey(Number.POSITIVE_INFINITY), null)
  assert.doesNotThrow(() => phaseAt(8.64e15), 'phaseAt 不该抛')
  assert.doesNotThrow(() => phaseAt(9e15), '超过 Date 上界也不该抛')
  assert.doesNotThrow(() => upcomingSwitches(8.64e15), 'upcomingSwitches 不该抛')
  assert.doesNotThrow(() => upcomingSwitches(9e15, { limit: 3 }), '超过 Date 上界也不该抛')
})
test('坏时刻串回落默认，而不是让整段配置失效', () => {
  const config = normalizeOfficialPeak({ effectiveAt: 'not-a-date', legacyBoundary: '' })
  assert.equal(config.effectiveAt, DEFAULT_OFFICIAL_PEAK.effectiveAt)
  assert.equal(config.legacyBoundary, DEFAULT_OFFICIAL_PEAK.legacyBoundary)
})
test('enabled: false → 相位 null、永不判峰，档位落回谷价列', () => {
  const config = normalizeOfficialPeak({ enabled: false })
  assert.equal(config.enabled, false)
  assert.equal(isPeakHour(at(TUE_PEAK), config), false)
  assert.equal(phaseAt(at(TUE_PEAK), config), null)
  const peak = resolveTier({ model: 'deepseek-v4.1-flash', atMs: at(TUE_PEAK), priceTable: DEFAULT_PRICE_TABLE, officialPeak: DEFAULT_OFFICIAL_PEAK })
  const off = resolveTier({ model: 'deepseek-v4.1-flash', atMs: at(TUE_PEAK), priceTable: DEFAULT_PRICE_TABLE, officialPeak: config })
  assert.equal(peak.phase.inPeak, true)
  assert.equal(off.phase, null)
  assert.ok(peak.tier.cacheMiss > off.tier.cacheMiss, '停用峰谷后不该再套峰价列')
})
test('officialPeak 进指纹：改窗口 → 新依据（历史不重算）', () => {
  const base = pricingFingerprint({ officialPeak: DEFAULT_OFFICIAL_PEAK })
  const moved = pricingFingerprint({ officialPeak: normalizeOfficialPeak({ windows: [{ start: 2, end: 5 }] }) })
  assert.notEqual(base, moved)
  assert.equal(moved, pricingFingerprint({ officialPeak: normalizeOfficialPeak({ windows: [{ start: 2, end: 5 }] }) }), '同一份配置指纹稳定')
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
