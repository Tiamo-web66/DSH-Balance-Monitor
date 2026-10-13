#!/usr/bin/env node
/**
 * DeepSeek 官方余额验证（不出网：fetch 全部打桩）。
 *
 *   node test/balance.test.mjs
 */
import assert from 'node:assert/strict'

import {
  DEEPSEEK_BALANCE_URL,
  DEEPSEEK_PLATFORM_BALANCE_URL,
  isOfficialDeepSeek,
  parseDeepSeekAccountSummary,
  parseDeepSeekBalance,
  queryDeepSeekAccountBalance,
  queryDeepSeekBalance,
} from '../lib/balance.js'

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
async function testAsync(name, fn) {
  try {
    const note = await fn()
    passed++
    console.log(`  ok   ${name}${note === undefined ? '' : `  → ${note}`}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/** 打桩 fetch：记录 URL/头，返回给定 payload。 */
function stub(payload, { status = 200, throws = false, headers = {} } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} })
    if (throws) throw new Error('socket hang up')
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  }
  return { fetchImpl, calls }
}

const DOC_BODY = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
}

console.log('\n[isOfficialDeepSeek：只认官方域名]')
test('官方域名（含子路径）通过', () => {
  assert.equal(isOfficialDeepSeek('https://api.deepseek.com'), true)
  assert.equal(isOfficialDeepSeek('https://api.deepseek.com/anthropic'), true, '官方路由的 baseURL 带 /anthropic')
})
test('其他域名 / 伪装域名 / 非 HTTPS 一律拒绝', () => {
  assert.equal(isOfficialDeepSeek('https://walkcoding.top/v1'), false)
  assert.equal(isOfficialDeepSeek('https://api.deepseek.com.evil.example'), false, '后缀伪装不算官方')
  assert.equal(isOfficialDeepSeek('http://api.deepseek.com'), false, '明文 HTTP 不发 Key')
  assert.equal(isOfficialDeepSeek(''), false)
  assert.equal(isOfficialDeepSeek(undefined), false)
  assert.equal(isOfficialDeepSeek('not a url'), false)
})

console.log('\n[parseDeepSeekBalance：官方响应结构]')
test('官方文档示例：金额是字符串，要转成数字', () => {
  const balance = parseDeepSeekBalance(DOC_BODY)
  assert.equal(balance.isAvailable, true)
  assert.equal(balance.currency, 'CNY')
  assert.equal(balance.total, 110)
  assert.equal(balance.granted, 10)
  assert.equal(balance.toppedUp, 100)
})
test('多币种时优先人民币', () => {
  const balance = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '15.00' },
      { currency: 'CNY', total_balance: '108.00' },
    ],
  })
  assert.equal(balance.currency, 'CNY')
  assert.equal(balance.total, 108)
  assert.equal(balance.infos.length, 2)
})
test('结构不认就返回 null（不把解析失败伪装成余额 0）', () => {
  assert.equal(parseDeepSeekBalance(null), null)
  assert.equal(parseDeepSeekBalance({}), null)
  assert.equal(parseDeepSeekBalance({ balance_infos: [] }), null)
  assert.equal(parseDeepSeekBalance({ balance_infos: 'nope' }), null)
  const partial = parseDeepSeekBalance({ balance_infos: [{ currency: 'CNY', total_balance: '' }] })
  assert.equal(partial.total, null, '空串不是 0')
})

console.log('\n[queryDeepSeekBalance：安全边界与错误形态]')
await testAsync('非官方 baseURL：直接拒绝，且**不发任何请求**', async () => {
  const { fetchImpl, calls } = stub(DOC_BODY)
  const result = await queryDeepSeekBalance('https://walkcoding.top/v1', 'sk-secret', { fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /仅支持官方端点/)
  assert.equal(calls.length, 0, `不该发出请求，实际 ${calls.length} 次`)
  return result.error.slice(0, 40)
})

await testAsync('没有 key：不请求，如实报错', async () => {
  const { fetchImpl, calls } = stub(DOC_BODY)
  const result = await queryDeepSeekBalance('https://api.deepseek.com', '', { fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /API Key/)
  assert.equal(calls.length, 0)
})

await testAsync('成功：打官方端点、带 Bearer 头、解析金额', async () => {
  const { fetchImpl, calls } = stub(DOC_BODY)
  const result = await queryDeepSeekBalance('https://api.deepseek.com/anthropic', 'sk-secret', { fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.balance.total, 110)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, DEEPSEEK_BALANCE_URL)
  assert.equal(calls[0].headers.authorization, 'Bearer sk-secret')
  return calls[0].url
})

await testAsync('401：认成「API Key 无效」，而不是网络问题', async () => {
  const { fetchImpl } = stub({ error: { message: 'Authentication Fails', type: 'authentication_error' } }, { status: 401 })
  const result = await queryDeepSeekBalance('https://api.deepseek.com', 'sk-bad', { fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'API Key 无效')
})

await testAsync('传输故障：报「网络不可达」而不是抛异常', async () => {
  const { fetchImpl } = stub(null, { throws: true })
  const result = await queryDeepSeekBalance('https://api.deepseek.com', 'sk-x', { fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.error, '网络不可达')
})

await testAsync('HTML 回落页 / 非 JSON：判失败而不是当成余额', async () => {
  const html = stub('<!doctype html><html><body>nope</body></html>')
  const first = await queryDeepSeekBalance('https://api.deepseek.com', 'sk-x', { fetchImpl: html.fetchImpl })
  assert.equal(first.ok, false)
  const weird = stub({ ok: 1 })
  const second = await queryDeepSeekBalance('https://api.deepseek.com', 'sk-x', { fetchImpl: weird.fetchImpl })
  assert.equal(second.ok, false)
  assert.match(second.error, /balance_infos/)
})

/** 账号路线的平台余额（形状照实测：data.biz_data.{normal,bonus}_wallets）。 */
const ACCOUNT_BODY = {
  code: 0,
  msg: '',
  data: {
    biz_code: 0,
    biz_msg: '',
    biz_data: {
      normal_wallets: [{ currency: 'CNY', balance: '-0.0433720200000000', token_estimation: '0' }],
      bonus_wallets: [{ currency: 'CNY', balance: '0', token_estimation: '0' }],
      total_costs: [{ currency: 'CNY', amount: '0' }],
    },
  },
}

console.log('\n[账号路线（deepseek-account）：平台余额]')
test('解析平台 get_user_summary：正常钱包 = 总余额，赠送钱包 = 赠送，充值自己算', () => {
  const parsed = parseDeepSeekAccountSummary(ACCOUNT_BODY)
  assert.equal(parsed.total, -0.04337202)
  assert.equal(parsed.granted, 0)
  assert.equal(parsed.toppedUp, -0.043372, '充值 = 正常 - 赠送（保留 6 位）')
  assert.equal(parsed.currency, 'CNY')
  assert.equal(parsed.source, 'account-platform')
})
test('biz_data 直接挂在 data 上也认；缺钱包 / 脏输入返回 null', () => {
  const flat = parseDeepSeekAccountSummary({ data: { normal_wallets: [{ currency: 'CNY', balance: '12.5' }] } })
  assert.equal(flat.total, 12.5)
  assert.equal(flat.granted, null, '没有赠送钱包 → 赠送未知')
  assert.equal(flat.toppedUp, null)
  for (const bad of [null, {}, { data: {} }, { data: { biz_data: {} } }, 'nope']) {
    assert.equal(parseDeepSeekAccountSummary(bad), null, `${JSON.stringify(bad)} 应判 null`)
  }
})

await testAsync('优先平台端点，头用 x-dsh-auth-token（不是 Authorization）', async () => {
  const platform = stub(ACCOUNT_BODY)
  const result = await queryDeepSeekAccountBalance({ token: 'token-abc', fetchImpl: platform.fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'account-platform')
  assert.equal(result.balance.total, -0.04337202)
  assert.equal(platform.calls.length, 1, '平台成功就不该再打推理域')
  assert.equal(platform.calls[0].url, DEEPSEEK_PLATFORM_BALANCE_URL)
  assert.equal(platform.calls[0].headers['x-dsh-auth-token'], 'token-abc')
  assert.equal(platform.calls[0].headers.authorization, undefined, '账号路线不带 Bearer')
})

await testAsync('平台端点挂了 → 回落到推理域（同一 token 也认）', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} })
    if (String(url).includes('platform.deepseek.com')) return new Response('nope', { status: 502 })
    return new Response(JSON.stringify({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '-0.04', granted_balance: '0.00', topped_up_balance: '-0.04' }] }), { status: 200 })
  }
  const result = await queryDeepSeekAccountBalance({ token: 'token-abc', fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'account-api')
  assert.equal(result.balance.total, -0.04)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, DEEPSEEK_BALANCE_URL)
  assert.equal(calls[1].headers['x-dsh-auth-token'], 'token-abc')
})

await testAsync('401 → 引导重新登录；没 token → 直接说明未登录', async () => {
  const unauthorized = stub({ error: 'unauthorized' }, { status: 401 })
  const rejected = await queryDeepSeekAccountBalance({ token: 'expired', fetchImpl: unauthorized.fetchImpl })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /重新登录/)
  const missing = await queryDeepSeekAccountBalance({ token: '' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /未登录/)
})

await testAsync('非官方平台源不发请求（防 token 被送到别处）', async () => {
  const calls = []
  const fetchImpl = async url => { calls.push(String(url)); return new Response(ACCOUNT_BODY === null ? '' : JSON.stringify(ACCOUNT_BODY), { status: 200 }) }
  await queryDeepSeekAccountBalance({ token: 'token-abc', baseURL: 'https://evil.example.com', fetchImpl })
  assert.equal(calls.some(url => url.includes('platform.deepseek.com')), false, '不该打平台端点')
  assert.equal(calls.length, 1, '只允许推理域那一次')
  assert.equal(calls[0], DEEPSEEK_BALANCE_URL)
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
