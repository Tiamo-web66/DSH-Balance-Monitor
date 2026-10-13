#!/usr/bin/env node
/**
 * WorkBuddy 适配器验证：**纯离线**（全部用假 fetch，一个真实请求都不发）。
 *
 *   node test/workbuddy.test.mjs
 *
 * 覆盖三块，按「错一个就会静默算错钱」的顺序：
 *   1. 指纹判定：`/v1/usage` 404 + 模型清单带 `credits` 才算这一类；
 *   2. 站方口径 `/panel/api/usage` 的解析（积分 + 缓存命中两组自变量）；
 *   3. 自身口径 `/panel/api/request_logs` 的求和 —— 窗口切分、`credit_known` 缺失
 *      不当 0、单窗满 1000 条如实标记 `truncated`。
 */
import assert from 'node:assert/strict'

import {
  DEFAULT_USER_AGENT_FILTER,
  LOGS_LIMIT_MAX,
  MAX_LOG_WINDOWS,
  describeWorkBuddyError,
  fetchOwnCredits,
  fetchPanelUsage,
  panelOrigin,
  parseCredits,
  probeWorkBuddy,
  todayStartMs,
} from '../lib/workbuddy.js'

let passed = 0
let failed = 0
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
    failed++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/** 造一个够 requestJson 用的假 Response（body 要能 for-await 出 Buffer）。 */
function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => (String(name).toLowerCase() === 'content-length' ? String(Buffer.byteLength(text)) : null) },
    body: (async function* () { yield Buffer.from(text, 'utf8') })(),
  }
}

/**
 * 同一个响应被多次请求复用时的包装。
 *
 * **必须每次造一个新的**：body 是 async generator，读一次就空了 —— 复用同一个
 * Response 对象会让「第 2 个窗口起全是 0 条」，那正好把「窗口切分」这条逻辑
 * 测成假绿。
 */
const repeated = (body, status = 200) => () => jsonResponse(body, status)

/** 按 URL 前缀分派的假 fetch；返回 `{ fetchImpl, calls }`，calls 记录每次请求的 URL。 */
function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    for (const [matcher, responder] of routes) {
      if (String(url).includes(matcher)) {
        const hit = typeof responder === 'function' ? responder(String(url)) : responder
        if (hit !== undefined) return hit
      }
    }
    return jsonResponse({ error: { message: 'not found', code: 'not_found_error' } }, 404)
  }
  return { fetchImpl, calls }
}

console.log('workbuddy adapter')

// ── 纯函数 ────────────────────────────────────────────────────────────────

test('panelOrigin 丢掉 /v1 与子路径', () => {
  assert.equal(panelOrigin('http://114.66.62.99:7863/v1'), 'http://114.66.62.99:7863')
  assert.equal(panelOrigin('https://a.example.com/relay/v1'), 'https://a.example.com')
  assert.equal(panelOrigin('https://a.example.com'), 'https://a.example.com')
  assert.equal(panelOrigin(''), '')
  assert.equal(panelOrigin('not a url'), '')
})

test('parseCredits 吃三种写法，脏值给 undefined', () => {
  assert.equal(parseCredits('x0.79'), 0.79)
  assert.equal(parseCredits('X 0.5'), 0.5)
  assert.equal(parseCredits('0.11'), 0.11)
  assert.equal(parseCredits(0.03), 0.03)
  assert.equal(parseCredits('x0.03 credits'), undefined, '带后缀的原文交给 pricing 侧处理')
  assert.equal(parseCredits(''), undefined)
  assert.equal(parseCredits(null), undefined)
  assert.equal(parseCredits('x'), undefined)
})

test('todayStartMs 是本地 00:00', () => {
  const start = new Date(todayStartMs(new Date(2026, 9, 13, 21, 31, 59).getTime()))
  assert.equal(start.getHours(), 0)
  assert.equal(start.getMinutes(), 0)
  assert.equal(start.getSeconds(), 0)
  assert.equal(start.getMilliseconds(), 0)
  assert.equal(start.getDate(), 13)
})

// ── 站方口径 ──────────────────────────────────────────────────────────────

