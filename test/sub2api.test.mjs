#!/usr/bin/env node
/**
 * Sub2Api 适配器验证：纯函数用例 + 对真实站的联网用例。
 *
 *   node test/sub2api.test.mjs                      # 跑全部（联网用例从 ~/.dsh/.credentials.yaml 取 key）
 *   node test/sub2api.test.mjs --offline            # 只跑纯函数用例（离线门槛，npm test 走这条）
 *   node test/sub2api.test.mjs --allow-unreachable  # 联网用例里**纯传输层故障**降级为 SKIP（网络不稳时用）
 *
 * 联网用例只发 GET，每站 3 个请求（/v1/usage、/v1/sub2api/billing、/v1/models）。
 * 输出里只出现 key 前 6 位。
 *
 * 失败分两类，别混：**断言失败**（倍率被站方改了、模型清单空了）才是代码/口径问题；
 * **传输层不可达**（DNS/TLS/超时）是环境问题，不算代码回归，`--allow-unreachable` 会把它降成 SKIP。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  apiRoot, isSub2ApiBilling, toNumber, parseBilling, parseUsage,
  computeSpend, probeSub2Api, describeProbeError, DEFAULT_PROVIDER_TYPE,
} from '../lib/sub2api.js'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const OFFLINE = process.argv.includes('--offline')
const ALLOW_UNREACHABLE = process.argv.includes('--allow-unreachable')

/** 传输层故障专用标记：与「断言失败」区分开，供 lenient 模式降级。 */
class Unreachable extends Error {}

/** 探测失败、且**每个**出错端点都是传输层故障（DNS/TLS/超时）→ 环境问题，不是代码回归。 */
function isTransportOnly(probe) {
  if (probe === null || typeof probe !== 'object' || probe.ok) return false
  const errors = Object.values(probe.errors ?? {}).filter(Boolean)
  return errors.length > 0 && errors.every(error => error.transport === true)
}

