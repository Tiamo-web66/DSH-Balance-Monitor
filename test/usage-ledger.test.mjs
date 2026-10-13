#!/usr/bin/env node
/**
 * 用量账本 + 侧栏聚合验证（不出网、不碰宿主）。
 *
 *   node test/usage-ledger.test.mjs
 */
import assert from 'node:assert/strict'

import { makeCallRecord, resolveTier } from '../lib/pricing.js'
import {
  DEFAULT_DISPLAY,
  DEFAULT_RETENTION,
  LEDGER_KEEP_DAYS,
  ROLLUP_KEEP_DAYS,
  addRecordToRollupDay,
  appendRecord,
  applyRollupDay,
  buildModelCard,
  buildReport,
  buildSidebarData,
  createLedger,
  createRollup,
  createUsageDeduper,
  dayKey,
  formatCountdown,
  normalizeLedger,
  normalizeRetention,
  normalizeRollup,
  pruneLedger,
  pruneRollup,
  rollupDailySeries,
  rollupDaysMissingModels,
  summarizeDay,
  summarizeDayModels,
  summarizeModels,
  summarizeRollup,
  summarizeRollupModels,
  summarizeSession,
  summarizeSessions,
  toDisplay,
} from '../lib/usage-ledger.js'

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
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label ?? 'value'}: 期望 ${expected} ± ${tolerance}，实际 ${actual}`)
}

// 2026-08-25 08:30 北京 = 谷价时段（官方窗口之外），价表用单档，避免峰谷干扰
const T0 = at('2026-08-25T00:30:00Z')
const T1 = at('2026-08-25T00:31:00Z')

const PRICE_TABLE = { models: { 'deepseek-v4.1-flash': { cacheMiss: 0.3, cacheHit: 0.003, output: 1.2 } } }
/** 站方倍率 0.09、无峰谷、无 credits。 */
const SNAPSHOT = { billing: { groupRate: 0.09, resolvedRate: 0.09, peak: { enabled: false } }, models: [] }
/** 百万未命中输入：官方价 0.3 USD → 倍率后 0.027 USD。 */
const BUCKETS = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
const UNIT_USD = 0.3 * 0.09

function record({ atMs = T0, provider = 'walk-grok', model = 'deepseek-v4.1-flash', sessionId = null, parentSessionId = null, buckets = BUCKETS, snapshot = SNAPSHOT, priceTable = PRICE_TABLE, tierOverride } = {}) {
  const resolved = resolveTier({ provider, model, atMs, snapshot, priceTable })
  return makeCallRecord({
    atMs,
    provider,
    model,
    sessionId,
    parentSessionId,
    buckets,
    resolved: tierOverride === undefined ? resolved : { ...resolved, tier: tierOverride },
    basisId: 'p1-test0000',
  })
}

console.log('\n[dayKey / 账本读写]')
test('dayKey 用本地日历日，同一天同一串', () => {
  const date = new Date(2026, 7, 25, 23, 30) // 本地 2026-08-25 23:30
  assert.equal(dayKey(date.getTime()), '2026-08-25')
  assert.equal(dayKey(date.getTime() + 3600_000), '2026-08-26')
})
test('appendRecord 按天归档，坏记录不写', () => {
  const ledger = createLedger()
  assert.equal(appendRecord(ledger, record()), true)
  assert.equal(appendRecord(ledger, { atMs: 'x' }), false)
  assert.equal(appendRecord(ledger, null), false)
  assert.equal(ledger.days[dayKey(T0)].records.length, 1)
})
test('normalizeLedger 吃掉坏结构（坏文件不该让插件起不来）', () => {
  const ledger = normalizeLedger({
    days: {
      '2026-08-25': { records: [record(), null, { atMs: 'nope' }] },
      'not-a-date': { records: [record()] },
      '2026-08-24': { records: 'nope' },
    },
  })
  assert.deepEqual(Object.keys(ledger.days), ['2026-08-25'])
  assert.equal(ledger.days['2026-08-25'].records.length, 1)
  assert.equal(normalizeLedger(null).days !== undefined, true)
})
test('pruneLedger 只留最近 N 天', () => {
  const ledger = createLedger()
  for (const date of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']) {
    ledger.days[date] = { date, records: [record({ atMs: at(`${date}T00:30:00Z`) })] }
  }
  assert.equal(pruneLedger(ledger, { keepDays: 2 }), 2)
  assert.deepEqual(Object.keys(ledger.days), ['2026-08-12', '2026-08-13'])
})

console.log('\n[今日汇总：倍率之后的金额 + 按供应商切换]')
test('今日金额 = Σ(官方价 × 站方倍率)，不是官方原价', () => {
  const ledger = createLedger()
  appendRecord(ledger, record())
  appendRecord(ledger, record({ atMs: T1 }))
  const day = summarizeDay(ledger, dayKey(T0))
  close(day.usd, UNIT_USD * 2, 1e-12, '今日合计')
  close(day.total ?? day.usd, UNIT_USD * 2, 1e-12, '总计字段')
  assert.equal(day.calls, 2)
  assert.equal(day.priced, 2)
  assert.equal(day.providers.length, 1)
  assert.equal(day.providers[0].provider, 'walk-grok')
  return `${day.calls} 次 · ${day.usd.toFixed(6)} USD（官方价 × 0.09）`
})
test('多供应商：分别汇总、按金额倒序、并带逐模型明细', () => {
  const ledger = createLedger()
  appendRecord(ledger, record()) // walk-grok ×1
  appendRecord(ledger, record({ atMs: T1, provider: 'walk-gpt' }))
  appendRecord(ledger, record({ atMs: T1, provider: 'walk-gpt' }))
  const day = summarizeDay(ledger, dayKey(T0))
  assert.deepEqual(day.providers.map(item => item.provider), ['walk-gpt', 'walk-grok'])
  close(day.providers[0].usd, UNIT_USD * 2, 1e-12, 'walk-gpt')
  close(day.usd, UNIT_USD * 3, 1e-12, '今日合计（所有供应商相加）')
  assert.equal(day.providers[0].models[0].model, 'deepseek-v4.1-flash')
})
test('未定价（没探到倍率/没命中价表）：token 照计、金额不计', () => {
  const ledger = createLedger()
  appendRecord(ledger, record())
  appendRecord(ledger, record({ atMs: T1, tierOverride: null }))
  const day = summarizeDay(ledger, dayKey(T0))
  close(day.usd, UNIT_USD, 1e-12, '只算已定价的那条')
  assert.equal(day.calls, 2)
  assert.equal(day.priced, 1)
  assert.equal(day.unpriced, 1)
  assert.equal(day.buckets.input, 2_000_000, 'token 照计')
})
test('无 provider 字段的记录归到 unknown，不丢', () => {
  const ledger = createLedger()
  const orphan = record({ atMs: T1 })
  delete orphan.provider
  appendRecord(ledger, orphan)
  assert.equal(summarizeDay(ledger, dayKey(T0)).providers[0].provider, 'unknown')
})
test('命中率与宿主 stock 口径一致', () => {
  const ledger = createLedger()
  appendRecord(ledger, record({ buckets: { input: 147678, cacheRead: 19_869_568, output: 127642 } }))
  const day = summarizeDay(ledger, dayKey(T0))
  close(day.hitRate, 19_869_568 / (19_869_568 + 147678), 1e-12, '命中率')
})

console.log('\n[重复计费闸门（包装路由同秒到达两次）]')
test('同会话同指纹在窗口内只记一次', () => {
  const deduper = createUsageDeduper({ windowMs: 10_000 })
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0), true)
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0 + 100), false, '同窗口重复')
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0 + 20_000), true, '超出窗口照记')
})
test('不同会话 / 不同桶 / 不同模型都互不影响', () => {
  const deduper = createUsageDeduper({ windowMs: 10_000 })
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0), true)
  assert.equal(deduper.admit('s2', 'm', BUCKETS, T0), true)
  assert.equal(deduper.admit('s1', 'm2', BUCKETS, T0), true)
  assert.equal(deduper.admit('s1', 'm', { ...BUCKETS, output: 1 }, T0), true)
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0 + 1), false)
})
test('会话数有上限，不会无限增长', () => {
  const deduper = createUsageDeduper({ maxSessions: 2, windowMs: 10_000 })
  deduper.admit('s1', 'm', BUCKETS, T0)
  deduper.admit('s2', 'm', BUCKETS, T0 + 1)
  deduper.admit('s3', 'm', BUCKETS, T0 + 2)
  assert.equal(deduper.size(), 2)
})
test('没有 sessionId 的调用一律放行（宁可多记一次也不漏账）', () => {
  // 宿主内部调用不一定带会话 id。若把它们都归进同一个空串桶，同模型 + 同 token 数的
  // 两次**真实**调用会被判成重复样本丢掉一笔（实测 4 笔记成 3 笔）。
  const deduper = createUsageDeduper({ windowMs: 10_000 })
  assert.equal(deduper.admit(undefined, 'm', BUCKETS, T0), true)
  assert.equal(deduper.admit(undefined, 'm', BUCKETS, T0 + 1), true, '同一毫秒级窗口内也不去重')
  assert.equal(deduper.admit('', 'm', BUCKETS, T0 + 2), true)
  assert.equal(deduper.admit(null, 'm', BUCKETS, T0 + 3), true)
  assert.equal(deduper.size(), 0, '它们不该占用会话表')
  // 带会话的照旧去重
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0), true)
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0 + 10), false)
  return '无会话 = 放行'
})
test('去重窗口钉住：同指纹 10 秒内算 1 笔、超窗才有第 2 笔（刻意接受少账）', () => {
  // 不传参数 = 钉住**出厂行为**（默认窗口）。这条用例同时就是窗口变更的哨兵：
  // 谁把 windowMs 改短/改长，这里的边界断言会先红，改的人必须说明依据。
  const deduper = createUsageDeduper()
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0), true, '第一笔：记')
  // 同一会话、同一模型、五桶逐位相同 —— 一次**真实**调用在这里也会被当成重复，
  // 这就是 createUsageDeduper 注释里写明的 tradeoff（防包装重复投递的代价）。
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0 + 9_999), false, '窗口内：判为重复样本，少记一笔')
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0 + 10_000), false, '边界含窗口（sweep 只在 now - at > windowMs 时清）')
  assert.equal(deduper.admit('s1', 'm', BUCKETS, T0 + 10_001), true, '超窗：记第 2 笔')
  // 计数不是靠记忆，是账本侧的效果：两笔真调用只会落成一笔
  const ledger = createLedger()
  for (const offset of [0, 9_999]) {
    if (deduper.admit('s2', 'm', BUCKETS, T0 + offset)) appendRecord(ledger, record({ atMs: T0 + offset, sessionId: 's2' }))
  }
  assert.equal(summarizeDay(ledger, dayKey(T0)).calls, 1, '同指纹两笔 → 只落一笔')
  return '10 秒内 1 笔 · 超窗 2 笔'
})

console.log('\n[展示币种与倒计时]')
test('toDisplay：USD 直出，CNY 乘汇率，汇率非法按 1', () => {
  close(toDisplay(1, { currency: 'USD', exchangeRate: 7.2 }), 1, 1e-12, 'USD')
  close(toDisplay(1, DEFAULT_DISPLAY), 7.2, 1e-12, 'CNY 默认汇率')
  close(toDisplay(1, { currency: 'CNY', exchangeRate: 0 }), 1, 1e-12, '非法汇率')
  assert.equal(toDisplay('x'), null)
})
test('formatCountdown：小时 / 分钟 / 兜底', () => {
  assert.equal(formatCountdown(5 * 3600_000 + 3 * 60_000), '5 小时 3 分')
  assert.equal(formatCountdown(2 * 3600_000), '2 小时')
  assert.equal(formatCountdown(3 * 60_000), '3 分钟')
  assert.equal(formatCountdown(30_000), '<1 分钟')
  assert.equal(formatCountdown(3 * 60_000, 'en'), '3 min')
  assert.equal(formatCountdown(undefined), '<1 分钟')
})

console.log('\n[侧栏数据（余额 / 今日 / 峰谷倒计时）]')
test('供应商清单 = 已配置的 ∪ 今日有记录的；没用量也列出来', () => {
  const ledger = createLedger()
  appendRecord(ledger, record())
  const data = buildSidebarData({
    ledger,
    date: dayKey(T0),
    now: T1,
    providers: [
      { provider: 'deepseek-official', displayName: 'DeepSeek' },
      { provider: 'walk-grok', displayName: 'walk-grok' },
      { provider: 'wbfd', displayName: 'wbfd' },
    ],
    balance: { provider: 'deepseek-official', amount: 99.54, currency: 'CNY', isAvailable: true },
    peak: { enabled: true, inPeak: false, zoneKind: null, nextAtMs: T1 + 3 * 3600_000, nextIntoPeak: true },
    display: { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2 },
  })
  // 顺序 = 已配置供应商的顺序（切换器要稳定），今日有记录但没配置的排在后面
  assert.deepEqual(data.providers.map(item => item.provider), ['deepseek-official', 'walk-grok', 'wbfd'])
  close(data.total.usd, UNIT_USD, 1e-12, '今日合计')
  close(data.total.amount, UNIT_USD * 7.2, 1e-12, '今日合计（展示币种）')
  assert.equal(data.balance.amount, 99.54)
  assert.equal(data.peak.inPeak, false)
  assert.equal(data.peak.countdown, '3 小时')
  assert.equal(data.peak.countdownMs, 3 * 3600_000)
  assert.equal(data.date, dayKey(T0))
})
test('余额只出现在官方那条：没有 balance 时字段为 null', () => {
  const data = buildSidebarData({ ledger: createLedger(), date: dayKey(T0), balance: null, peak: null })
  assert.equal(data.balance, null)
  assert.equal(data.peak, null)
  assert.equal(data.total.usd, null, '没有记录时金额是 null（不是 0）')
  assert.equal(data.total.amount, null)
})
test('切换供应商时能看到该家的金额/次数/命中率', () => {
  const ledger = createLedger()
  appendRecord(ledger, record({ provider: 'wbfd', model: 'cn:deepseek-v4.1-flash' }))
  appendRecord(ledger, record({ atMs: T1, provider: 'walk-grok' }))
  const data = buildSidebarData({
    ledger,
    date: dayKey(T0),
    now: T1,
    providers: [{ provider: 'deepseek-official', displayName: 'DeepSeek' }],
  })
  const wbfd = data.providers.find(item => item.provider === 'wbfd')
  const deepseek = data.providers.find(item => item.provider === 'deepseek-official')
  assert.equal(wbfd.calls, 1)
  close(wbfd.usd, UNIT_USD, 1e-12, 'wbfd 金额')
  assert.equal(deepseek.calls, 0, '官方这条今天没用量也列出来')
  assert.equal(deepseek.usd, 0)
  close(data.total.usd, UNIT_USD * 2, 1e-12, '今日合计（所有供应商相加）')
})

console.log('\n[模型花费卡片 buildModelCard]')
test('config 显式传 null 不炸（默认值只兜 undefined）', () => {
  const ledger = createLedger()
  appendRecord(ledger, record())
  // `config = {}` 是解构默认值：只在「没传键」时生效，传 null 会原样进来 → 读 .rows 抛 TypeError。
  const card = buildModelCard({ ledger, date: dayKey(T0), config: null })
  assert.equal(card.period, 'today', 'null 走默认周期')
  assert.equal(card.items.length, 1, '行数走默认 5')
  assert.equal(card.total.calls, 1)
  // 不传 / undefined 的老行为不变
  assert.equal(buildModelCard({ ledger, date: dayKey(T0) }).items.length, 1)
  assert.equal(buildModelCard({ ledger, date: dayKey(T0), config: undefined }).items.length, 1)
  // 非法 rows / 未知 period 照旧兜底（归一不改变原有的容错）
  const weird = buildModelCard({ ledger, date: dayKey(T0), config: { rows: 0, period: 'weird' } })
  assert.equal(weird.period, 'today')
  assert.equal(weird.items.length, 1)
  return 'config: null → 默认今日 / 5 行'
})
test('全未定价：今日与近 90 天两档总额一致为 null（此前一档 null、一档 0）', () => {
  // 造「未定价」照套内已有写法：tierOverride: null → cost/usd 都是 null（见「未定价」那两条用例）。
  const ledger = createLedger()
  appendRecord(ledger, record({ tierOverride: null }))
  const rollup = createRollup()
  // 日汇总路径照生产写法落一次（applyRollupDay 把 null 金额存成数字 0 —— 这正是口径分叉的来源）
  applyRollupDay(rollup, dayKey(T0), summarizeDay(ledger, dayKey(T0)), summarizeDayModels(ledger, dayKey(T0)))
  assert.equal(rollup.days[dayKey(T0)].usd, 0, '前提：日汇总里未定价日的金额是数字 0')
  const today = buildModelCard({ ledger, date: dayKey(T0), config: { period: 'today' } })
  const days90 = buildModelCard({ ledger, rollup, date: dayKey(T0), config: { period: 'days90' } })
  assert.equal(today.total.usd, null, '今日：来自 summarizeDay（本来就是 null）')
  assert.equal(days90.total.usd, null, '近 90 天：来自 summarizeRollup，必须归一成 null 而不是 0')
  assert.equal(today.total.amount, null)
  assert.equal(days90.total.amount, null)
  // 归一不能把计数抹掉
  for (const [label, card] of [['今日', today], ['近 90 天', days90]]) {
    assert.equal(card.total.calls, 1, `${label}：调用数照旧`)
    assert.equal(card.total.unpriced, 1, `${label}：未定价计数照旧`)
  }
  // 有价时仍然是数字（而且两档一致）：未定价归一不能顺手把有价也变成 null
  const priced = createLedger()
  appendRecord(priced, record())
  const pricedRollup = createRollup()
  applyRollupDay(pricedRollup, dayKey(T0), summarizeDay(priced, dayKey(T0)), summarizeDayModels(priced, dayKey(T0)))
  const pricedToday = buildModelCard({ ledger: priced, date: dayKey(T0), config: { period: 'today' } })
  const pricedDays90 = buildModelCard({ ledger: priced, rollup: pricedRollup, date: dayKey(T0), config: { period: 'days90' } })
  close(pricedToday.total.usd, UNIT_USD, 1e-12, '今日有价')
  close(pricedDays90.total.usd, UNIT_USD, 1e-12, '近 90 天有价')
  assert.equal(pricedToday.total.amount, toDisplay(UNIT_USD, DEFAULT_DISPLAY), '展示金额也要给出来')
  // 空账本（没有调用）走同一个归一：两档都是 null，不留一个 0
  assert.equal(buildModelCard({ ledger: createLedger(), date: dayKey(T0), config: { period: 'today' } }).total.usd, null)
  assert.equal(buildModelCard({ ledger: createLedger(), rollup: createRollup(), date: dayKey(T0), config: { period: 'days90' } }).total.usd, null)
  return '两档 total.usd/amount = null · unpriced 保持 · 有价仍为数字'
})
test('A4 命中率只有一套公式：卡片行 = 账本（分母含 cacheWrite）', () => {
  const ledger = createLedger()
  appendRecord(ledger, record({ buckets: { input: 1000, cacheRead: 500, cacheWrite: 1000 } }))
  const day = summarizeDay(ledger, dayKey(T0))
  const card = buildModelCard({ ledger, date: dayKey(T0), config: { period: 'today' } })
  const expected = 500 / (1000 + 500 + 1000)
  close(day.hitRate, expected, 1e-12, '账本那侧（summarizeDay）')
  close(card.items[0].hitRate, expected, 1e-12, '卡片行')
  // 关键：两侧必须是**同一个数**。早先卡片那边自己算「cacheRead /(cacheRead + input)」，
  // 分母漏掉 cacheWrite，同一页会出现 33.3% 与 20.0% 两个命中率。
  assert.equal(card.items[0].hitRate, day.hitRate, '两侧必须逐位相等（同一个 cacheHitRate()）')
  assert.equal(card.items[0].tokens, 2500, '卡片 token 总数 = 5 桶之和')
  assert.equal(card.items[0].tokens, day.buckets.input + day.buckets.cacheRead + day.buckets.cacheWrite)
  return `两侧都 = 500/2500 = ${card.items[0].hitRate}`
})

console.log('\n[日汇总：本月 / 累计]')
test('applyRollupDay 是覆盖式写入（同一天记多少次结果都一样）', () => {
  const rollup = createRollup()
  const ledger = createLedger()
  appendRecord(ledger, record())
  applyRollupDay(rollup, dayKey(T0), summarizeDay(ledger, dayKey(T0)))
  const once = JSON.stringify(rollup.days)
  appendRecord(ledger, record({ atMs: T1 }))
  applyRollupDay(rollup, dayKey(T0), summarizeDay(ledger, dayKey(T0)))
  assert.notEqual(JSON.stringify(rollup.days), once, '第二次调用后当日总额应更新')
  const twice = JSON.stringify(rollup.days)
  applyRollupDay(rollup, dayKey(T0), summarizeDay(ledger, dayKey(T0)))
  assert.equal(JSON.stringify(rollup.days), twice, '再写一次不应翻倍')
  assert.equal(rollup.days[dayKey(T0)].calls, 2)
})
test('summarizeRollup：按月前缀 / 按区间 / 全量', () => {
  const rollup = createRollup()
  for (const [date, usd, calls] of [['2026-08-31', 1, 10], ['2026-09-01', 2, 20], ['2026-09-02', 3, 30]]) {
    rollup.days[date] = {
      date, calls, priced: calls, unpriced: 0, usd,
      tokens: { input: calls, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    }
  }
  assert.equal(summarizeRollup(rollup, { prefix: '2026-09' }).usd, 5)
  assert.equal(summarizeRollup(rollup, { prefix: '2026-09' }).calls, 50)
  assert.equal(summarizeRollup(rollup, { from: '2026-09-02', to: '2026-09-30' }).usd, 3)
  const all = summarizeRollup(rollup)
  assert.equal(all.usd, 6)
  assert.equal(all.days, 3)
  assert.equal(all.since, '2026-08-31')
})
test('pruneRollup 只留最近 N 天', () => {
  const rollup = createRollup()
  for (const date of ['2026-01-01', '2026-09-01', '2026-09-10']) {
    rollup.days[date] = { date, calls: 1, priced: 1, unpriced: 0, usd: 1, tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }
  }
  const removed = pruneRollup(rollup, { date: '2026-09-10', keepDays: 30 })
  assert.equal(removed, 1, '只有 2026-01-01 落在 30 天窗口之外')
  assert.deepEqual(Object.keys(rollup.days).sort(), ['2026-09-01', '2026-09-10'])
})
console.log('\n[保留期 normalizeRetention：明细 / 日汇总]')
test('两个键都能省；省了就是「没配」（undefined），交给默认值', () => {
  assert.equal(normalizeRetention(undefined), undefined)
  assert.equal(normalizeRetention(null), undefined)
  assert.equal(normalizeRetention({}), undefined, '空对象 = 没配')
  assert.equal(normalizeRetention([]), undefined)
  assert.equal(normalizeRetention({ other: 1 }), undefined)
})
test('只给一个键：另一个补默认', () => {
  assert.deepEqual(normalizeRetention({ ledgerDays: 30 }), { ledgerDays: 30, rollupDays: ROLLUP_KEEP_DAYS })
  assert.deepEqual(normalizeRetention({ rollupDays: 90 }), { ledgerDays: LEDGER_KEEP_DAYS, rollupDays: 90 })
})
test('日汇总不会短于明细（否则「本月 / 累计」会静默缺天数）', () => {
  assert.deepEqual(normalizeRetention({ ledgerDays: 60, rollupDays: 30 }), { ledgerDays: 60, rollupDays: 60 })
})
test('非法值回落默认；数字串也认；上限 3650；布尔不当数字用', () => {
  assert.deepEqual(normalizeRetention({ ledgerDays: '14', rollupDays: '30.5' }), { ledgerDays: 14, rollupDays: ROLLUP_KEEP_DAYS })
  assert.deepEqual(normalizeRetention({ ledgerDays: 0, rollupDays: -1 }), DEFAULT_RETENTION)
  assert.deepEqual(normalizeRetention({ ledgerDays: 99999 }), DEFAULT_RETENTION)
  assert.deepEqual(normalizeRetention({ ledgerDays: true }), DEFAULT_RETENTION)
  assert.deepEqual(normalizeRetention({ ledgerDays: 3650, rollupDays: 3650 }), { ledgerDays: 3650, rollupDays: 3650 })
})
test('坏文件不会炸：normalizeRollup 丢垃圾、补缺省', () => {
  const rollup = normalizeRollup({ days: { '2026-09-10': { calls: '3', usd: '1.5' }, 'bad-key': { usd: 1 }, x: null } })
  assert.deepEqual(Object.keys(rollup.days), ['2026-09-10'])
  assert.equal(rollup.days['2026-09-10'].calls, 3)
  assert.equal(rollup.days['2026-09-10'].usd, 1.5)
  assert.deepEqual(normalizeRollup(null).days, {})
})
test('本会话费用：self / 子代理 / 合计，「宿主没给归属」时如实报 subagentSupported=false', () => {
  const ledger = createLedger()
  appendRecord(ledger, record({ atMs: T0, sessionId: 's-parent' }))
  appendRecord(ledger, record({ atMs: T0 + 1, sessionId: 's-parent' }))
  appendRecord(ledger, record({ atMs: T0 + 2, sessionId: 's-child', parentSessionId: 's-parent' }))
  appendRecord(ledger, record({ atMs: T0 + 3, sessionId: 's-other' }))
  const off = summarizeSession(ledger, { sessionId: 's-parent', date: dayKey(T0) })
  assert.equal(off.self.calls, 2)
  assert.equal(off.children.calls, 0, '关着时不算子代理')
  assert.equal(off.total.calls, 2, '合计 = 自身')
  assert.equal(off.subagentSupported, true, '账本里有归属信息')
  const on = summarizeSession(ledger, { sessionId: 's-parent', date: dayKey(T0), includeSubagent: true })
  assert.equal(on.self.calls, 2)
  assert.equal(on.children.calls, 1, '子代理那一档单独给出来（界面要能拆开看）')
  assert.equal(on.total.calls, 3)
  close(on.total.usd, on.self.usd + on.children.usd, 1e-9, '合计 = 自身 + 子代理')
  assert.equal(on.total.tokens.total, on.self.tokens.total + on.children.tokens.total, 'token 桶也要相加')
  assert.ok(on.total.models.length >= 1, '给 Top 模型（界面那行要显示）')
  assert.equal(on.total.models[0].amount !== undefined, true, '模型行要带展示币种金额')
  // 未知会话：全 0（界面显示 0 / —），不是报错
  const unknown = summarizeSession(ledger, { sessionId: 'nope', date: dayKey(T0) })
  assert.equal(unknown.total.calls, 0)
  assert.equal(unknown.total.cost, null, '没有调用时金额是 null（不是 0）')
  assert.equal(unknown.total.hitRate, null)
  // 没给 / 空白 sessionId → null（调用方据此 400）
  assert.equal(summarizeSession(ledger, { sessionId: '   ', date: dayKey(T0) }), null)
  assert.equal(summarizeSession(ledger, { date: dayKey(T0) }), null)
  // 老账本（宿主不给归属信息）要如实说，不能假装算过
  const legacy = createLedger()
  appendRecord(legacy, record({ atMs: T0, sessionId: 's-parent' }))
  const legacySummary = summarizeSession(legacy, { sessionId: 's-parent', date: dayKey(T0), includeSubagent: true })
  assert.equal(legacySummary.subagentSupported, false, '没有一条带 parentSessionId → 不支持')
  assert.equal(legacySummary.children.calls, 0)
  return 'self 2 + 子代理 1 = 3 · 不支持时如实报'
})
test('记录上的 parentSessionId 只在给了才写（账本不为这个字段白白多一个 null）', () => {
  const plain = record({ atMs: T0 })
  assert.equal('parentSessionId' in plain, false, '没给就不该有这个键')
  const child = record({ atMs: T0, sessionId: 's-child', parentSessionId: 's-parent' })
  assert.equal(child.parentSessionId, 's-parent')
  // 空串 / 非字符串一律不写
  assert.equal('parentSessionId' in record({ atMs: T0, parentSessionId: '' }), false)
  assert.equal('parentSessionId' in record({ atMs: T0, parentSessionId: 42 }), false)
  // 落盘再读回来还在
  const ledger = createLedger()
  appendRecord(ledger, child)
  const reloaded = normalizeLedger(JSON.parse(JSON.stringify(ledger)))
  assert.equal(reloaded.days[dayKey(T0)].records[0].parentSessionId, 's-parent', '读写一圈不丢')
  return '只在给了才写 · 往返不丢'
})

test('增量累加与覆盖式对齐**结果一致**（记账 O(1) 不等于口径漂移）', () => {
  const ledger = createLedger()
  const incremental = createRollup()
  const full = createRollup()
  for (let index = 0; index < 40; index += 1) {
    const entry = record({ atMs: T0 + index * 1000 })
    appendRecord(ledger, entry)
    addRecordToRollupDay(incremental, dayKey(T0), entry)
  }
  // 覆盖式要把「按模型」明细一起传进来（不传 = 沿用旧的，那当然对不上增量版的明细）
  applyRollupDay(full, dayKey(T0), summarizeDay(ledger, dayKey(T0)), summarizeDayModels(ledger, dayKey(T0)))
  assert.deepEqual(incremental.days[dayKey(T0)], full.days[dayKey(T0)])
  close(incremental.days[dayKey(T0)].usd, UNIT_USD * 40, 1e-9, '累加金额')
  // 两条路径的「按模型」明细也必须一致（两边共用 accumulateRow）
  assert.deepEqual(Object.keys(incremental.days[dayKey(T0)].models).sort(), Object.keys(full.days[dayKey(T0)].models).sort())
  const key = Object.keys(full.days[dayKey(T0)].models)[0]
  assert.equal(full.days[dayKey(T0)].models[key].calls, 40, '按模型明细也要累到 40 条')
})
test('增量累加同时维护「按模型」明细（日汇总与明细同源同口径）', () => {
  const rollup = createRollup()
  // `resolveTier` 会把请求名改写成价表里命中的那个模型名，所以键要从**记录自己**算，
  // 不能在用例里把名字写死（否则测的是价表，不是这里的累加逻辑）。
  const first = record({ atMs: T0, provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash' })
  const second = record({ atMs: T0 + 1, provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash' })
  const third = record({ atMs: T0 + 2, provider: 'nanshan', model: 'grok-4' })
  for (const entry of [first, second, third]) addRecordToRollupDay(rollup, dayKey(T0), entry)
  const keyOf = entry => `${entry.provider}:${entry.model}`
  const day = rollup.days[dayKey(T0)]
  assert.equal(day.calls, 3)
  assert.deepEqual(Object.keys(day.models).sort(), [keyOf(third), keyOf(first)].sort())
  assert.equal(day.models[keyOf(first)].calls, 2)
  assert.equal(day.models[keyOf(third)].calls, 1)
  assert.equal(day.models[keyOf(first)].tokens.input, first.buckets.input * 2, '明细也要累 token 桶')
  // 明细金额之和 = 当日金额（同一条累加口径，允许浮点误差）
  const sum = Object.values(day.models).reduce((total, row) => total + row.usd, 0)
  close(sum, day.usd, 1e-9, '明细金额之和应等于当日金额')
  // 缺 provider/model 的记录归到 unknown 桶，不能丢。
  // （注意用空串：工厂的参数是带默认值的解构，传 undefined 会掉回 'walk-grok'）
  addRecordToRollupDay(rollup, dayKey(T0), record({ atMs: T0 + 3, provider: '', model: '' }))
  assert.equal(rollup.days[dayKey(T0)].models['unknown:unknown'].calls, 1)
  return '2 个模型 + unknown 兜底 · 金额可加总'
})
test('全历史按模型：跨天聚合 + 老数据（没有 models 的那些天）如实报缺口', () => {
  const rollup = createRollup()
  // 老格式的一天（有金额但没有 models）
  applyRollupDay(rollup, '2026-10-01', { calls: 5, priced: 5, unpriced: 0, usd: 1, buckets: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } })
  const m1 = record({ atMs: T0, provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash' })
  const m2 = record({ atMs: T0, provider: 'nanshan', model: 'grok-4' })
  addRecordToRollupDay(rollup, '2026-10-02', m1)
  addRecordToRollupDay(rollup, '2026-10-02', m1)
  addRecordToRollupDay(rollup, '2026-10-03', m1)
  addRecordToRollupDay(rollup, '2026-10-03', m2)
  const key1 = `${m1.provider}:${m1.model}`
  const key2 = `${m2.provider}:${m2.model}`
  const models = summarizeRollupModels(rollup)
  assert.deepEqual(Object.keys(models).sort(), [key1, key2].sort())
  assert.equal(models[key1].calls, 3, '跨天累加')
  assert.equal(models[key1].days, 2, '记下它出现在几天里')
  assert.equal(models[key2].calls, 1)
  // 覆盖率口径：有日期过滤时按天筛
  assert.deepEqual(Object.keys(summarizeRollupModels(rollup, { from: '2026-10-03' })).sort(), [key1, key2].sort())
  assert.deepEqual(Object.keys(summarizeRollupModels(rollup, { from: '2026-10-04' })), [])
  // 2026-10-01 那天有记录却没有按模型明细 → 如实报 1 天缺口（不假装历史全都在）
  assert.equal(rollupDaysMissingModels(rollup), 1)
  return '2 个模型 · 跨 2 天 · 缺口 1 天'
})
test('热力图序列：补齐空天、按日期升序、长度 = 请求天数', () => {
  const rollup = createRollup()
  addRecordToRollupDay(rollup, '2026-10-12', record({ atMs: T0, provider: 'p', model: 'm' }))
  const series = rollupDailySeries(rollup, { date: '2026-10-13', days: 7 })
  assert.equal(series.length, 7, '空天也要补上（否则按周排版会错位）')
  assert.deepEqual(series.map(row => row.date), ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'])
  assert.equal(series[5].calls, 1, '有数据的那天要带上')
  assert.equal(series[0].calls, 0, '空天是 0 而不是缺项')
  assert.equal(series[6].date, '2026-10-13', '最后一项是请求的那天')
  // 0 / 非法值 = 用默认宽度（26 周），上限 3650（别把内存吃光）
  assert.equal(rollupDailySeries(rollup, { date: '2026-10-13', days: 0 }).length, 182, '0 = 走默认')
  assert.equal(rollupDailySeries(rollup, { date: '2026-10-13', days: 'x' }).length, 182, '非法值 = 走默认')
  assert.equal(rollupDailySeries(rollup, { date: '2026-10-13', days: 99_999 }).length, 3650, '上限 3650')
  return '7 天补齐 · 升序 · 兜底 182 · 上限 3650'
})
test('归一化：老 days.json 没 models 字段也能读（当成空 map，不报错）', () => {
  const parsed = {
    version: 1,
    days: {
      '2026-10-01': { calls: 2, priced: 2, unpriced: 0, usd: 0.5, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
      '2026-10-02': {
        calls: 1, priced: 1, unpriced: 0, usd: 0.25,
        tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        models: { 'p:m': { calls: 1, priced: 1, unpriced: 0, usd: 0.25, tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }, bad: null },
      },
    },
  }
  const rollup = normalizeRollup(parsed)
  assert.deepEqual(rollup.days['2026-10-01'].models, {}, '老数据 → 空 map')
  assert.equal(rollup.days['2026-10-02'].models['p:m'].calls, 1)
  assert.equal(rollup.days['2026-10-02'].models.bad, undefined, '坏行丢掉')
  assert.equal(rollup.days['2026-10-02'].usd, 0.25, '金额照旧')
  return '老文件兼容 · 坏行丢弃'
})
test('覆盖式对齐要把 token 桶写进去（summarizeDay 的 tokens 是数字，不是桶）', () => {
  const ledger = createLedger()
  appendRecord(ledger, record())
  const day = summarizeDay(ledger, dayKey(T0))
  // 前提：summarizeDay().tokens 是**数字**（当日总数）——正是这个坑的来源
  assert.equal(typeof day.tokens, 'number', 'summarizeDay 的 tokens 是数字')
  assert.equal(typeof day.buckets, 'object', '桶对象在 buckets 上')
  const rollup = createRollup()
  applyRollupDay(rollup, dayKey(T0), day)
  assert.deepEqual(rollup.days[dayKey(T0)].tokens, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  // 全量对齐之后，月/累计的 token 不能变成 0
  const all = summarizeRollup(rollup)
  assert.equal(all.tokens.input, 1_000_000)
  return 'tokens 桶保住了'
})
test('覆盖式对齐认「已经是桶对象」的入参（两种形状都吃）', () => {
  const rollup = createRollup()
  applyRollupDay(rollup, dayKey(T0), {
    calls: 1, priced: 1, unpriced: 0, usd: 0.5,
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 50 },
  })
  assert.deepEqual(rollup.days[dayKey(T0)].tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 50 })
  applyRollupDay(rollup, dayKey(T0), { calls: 0, priced: 0, unpriced: 0, usd: 0, tokens: 12345 })
  assert.deepEqual(rollup.days[dayKey(T0)].tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
})
test('增量累加：未定价记录只加 token，金额不涨', () => {
  const rollup = createRollup()
  addRecordToRollupDay(rollup, dayKey(T0), record({ tierOverride: null }))
  const day = rollup.days[dayKey(T0)]
  assert.equal(day.calls, 1)
  assert.equal(day.priced, 0)
  assert.equal(day.unpriced, 1)
  assert.equal(day.usd, 0)
  assert.equal(day.tokens.input, 1_000_000)
})
test('空日不计入「累计 N 天」（启动会给今天写一条空汇总）', () => {
  const rollup = createRollup()
  applyRollupDay(rollup, '2026-09-10', { calls: 0, priced: 0, unpriced: 0, usd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } })
  rollup.days['2026-09-09'] = { date: '2026-09-09', calls: 3, priced: 3, unpriced: 0, usd: 1, tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }
  const all = summarizeRollup(rollup)
  assert.equal(all.days, 1, '只有 09-09 有调用')
  assert.equal(all.since, '2026-09-09')
  assert.equal(all.usd, 1, '金额仍然照加（空日是 0）')
})

console.log('\n[今日会话 / 按模型]')
test('按会话分组：调用数、token、金额、命中率、Top 模型', () => {
  const ledger = createLedger()
  const buckets = { input: 1_000_000, output: 0, cacheRead: 3_000_000, cacheWrite: 0, reasoning: 0 }
  appendRecord(ledger, makeCallRecord({
    atMs: T0, provider: 'walk-grok', model: 'deepseek-v4.1-flash', sessionId: 'session-aaa', buckets,
    resolved: resolveTier({ provider: 'walk-grok', model: 'deepseek-v4.1-flash', atMs: T0, snapshot: SNAPSHOT, priceTable: PRICE_TABLE }),
    basisId: 'p1-test0000',
  }))
  appendRecord(ledger, makeCallRecord({
    atMs: T1, provider: 'walk-grok', model: 'deepseek-v4.1-flash', sessionId: 'session-bbb', buckets: BUCKETS,
    resolved: { tier: null, rate: { value: 0.09, basis: 'group' } },
    basisId: 'p1-test0000',
  }))
  const rows = summarizeSessions(ledger, dayKey(T0))
  assert.equal(rows.length, 2)
  const aaa = rows.find(row => row.sessionId === 'session-aaa')
  assert.equal(aaa.calls, 1)
  assert.equal(aaa.tokens.cacheRead, 3_000_000)
  close(aaa.hitRate, 0.75, 1e-12, '会话命中率')
  assert.ok(aaa.usd > 0)
  const bbb = rows.find(row => row.sessionId === 'session-bbb')
  assert.equal(bbb.unpriced, 1, '未定价要计数')
  assert.equal(bbb.usd, 0)
  assert.deepEqual(bbb.models, [{ model: 'deepseek-v4.1-flash', calls: 1 }])
})
test('没有 sessionId 的老记录归到「(未标会话)」而不是丢掉', () => {
  const ledger = createLedger()
  appendRecord(ledger, record())
  const rows = summarizeSessions(ledger, dayKey(T0))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, '(未标会话)')
})
test('按模型聚合：金额降序、未定价单独计', () => {
  const ledger = createLedger()
  appendRecord(ledger, record())
  appendRecord(ledger, record({ atMs: T1, model: 'unknown-model', tierOverride: null }))
  const rows = summarizeModels(ledger, dayKey(T0))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].model, 'deepseek-v4.1-flash')
  close(rows[0].usd, UNIT_USD, 1e-12, '有价那条')
  assert.equal(rows[1].priced, 0)
  assert.equal(rows[1].unpriced, 1)
})

console.log('\n[设置页报表 buildReport]')
function reportFixture() {
  const ledger = createLedger()
  appendRecord(ledger, makeCallRecord({
    atMs: T0, provider: 'walk-grok', model: 'deepseek-v4.1-flash', sessionId: 'session-aaa', buckets: BUCKETS,
    resolved: resolveTier({ provider: 'walk-grok', model: 'deepseek-v4.1-flash', atMs: T0, snapshot: SNAPSHOT, priceTable: PRICE_TABLE }),
    basisId: 'p1-test0000',
  }))
  const rollup = createRollup()
  rollup.days['2026-08-01'] = { date: '2026-08-01', calls: 100, priced: 100, unpriced: 0, usd: 10, tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }
  rollup.days['2026-08-25'] = { date: '2026-08-25', calls: 1, priced: 1, unpriced: 0, usd: UNIT_USD, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }
  return { ledger, rollup }
}
test('今日 / 本月 / 累计三级：今日只算一次（不因日汇总重复计数）', () => {
  const { ledger, rollup } = reportFixture()
  const report = buildReport({
    ledger, rollup, date: '2026-08-25', now: T1, display: DEFAULT_DISPLAY,
    providers: [{ provider: 'walk-grok', displayName: 'Grok 中转' }],
  })
  close(report.totals.today.usd, UNIT_USD, 1e-12, '今日')
  close(report.totals.month.usd, 10 + UNIT_USD, 1e-12, '本月（8-01 + 今日）')
  close(report.totals.all.usd, 10 + UNIT_USD, 1e-12, '累计')
  assert.equal(report.totals.all.days, 2)
  assert.equal(report.totals.all.since, '2026-08-01')
  close(report.totals.today.amount, toDisplay(UNIT_USD, DEFAULT_DISPLAY), 1e-9, '展示币种折算')
  return `今日 ${report.totals.today.usd.toFixed(6)} · 本月 ${report.totals.month.usd.toFixed(6)}`
})
test('预算：按周期取已用金额，给出占比；没填额度时占比为 null', () => {
  const { ledger, rollup } = reportFixture()
  const withAmount = buildReport({ ledger, rollup, date: '2026-08-25', now: T1, budget: { enabled: true, amount: 20, period: 'month' } })
  assert.equal(withAmount.budget.period, 'month')
  // 展示币种是 CNY（汇率 7.2）：额度 20 元 vs 已用 (10+0.027)×7.2 元
  close(withAmount.budget.ratio, ((10 + UNIT_USD) * 7.2) / 20, 1e-9, '占比')
  assert.ok(withAmount.budget.ratio > 1, '这笔已用（≈72 元）确实超了 20 元额度')
  const todayPeriod = buildReport({ ledger, rollup, date: '2026-08-25', now: T1, budget: { enabled: true, amount: 1, period: 'today' } })
  close(todayPeriod.budget.usedUsd, UNIT_USD, 1e-12, '今日口径')
  const noAmount = buildReport({ ledger, rollup, date: '2026-08-25', now: T1, budget: { enabled: true, amount: null, period: 'all' } })
  assert.equal(noAmount.budget.ratio, null)
})
test('预算占比在**同一币种**里算（拿美元已用除人民币额度会差一个汇率）', () => {
  const { ledger, rollup } = reportFixture()
  // 展示币种 CNY（汇率 7.2）：本月已用 10 + 0.027 = 10.027 USD → ¥72.1944
  const report = buildReport({ ledger, rollup, date: '2026-08-25', now: T1, display: DEFAULT_DISPLAY, budget: { enabled: true, amount: 100, period: 'month' } })
  close(report.budget.usedAmount, (10 + UNIT_USD) * 7.2, 1e-9, '已用（展示币种）')
  close(report.budget.ratio, ((10 + UNIT_USD) * 7.2) / 100, 1e-9, '占比')
  assert.ok(report.budget.ratio > 0.7 && report.budget.ratio < 0.73, `占比应在 0.72 附近，实际 ${report.budget.ratio}`)
})
test('预算额度 null / 空串保持「没填」，不会被 Number(null)=0 变成 0', () => {
  for (const amount of [null, '', '   ']) {
    const report = buildReport({ ledger: createLedger(), rollup: createRollup(), budget: { enabled: true, amount, period: 'month' } })
    assert.equal(report.budget.amount, null, `amount=${JSON.stringify(amount)} 应保持 null`)
    assert.equal(report.budget.ratio, null)
  }
  const zero = buildReport({ ledger: createLedger(), rollup: createRollup(), budget: { enabled: true, amount: 0, period: 'month' } })
  assert.equal(zero.budget.amount, 0, '显式给 0 仍然是 0（只是占比无意义）')
  assert.equal(zero.budget.ratio, null)
})
test('A5 全未定价时预算占比是 null（不是 0）；有价时是正常数值', () => {
  // 「未定价」照套内写法：tierOverride: null（cost/usd 都是 null，token 照计）
  const unpriced = createLedger()
  appendRecord(unpriced, record({ tierOverride: null }))
  const none = buildReport({
    ledger: unpriced, rollup: createRollup(), date: dayKey(T0),
    budget: { enabled: true, amount: 100, period: 'today' },
  })
  assert.equal(none.totals.today.unpriced, 1, '未定价计数照旧')
  assert.equal(none.budget.usedUsd, null, '已用金额（USD）是 null')
  assert.equal(none.budget.usedAmount, null, '已用金额（展示币种）也是 null')
  assert.equal(none.budget.ratio, null, '占比必须是 null：「没有价」不能画成「用了 0%」')
  assert.equal(none.budget.ratio === 0, false, '尤其不能是 0')

  const priced = createLedger()
  appendRecord(priced, record())
  const hit = buildReport({
    ledger: priced, rollup: createRollup(), date: dayKey(T0), display: DEFAULT_DISPLAY,
    budget: { enabled: true, amount: 100, period: 'today' },
  })
  assert.equal(typeof hit.budget.ratio, 'number', '有价时占比是数值')
  close(hit.budget.ratio, (UNIT_USD * 7.2) / 100, 1e-12, '占比 = 展示币种已用 / 额度')
  return `未定价 null · 有价 ${hit.budget.ratio.toFixed(6)}`
})

console.log('\n[报表：账本落后守卫必须同时看条数和金额]')
const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
/** 一条金额明确是 10 USD 的账本记录：`call` 直接给结果，避开费率噪声。 */
function tenUsdLedger() {
  const ledger = createLedger()
  appendRecord(ledger, makeCallRecord({
    atMs: T0, provider: 'walk-grok', model: 'deepseek-v4.1-flash', sessionId: 'session-aaa', buckets: BUCKETS,
    resolved: resolveTier({ provider: 'walk-grok', model: 'deepseek-v4.1-flash', atMs: T0, snapshot: SNAPSHOT, priceTable: PRICE_TABLE }),
    call: { cost: 10, usd: 10, basis: 'manual', parts: { currency: 'USD' } },
    basisId: 'p1-test0000',
  }))
  return ledger
}
/** 只有未定价记录的一天（账本侧 `day.usd` 是 `null`，条数照数）。 */
function unpricedLedger(count = 1) {
  const ledger = createLedger()
  for (let index = 0; index < count; index += 1) appendRecord(ledger, record({ atMs: T0 + index, tierOverride: null }))
  return ledger
}
function rollupOf(date, day) {
  const rollup = createRollup()
  // 注意形状接近**落盘后读回来**的那一份：`normalizeRollup` 会把 `tokens` 补齐成 5 桶，
  // 所以这里给全 `tokens`（`summarizeRollup` 直接读 `day.tokens[key]`，缺了就抛）。
  rollup.days[date] = { date, ...day }
  return rollup
}
test('日汇总当天行只有金额（calls=0 / 无 calls 键）时不再把金额反减掉', () => {
  const date = dayKey(T0)
  // 三种「快照更完整」的形状。第一种（条数就少）老实现已经能处理；后两种只有金额维度
  // 看得出来 —— 老实现按 `10 - 50 = -40` 把那 50 反减掉，磁盘上有钱、报表却是小值。
  const shapes = [
    ['calls=3（条数维度即可看出落后）', { calls: 3, priced: 3, unpriced: 0, usd: 50, tokens: { ...ZERO_TOKENS } }],
    ['calls=0（写了金额、条数是 0）', { calls: 0, priced: 0, unpriced: 0, usd: 50, tokens: { ...ZERO_TOKENS } }],
    ['无 calls 键（老 / 手写形状）', { usd: 50, tokens: { ...ZERO_TOKENS } }],
  ]
  const notes = []
  for (const [label, row] of shapes) {
    const rollup = rollupOf(date, row)
    const report = buildReport({ ledger: tenUsdLedger(), rollup, date, now: T1 })
    assert.equal(report.totals.month.usd, 50, `${label}：本月该是快照里的 50（实际 ${report.totals.month.usd}）`)
    assert.equal(report.totals.all.usd, 50, `${label}：累计同上（实际 ${report.totals.all.usd}）`)
    assert.equal(report.totals.today.usd, 50, `${label}：今日也以快照为准（账本落后时）`)
    // 账本当天**全空**（一条记录都没有）+ 快照有金额：同一条守卫，不能读成 0
    const empty = buildReport({ ledger: createLedger(), rollup, date, now: T1 })
    assert.equal(empty.totals.month.usd, 50, `${label} + 空账本：本月不能读成 0（实际 ${empty.totals.month.usd}）`)
    assert.equal(empty.totals.all.usd, 50, `${label} + 空账本：累计不能读成 0（实际 ${empty.totals.all.usd}）`)
    notes.push(`${label}→50`)
  }
  return notes.join(' · ')
})
test('day.usd 为 null（全未定价）：按 0 参与比较，且不参与减法污染正常金额', () => {
  const date = dayKey(T0)
  // ① 快照当天全未定价（usd: null）+ 账本有价 10 → 账本没落后 → 10 要补进来，
  //    `null` 不能参与减法（`10 - null` 蒙对、`null - 10` 才是坑）。
  const ten = buildReport({
    ledger: tenUsdLedger(),
    rollup: rollupOf(date, { calls: 1, priced: 0, unpriced: 1, usd: null, tokens: { ...ZERO_TOKENS, input: 1_000_000 } }),
    date, now: T1,
  })
  assert.equal(ten.totals.month.usd, 10, `快照 usd=null 不该吞掉账本的 10（实际 ${ten.totals.month.usd}）`)
  assert.equal(ten.totals.all.usd, 10)
  assert.equal(ten.totals.today.usd, 10, '账本没落后 → 今日取账本金额')

  // ② 账本全未定价（day.usd=null，按 0 参与比较）→ 快照有 50 仍判落后，保留 50 而不是 -50
  for (const calls of [1, 3]) {
    const report = buildReport({
      ledger: unpricedLedger(calls),
      rollup: rollupOf(date, { calls: 0, priced: 0, unpriced: 0, usd: 50, tokens: { ...ZERO_TOKENS } }),
      date, now: T1,
    })
    assert.equal(report.totals.month.usd, 50, `账本 ${calls} 条全未定价：快照的 50 不能反减（实际 ${report.totals.month.usd}）`)
    assert.equal(report.totals.all.usd, 50, `账本 ${calls} 条全未定价：累计同上`)
    assert.equal(report.totals.today.usd, 50, '落后时今日也取快照（它是更完整的一份）')
  }

  // ③ 反向控制：账本比快照**多**（快照还没记上）时不能被误判成落后 —— 差额必须照补
  const fresh = buildReport({
    ledger: tenUsdLedger(),
    rollup: rollupOf(date, { calls: 0, priced: 0, unpriced: 0, usd: 0, tokens: { ...ZERO_TOKENS } }),
    date, now: T1,
  })
  assert.equal(fresh.totals.month.usd, 10, `快照 0 + 账本 10：差额要补上（实际 ${fresh.totals.month.usd}）`)
  assert.equal(fresh.totals.all.usd, 10)
  assert.equal(fresh.totals.today.usd, 10)
  return 'usd=null 按 0 比 · 不污染减法 · 账本领先仍补差额'
})
test('报表带会话 / 模型 / 额度行（额度行并上今日金额）', () => {
  const { ledger, rollup } = reportFixture()
  const report = buildReport({
    ledger, rollup, date: '2026-08-25', now: T1,
    providers: [{ provider: 'walk-grok', displayName: 'Grok 中转' }],
    quotas: [{ provider: 'walk-grok', displayName: 'Grok 中转', type: 'sub2api', status: 'ok', sub2api: { modelCount: 3 } }],
  })
  assert.equal(report.sessions[0].sessionId, 'session-aaa')
  assert.equal(report.models[0].model, 'deepseek-v4.1-flash')
  const quota = report.quotas[0]
  assert.equal(quota.type, 'sub2api')
  assert.equal(quota.displayName, 'Grok 中转')
  close(quota.usd, UNIT_USD, 1e-12, '额度行上的今日金额')
})
test('峰谷相位 + 价目状态原样带进报表', () => {
  const { ledger, rollup } = reportFixture()
  const report = buildReport({
    ledger, rollup, date: '2026-08-25', now: T1, locale: 'zh',
    peak: { enabled: true, inPeak: false, zoneKind: 'off-peak', nextAtMs: T1 + 3_600_000, nextIntoPeak: true },
    prices: { sources: ['official', 'station', 'manual'], breakdown: { official: 20, station: 314 } },
  })
  assert.equal(report.peak.inPeak, false)
  assert.equal(report.peak.countdown, '1 小时')
  assert.deepEqual(report.prices.sources, ['official', 'station', 'manual'])
})
test('报表带当前保留期（设置页「显示」分页拿它回填输入框）', () => {
  const { ledger, rollup } = reportFixture()
  assert.deepEqual(buildReport({ ledger, rollup, date: '2026-08-25' }).retention, DEFAULT_RETENTION, '没配就是默认 7 / 400')
  assert.deepEqual(
    buildReport({ ledger, rollup, date: '2026-08-25', retention: { ledgerDays: 30, rollupDays: 90 } }).retention,
    { ledgerDays: 30, rollupDays: 90 },
  )
})


console.log(`
${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