await testAsync('fetchPanelUsage 解析 totals 与逐账号缓存命中', async () => {
  const { fetchImpl, calls } = fakeFetch([['/panel/api/usage', repeated({
    totals: {
      requests: 4300, credits: 849.14, credit_samples: 4200,
      credit_tokens: 842960000, credits_per_1m_tokens: 1.0073,
      total_tokens: 900000000, cache_hit_tokens: 891000000, cache_miss_tokens: 9000000, cache_hit_rate: 99.1,
    },
    credit_by_account: [{
      key: '18366525060', realm: 'cn', requests: 720, credits: 230.27,
      credit_samples: 720, credit_tokens: 192250000,
      cache_hit_tokens: 190000000, cache_miss_tokens: 2250000, cache_hit_rate: 98.8,
    }],
    credit_by_model: [{ key: 'deepseek-v4.1-flash', rate: '0.03', credits: 100, credit_tokens: 100000000 }],
  })]])
  const result = await fetchPanelUsage({
    panelBase: 'http://114.66.62.99:7863', apiKey: 'sk-test', from: 1000, to: 2000, fetchImpl,
  })
  assert.equal(result.ok, true)
  assert.equal(result.totals.credits, 849.14)
  assert.equal(result.totals.creditsPer1MTokens, 1.0073)
  assert.equal(result.totals.cacheHitTokens, 891000000)
  assert.equal(result.byAccount.length, 1)
  assert.equal(result.byAccount[0].cacheMissTokens, 2250000, '逐账号的命中/未命中是标定的自变量，必须带出来')
  assert.equal(result.byModel[0].rate, '0.03')
  assert.ok(calls[0].includes('from=1') && calls[0].includes('to=2'), `时间参数按下发秒传：${calls[0]}`)
})

await testAsync('fetchPanelUsage 面板 401 时如实报错，不返回空数当 0', async () => {
  const { fetchImpl } = fakeFetch([['/panel/api/usage', repeated({ error: { message: 'invalid_api_key' } }, 401)]])
  const result = await fetchPanelUsage({ panelBase: 'http://x', apiKey: 'bad', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.equal(result.totals, undefined, '失败时不能给出 totals，否则调用方会把它读成 0')
})

// ── 自身口径 ──────────────────────────────────────────────────────────────

function logEntry(credit, known = true) {
  return { credit, credit_known: known, time: '2026-10-13T21:31:59Z' }
}

await testAsync('fetchOwnCredits 只累加 credit_known，缺失单独计数', async () => {
  const { fetchImpl, calls } = fakeFetch([['/panel/api/request_logs', repeated({
    entries: [logEntry(0.18), logEntry(0.04), logEntry(undefined, false), logEntry(0, true)],
  })]])
  const result = await fetchOwnCredits({
    panelBase: 'http://x:7863', apiKey: 'sk', from: 0, to: 3600_000, fetchImpl,
  })
  assert.equal(result.ok, true)
  assert.equal(result.calls, 4)
  assert.equal(result.unknown, 1, '缺 credit 字段的那条不能当 0 计，但也要数出来')
  assert.ok(Math.abs(result.credits - 0.22) < 1e-9, `credits=${result.credits}`)
  assert.equal(result.truncated, false)
  assert.ok(calls[0].includes(`limit=${LOGS_LIMIT_MAX}`))
  assert.ok(calls[0].includes(`user_agent=${DEFAULT_USER_AGENT_FILTER}`), `默认按 DSH 自己的 UA 过滤：${calls[0]}`)
})

await testAsync('fetchOwnCredits 按窗口切分，避免单次 limit 截断漏数', async () => {
  const { fetchImpl, calls } = fakeFetch([['/panel/api/request_logs', repeated({ entries: [logEntry(1)] })]])
  const result = await fetchOwnCredits({
    panelBase: 'http://x:7863', apiKey: 'sk', from: 0, to: 4 * 3600_000, fetchImpl,
  })
  assert.equal(result.windows, 4, '4 小时应切 4 个窗口')
  assert.equal(calls.length, 4, '每个窗口一次请求')
  assert.ok(Math.abs(result.credits - 4) < 1e-9)
  assert.equal(result.windowCapped, false)
})

await testAsync('fetchOwnCredits 单窗返回满 1000 条 → truncated（如实说可能漏数）', async () => {
  const full = Array.from({ length: LOGS_LIMIT_MAX }, () => logEntry(0.001))
  const { fetchImpl } = fakeFetch([['/panel/api/request_logs', repeated({ entries: full })]])
  const result = await fetchOwnCredits({ panelBase: 'http://x', apiKey: 'sk', from: 0, to: 3600_000, fetchImpl })
  assert.equal(result.truncated, true)
})

await testAsync('fetchOwnCredits 区间过大时窗口封顶并标记 windowCapped', async () => {
  const { fetchImpl, calls } = fakeFetch([['/panel/api/request_logs', repeated({ entries: [logEntry(1)] })]])
  const result = await fetchOwnCredits({
    panelBase: 'http://x', apiKey: 'sk', from: 0, to: 48 * 3600_000, fetchImpl,
  })
  assert.equal(result.windows, MAX_LOG_WINDOWS, '窗口数不能超过上限')
  assert.equal(calls.length, MAX_LOG_WINDOWS)
  assert.equal(result.windowCapped, true)
})

await testAsync('fetchOwnCredits 某个窗口失败不影响其余窗口继续累加', async () => {
  let n = 0
  const { fetchImpl } = fakeFetch([['/panel/api/request_logs', () => {
    n++
    return n === 2 ? jsonResponse({ error: { message: 'boom' } }, 500) : jsonResponse({ entries: [logEntry(2)] })
  }]])
  const result = await fetchOwnCredits({ panelBase: 'http://x', apiKey: 'sk', from: 0, to: 3 * 3600_000, fetchImpl })
  assert.ok(Math.abs(result.credits - 4) < 1e-9, `credits=${result.credits}`)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].status, 500)
})