let passed = 0
let failed = 0
let skipped = 0
let unreachableFailed = 0
function test(name, fn) {
  try {
    const result = fn()
    passed++
    console.log(`  ok   ${name}${result === undefined ? '' : `  → ${result}`}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
async function testAsync(name, fn) {
  try {
    const result = await fn()
    passed++
    console.log(`  ok   ${name}${result === undefined ? '' : `  → ${result}`}`)
  } catch (error) {
    if (error instanceof Unreachable && ALLOW_UNREACHABLE) {
      skipped++
      console.log(`  SKIP ${name}\n       ${error.message}`)
      return
    }
    failed++
    if (error instanceof Unreachable) unreachableFailed++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// ─────────────────────────── 纯函数用例 ───────────────────────────

console.log('\n[apiRoot] baseURL 归一')
test('剥掉结尾 /v1', () => assert.equal(apiRoot('https://walkcoding.top/v1'), 'https://walkcoding.top'))
test('子路径挂载不动它', () => assert.equal(apiRoot('https://nexus.itssx.com/api/grok45'), 'https://nexus.itssx.com/api/grok45'))
test('结尾斜杠', () => assert.equal(apiRoot('https://a.example/v1/'), 'https://a.example'))
test('空值不抛', () => assert.equal(apiRoot(undefined), ''))

console.log('\n[toNumber] 严格取数（不许把解析失败伪装成 0）')
test('数字', () => assert.equal(toNumber(1.5), 1.5))
test('数值字符串', () => assert.equal(toNumber(' 2.25 '), 2.25))
test('null → undefined', () => assert.equal(toNumber(null), undefined))
test('空串 → undefined', () => assert.equal(toNumber(''), undefined))
test('false → undefined', () => assert.equal(toNumber(false), undefined))
test('垃圾串 → undefined', () => assert.equal(toNumber('abc'), undefined))
test('0 保留', () => assert.equal(toNumber(0), 0))

console.log('\n[isSub2ApiBilling] 强判据')
test('object 匹配', () => assert.equal(isSub2ApiBilling({ object: 'sub2api.key_billing' }), true))
test('别的 object 不算', () => assert.equal(isSub2ApiBilling({ object: 'list' }), false))
test('null 不算', () => assert.equal(isSub2ApiBilling(null), false))

console.log('\n[parseBilling] 真实响应（walkcoding 快照）')
test('字段全解出来', () => {
  const billing = parseBilling({
    object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token',
    group_rate_multiplier: 0.09, resolved_rate_multiplier: 0.09,
    peak_rate_enabled: false, effective_rate_multiplier: 0.09,
    observed_at: '2026-10-12T13:48:37.361999438Z',
  })
  assert.equal(billing.effectiveRate, 0.09)
  assert.equal(billing.groupRate, 0.09)
  assert.equal(billing.peak.enabled, false)
  assert.equal(billing.userRate, undefined)
})
test('peak 开启时字段透出', () => {
  const billing = parseBilling({
    object: 'sub2api.key_billing', group_rate_multiplier: 1, resolved_rate_multiplier: 1,
    effective_rate_multiplier: 2, peak_rate_enabled: true, peak_start: '09:00',
    peak_end: '12:00', peak_rate_multiplier: 2, applied_peak_multiplier: 2,
    timezone: 'Asia/Shanghai',
  })
  assert.deepEqual(billing.peak, {
    enabled: true, start: '09:00', end: '12:00', multiplier: 2, applied: 2, timezone: 'Asia/Shanghai',
  })
})
test('非 sub2api 响应返回 undefined', () => assert.equal(parseBilling({ object: 'list' }), undefined))

console.log('\n[parseUsage] 两种 mode')
test('unrestricted / 钱包', () => {
  const usage = parseUsage({
    mode: 'unrestricted', isValid: true, planName: '钱包余额', unit: 'USD',
    balance: 29.92280799, remaining: 29.92280799,
    usage: { total: { requests: 4214, cost: 407.324016, actual_cost: 36.65916144, total_tokens: 596226726 } },
    model_stats: [{ model: 'grok-4.7', requests: 3139, cost: 310.532816, actual_cost: 27.94795344 }],
  })
  assert.equal(usage.mode, 'unrestricted')
  assert.equal(usage.balance, 29.92280799)
  assert.equal(usage.usage.total.cost, 407.324016)
  assert.equal(usage.models[0].model, 'grok-4.7')
})
test('quota_limited / 套餐', () => {
  const usage = parseUsage({
    mode: 'quota_limited', isValid: true, status: 'active', unit: 'USD',
    quota: { limit: 5644.8357, used: 5630.813665, remaining: 14.022035, unit: 'USD' },
    remaining: 14.022035, expires_at: '2027-02-10T14:09:42Z', days_until_expiry: 122,
    usage: { today: { requests: 2, cost: 0.005074, actual_cost: 0.006494 } },
  })
  assert.equal(usage.quota.remaining, 14.022035)
  assert.equal(usage.daysUntilExpiry, 122)
})
test('rate_limits 窗口', () => {
  const usage = parseUsage({ mode: 'quota_limited', rate_limits: [{ window: '5h', limit: 10, used: 3, remaining: 7 }] })
  assert.equal(usage.rateLimits[0].window, '5h')
  assert.equal(usage.rateLimits[0].remaining, 7)
})

console.log('\n[computeSpend] 花费 = 官方价 × 生效倍率')
const fixtureUsage = parseUsage({
  mode: 'unrestricted', unit: 'USD', balance: 29.92,
  usage: { total: { cost: 407.324016, actual_cost: 36.65916144 } },
  model_stats: [
    { model: 'grok-4.7', requests: 3139, cost: 310.532816, actual_cost: 27.94795344 },
    { model: 'grok-4.6', requests: 1075, cost: 96.7912, actual_cost: 8.711208 },
  ],
})
const fixtureBilling = parseBilling({ object: 'sub2api.key_billing', group_rate_multiplier: 0.09, resolved_rate_multiplier: 0.09, effective_rate_multiplier: 0.09, peak_rate_enabled: false })
const spend = computeSpend(fixtureUsage, fixtureBilling)
test('byMultiplier = cost × 0.09', () => assert.equal(Number(spend.byMultiplier.toFixed(6)), Number((407.324016 * 0.09).toFixed(6))))
test('与站方实扣一致 → 不告警', () => assert.equal(spend.mismatch, false))
test('逐模型花费都算', () => assert.equal(spend.models.length, 2))
test('逐模型花费 = 原价 × 倍率', () => assert.equal(Number(spend.models[0].spend.toFixed(6)), Number((310.532816 * 0.09).toFixed(6))))
test('缺失倍率不静默当 1', () => {
  const noRate = computeSpend(fixtureUsage, undefined)
  assert.equal(noRate.byMultiplier, null)
  assert.equal(noRate.delta, null)
})
test('口径分歧会置 mismatch', () => {
  // 必须走 parseUsage，让 total 过 parseTotals（手工构造对象会漏掉字段改名）。
  const withTotal = parseUsage({
    mode: 'quota_limited', unit: 'USD',
    quota: { limit: 1, used: 1, remaining: 0 },
    usage: { today: { cost: 0.005074, actual_cost: 0.006494 }, total: { cost: 0.005074, actual_cost: 0.006494 } },
  })
  const one = parseBilling({ object: 'sub2api.key_billing', effective_rate_multiplier: 1, group_rate_multiplier: 1, resolved_rate_multiplier: 1, peak_rate_enabled: false })
  const result = computeSpend(withTotal, one)
  assert.equal(result.period, 'total')
  assert.equal(result.impliedRate.toFixed(4), '1.2799')
  assert.equal(result.mismatch, true, '1 vs 1.28 应告警')
})
test('缺 total 时回落到 today 并标注 period', () => {
  const onlyToday = parseUsage({
    mode: 'quota_limited', unit: 'USD',
    quota: { limit: 5644.8357, used: 5630.813665, remaining: 14.022035 },
    usage: { today: { cost: 0.005074, actual_cost: 0.006494 } },
  })
  const one = parseBilling({ object: 'sub2api.key_billing', effective_rate_multiplier: 1, group_rate_multiplier: 1, resolved_rate_multiplier: 1, peak_rate_enabled: false })
  const result = computeSpend(onlyToday, one)
  assert.equal(result.period, 'today')
  assert.equal(result.officialCost, 0.005074)
  assert.equal(result.actualCost, 0.006494)
})
test('total 与 today 都有时优先 total', () => {
  const both = parseUsage({
    mode: 'unrestricted', unit: 'USD',
    usage: { today: { cost: 9.27827 }, total: { cost: 407.324016 } },
  })
  const result = computeSpend(both, parseBilling({ object: 'sub2api.key_billing', effective_rate_multiplier: 0.09, group_rate_multiplier: 0.09, resolved_rate_multiplier: 0.09, peak_rate_enabled: false }))
  assert.equal(result.period, 'total')
  assert.equal(result.officialCost, 407.324016)
})

console.log('\n[描述错误]')
test('billing 404 → 不是 Sub2Api', () => {
  const text = describeProbeError({ ok: false, errors: { billing: { status: 404, code: 'not_found_error' } } })
  assert.match(text, /不是 Sub2Api/)
})
test('401 → key 无效', () => {
  const text = describeProbeError({ ok: false, errors: { usage: { status: 401, code: 'INVALID_TOKEN' } } })
  assert.match(text, /API Key 无效/)
})

// ─────────────────────────── 联网用例 ───────────────────────────

console.log('\n[probeSub2Api] 模型清单带出 credits（积分倍率型站的「倍率」就挂在这）')
await testAsync('credits 原样带出，空白/缺失不算', async () => {
  const fetchImpl = async url => {
    const path = new URL(url).pathname
    const body = path.endsWith('/v1/models')
      ? {
          object: 'list',
          data: [
            { id: 'cn:deepseek-v4.1-flash', credits: 'x0.11' },
            { id: 'cn:auto' },
            { id: 'cn:weird', credits: '   ' },
          ],
        }
      : path.endsWith('/v1/sub2api/billing')
        ? { object: 'sub2api.key_billing', resolved_rate_multiplier: 0.09, effective_rate_multiplier: 0.09 }
        : { mode: 'unrestricted', unit: 'USD', balance: 1 }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const probe = await probeSub2Api('https://example.invalid/v1', 'sk-test', { fetchImpl })
  assert.equal(probe.models.length, 3)
  assert.equal(probe.models[0].id, 'cn:deepseek-v4.1-flash')
  assert.equal(probe.models[0].credits, 'x0.11')
  assert.equal(probe.models[1].credits, undefined)
  assert.equal(probe.models[2].credits, undefined, '纯空白不算 credits')
  return `带 credits ${probe.models.filter(model => model.credits !== undefined).length} / ${probe.models.length}`
})

if (OFFLINE) {
  console.log(`\n纯函数 ${passed} 通过 / ${failed} 失败（--offline，跳过联网用例）`)
  process.exit(failed === 0 ? 0 : 1)
}

function loadCredentialRefs() {
  const refs = {}
  let text = ''
  try { text = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8') } catch { return refs }
  const block = /^refs:\s*$([\s\S]*?)(?=^\S|\Z)/m.exec(text)
  for (const line of block?.[1].split(/\r?\n/) ?? []) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(\S+)\s*$/.exec(line)
    if (m) refs[m[1]] = m[2]
  }
  return refs
}

const refs = loadCredentialRefs()

/** 与 cordis.patch.yml 的 llm-pi-ai providers 一致；expectedRate 只用于断言人工已知值。 */
const LIVE = [
  { id: 'walk-grok', baseURL: 'https://walkcoding.top/v1', keyEnv: 'WALK_GROK_API_KEY', expectedRate: 0.09 },
  { id: 'walk-gpt', baseURL: 'https://st.walkcoding.top/v1', keyEnv: 'WALK_GPT_API_KEY', expectedRate: 0.12 },
  { id: 'nanshanyougui-claude', baseURL: 'https://nanshanyougui.xyz', keyEnv: 'NANSHANYOUGUI_CLAUDE_API_KEY', expectedRate: 0.1 },
  { id: 'jiuhaoche', baseURL: 'https://nexus.itssx.com/api/grok45', keyEnv: 'JIUHAOCHE_API_KEY', expectedRate: 1 },
]

console.log('\n[联网] Sub2Api 真实站点')
for (const target of LIVE) {
  await testAsync(`${target.id}`, async () => {
    const key = refs[target.keyEnv]
    assert.ok(key, `缺少凭据 ${target.keyEnv}`)
    const probe = await probeSub2Api(target.baseURL, key)
    if (!probe.ok) {
      const detail = `探测失败：${describeProbeError(probe)} (root=${probe.root})`
      if (isTransportOnly(probe)) throw new Unreachable(`[网络不可达] ${detail}`)
      throw new Error(detail)
    }
    assert.equal(probe.detected, true, '应识别为 Sub2Api')
    assert.equal(probe.billing.effectiveRate, target.expectedRate, `倍率应为 ${target.expectedRate}`)
    assert.ok(probe.models.length > 0, '应拿到模型清单')
    return `root=${probe.root} 倍率=${probe.billing.effectiveRate} 模型=${probe.models.length} 余额=${probe.usage?.balance ?? probe.usage?.quota?.remaining} 官方价合计=${probe.spend.officialCost} 按倍率=${probe.spend.byMultiplier?.toFixed(4)} 站方实扣=${probe.spend.actualCost}`
  })
}

console.log('\n[联网] 非 Sub2Api 站点必须被识别出来')
await testAsync('wbfd（不是 sub2api）', async () => {
  const probe = await probeSub2Api('http://114.66.62.99:7863/v1', refs.WBFD_API_KEY)
  // 站点连不上时「探测失败」不是识别结论 —— 不能让它冒充「已正确识别为非 Sub2Api」。
  if (isTransportOnly(probe)) throw new Unreachable(`[网络不可达] ${describeProbeError(probe)}`)
  assert.equal(probe.ok, false, '不应判为 Sub2Api')
  assert.equal(probe.detected, false)
  return describeProbeError(probe).slice(0, 120)
})

await testAsync('deepseek 官方域名（不是 sub2api）', async () => {
  const probe = await probeSub2Api('https://api.deepseek.com', refs.DEEPSEEK_API_KEY)
  if (isTransportOnly(probe)) throw new Unreachable(`[网络不可达] ${describeProbeError(probe)}`)
  assert.equal(probe.ok, false, '不应判为 Sub2Api')
  return describeProbeError(probe).slice(0, 120)
})

console.log('\n[默认值]')
test('默认类型是 other', () => assert.equal(DEFAULT_PROVIDER_TYPE, 'other'))

const skipNote = skipped > 0 ? ` / ${skipped} 跳过（网络不可达）` : ''
console.log(`\n${passed} 通过 / ${failed} 失败${skipNote}`)
if (unreachableFailed > 0) {
  const total = unreachableFailed + skipped
  console.log(`  其中 ${total} 条是传输层不可达（DNS/TLS/超时），属环境问题、非代码回归；`)
  console.log('  网络不稳时可加 --allow-unreachable 把它们降级为 SKIP（等价 npm run test:net:lenient）。')
}
process.exit(failed === 0 ? 0 : 1)
