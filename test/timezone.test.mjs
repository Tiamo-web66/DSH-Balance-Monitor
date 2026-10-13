/**
 * 负偏移时区（UTC-4）下的日期算术回归。
 *
 * 这一套**故意把进程 TZ 设成 America/New_York**：老实现用
 * `Date.parse(date + 'T00:00:00Z') - n * 86400000` 算出 UTC 午夜，再用**本地日历**的
 * `dayKey()` 格式化 —— 在 UTC+ 时区（比如本机 Asia/Shanghai）会蒙对，
 * 只有在负偏移时区才会整体偏一天：
 *   热力图末格变成昨天（今天的钱看不到）、「近 90 天」把今天排除、保留期多留一天。
 * 所以这套的价值全在「跑在负偏移下」这件事上，别把它挪到默认时区去跑。
 */
process.env.TZ = 'America/New_York'

import assert from 'node:assert/strict'
import {
  addDays,
  addRecordToRollupDay,
  buildModelCard,
  createLedger,
  createRollup,
  dayKey,
  pruneRollup,
  rollupDailySeries,
} from '../lib/usage-ledger.js'
import { makeCallRecord } from '../lib/pricing.js'

let passed = 0
let failed = 0
function test(name, run) {
  try {
    const note = run()
    passed += 1
    console.log(`  ok   ${name}${note === undefined ? '' : `  → ${note}`}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

const DISPLAY = { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2 }
const record = (atMs = Date.now()) => makeCallRecord({
  atMs,
  provider: 'walk-grok',
  model: 'grok-4.6',
  buckets: { input: 1000 },
  resolved: { tier: null, rate: { value: 1, basis: 'none' } },
  basisId: 'x',
})

console.log('\n[时区：负偏移（UTC-4）下的日期算术]')
assert.equal(new Date().getTimezoneOffset(), 240, '这套必须在 UTC-4 下跑，否则测不出负偏移的错位')
const today = dayKey()

test('addDays 是本地日历加减：往返自洽、跨月跨年正确', () => {
  assert.equal(addDays(today, 0), today)
  assert.equal(addDays(addDays(today, 7), -7), today)
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addDays('2024-03-01', -1), '2024-02-29', '闰年 2 月 29 日')
  return `${today} ± 天自洽`
})

test('热力图序列的末格必须是「今天」（老实现在负偏移下少一天）', () => {
  const series = rollupDailySeries(createRollup(), { date: today, days: 182 })
  assert.equal(series.length, 182)
  assert.equal(series.at(-1).date, today, `末格应等于今天，实际 ${series.at(-1).date}`)
  assert.equal(series[0].date, addDays(today, -181), `首格应是今天 -181 天，实际 ${series[0].date}`)
  return `${series[0].date} → ${series.at(-1).date}`
})

test('今天记的钱出现在末格（不是镜像成昨天）', () => {
  const rollup = createRollup()
  addRecordToRollupDay(rollup, today, record())
  const series = rollupDailySeries(rollup, { date: today, days: 7 })
  assert.equal(series.at(-1).calls, 1, `今天的调用要在末格：${JSON.stringify(series.at(-1))}`)
  assert.equal(series.at(-2).calls, 0, '昨天的那格不该有数')
  return '今天的钱在末格'
})

test('「近 90 天」的起点 = 今天 - 89（老实现给 -90，把今天排除在外）', () => {
  const card = buildModelCard({
    ledger: createLedger(),
    rollup: createRollup(),
    date: today,
    display: DISPLAY,
    config: { period: 'days90', rows: 5 },
  })
  assert.equal(card.from, addDays(today, -89), `实际 ${card.from}`)
  assert.equal(card.period, 'days90')
  return `from = ${card.from}`
})

test('保留期裁剪：keepDays=180 时正好删掉 today-180 那一天', () => {
  const rollup = createRollup()
  addRecordToRollupDay(rollup, addDays(today, -180), record())
  addRecordToRollupDay(rollup, addDays(today, -179), record())
  addRecordToRollupDay(rollup, today, record())
  const dropped = pruneRollup(rollup, { date: today, keepDays: 180 })
  assert.equal(dropped, 1, `应删掉 1 天，实际 ${dropped}`)
  assert.equal(rollup.days[addDays(today, -180)], undefined, 'today-180 该被删')
  assert.ok(rollup.days[addDays(today, -179)] !== undefined, 'today-179 该保留（老实现会连它一起删）')
  assert.ok(rollup.days[today] !== undefined, '今天必须保留')
  return `删 ${dropped} 天 · 边界两天分得清`
})

console.log(`\n${passed} 通过 / ${failed} 失败（TZ=${process.env.TZ}，UTC${-new Date().getTimezoneOffset() / 60}）`)
process.exit(failed === 0 ? 0 : 1)