// ── 指纹与整体探测 ────────────────────────────────────────────────────────

const modelsBody = {
  object: 'list',
  data: [
    { id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', credits: 'x0.03' },
    { id: 'cn:auto', name: 'Auto' },
  ],
}

await testAsync('probeWorkBuddy：/v1/usage 404 + 有 credits → 判定成立', async () => {
  const { fetchImpl } = fakeFetch([
    ['/v1/models', repeated(modelsBody)],
    ['/v1/usage', repeated({ error: { message: 'not found' } }, 404)],
    ['/panel/api/usage', repeated({ totals: { credits: 849.14 }, credit_by_account: [] })],
    ['/panel/api/request_logs', repeated({ entries: [logEntry(0.5)] })],
  ])
  const probe = await probeWorkBuddy('http://114.66.62.99:7863/v1', 'sk', { from: 0, to: 3600_000, fetchImpl })
  assert.equal(probe.detected, true)
  assert.equal(probe.origin, 'http://114.66.62.99:7863')
  assert.equal(probe.ratedModelCount, 1, '只有带 credits 的模型计入指纹')
  assert.equal(probe.models.length, 2, '不带 credits 的模型照样带出去（界面要显示）')
  assert.equal(probe.own.credits, 0.5)
  assert.equal(probe.site.totals.credits, 849.14)
  assert.equal(probe.filter.userAgent, DEFAULT_USER_AGENT_FILTER)
  assert.equal(describeWorkBuddyError(probe), undefined, '判定成立时没有错误文案')
})

await testAsync('probeWorkBuddy：模型都没有 credits → 不判定为这一类', async () => {
  const { fetchImpl } = fakeFetch([
    ['/v1/models', repeated({ object: 'list', data: [{ id: 'gpt-5.5' }] })],
    ['/v1/usage', repeated({ error: { message: 'not found' } }, 404)],
  ])
  const probe = await probeWorkBuddy('http://x/v1', 'sk', { fetchImpl })
  assert.equal(probe.detected, false)
  assert.equal(describeWorkBuddyError(probe), '对端不是 WorkBuddy 型（模型清单里没有 credits 倍率）')
})

await testAsync('probeWorkBuddy：/v1/usage 是 Sub2Api 的 200 → 不判定为这一类', async () => {
  const { fetchImpl } = fakeFetch([
    ['/v1/models', repeated(modelsBody)],
    ['/v1/usage', repeated({ mode: 'unrestricted', balance: 1 })],
  ])
  const probe = await probeWorkBuddy('http://x/v1', 'sk', { fetchImpl })
  assert.equal(probe.detected, false, '有 credits 但 usage 是 200，说明是 Sub2Api 系')
})

await testAsync('probeWorkBuddy：withPanel=false 时一个面板请求都不发', async () => {
  const { fetchImpl, calls } = fakeFetch([
    ['/v1/models', repeated(modelsBody)],
    ['/v1/usage', repeated({ error: {} }, 404)],
  ])
  const probe = await probeWorkBuddy('http://x/v1', 'sk', { withPanel: false, fetchImpl })
  assert.equal(probe.detected, true)
  assert.equal(probe.site, undefined)
  assert.equal(probe.own, undefined)
  assert.ok(calls.every(url => !url.includes('/panel/')), `不该有面板请求：${calls.join(', ')}`)
})

await testAsync('probeWorkBuddy：面板不可用不影响类型判定', async () => {
  const { fetchImpl } = fakeFetch([
    ['/v1/models', repeated(modelsBody)],
    ['/v1/usage', repeated({ error: {} }, 404)],
    ['/panel/api/usage', repeated({ error: { message: 'forbidden' } }, 403)],
    ['/panel/api/request_logs', repeated({ error: { message: 'forbidden' } }, 403)],
  ])
  const probe = await probeWorkBuddy('http://x/v1', 'sk', { from: 0, to: 3600_000, fetchImpl })
  assert.equal(probe.detected, true, '面板读不到不能否掉类型')
  assert.equal(probe.ok, true)
  assert.equal(probe.site.ok, false)
  assert.equal(probe.own.ok, false)
  assert.ok(probe.errors.site !== undefined && probe.errors.own !== undefined)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
