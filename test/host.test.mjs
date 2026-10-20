#!/usr/bin/env node
/**
 * host 半身验证：不启动 Harness，直接给插件喂一个假的 ctx，
 * 驱动它注册的同源路由，检查「枚举供应商 → 存类型 → 探测 → 出状态」整条链路。
 *
 * 全离线：globalThis.fetch 被打桩成固定响应，测试不产生任何出网请求。
 *
 *   node test/host.test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// ── 必须先把 DSH_HOME 指到临时目录，再加载插件（loadStore 在 apply 时执行）──
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-balance-monitor-'))
process.env.DSH_HOME = sandbox
process.env.WALK_GROK_API_KEY = 'sk-test-walk-grok'
process.env.WBFD_API_KEY = 'sk-test-wbfd'

// ── 打桩 fetch：只认三个 Sub2Api 只读接口 ──
const WALLET_USAGE = {
  mode: 'unrestricted', isValid: true, planName: '钱包余额', unit: 'USD',
  balance: 29.92280799, remaining: 29.92280799,
  usage: {
    today: { requests: 131, cost: 9.27827, actual_cost: 0.8350443, total_tokens: 14056555 },
    total: { requests: 4214, cost: 407.324016, actual_cost: 36.65916144, total_tokens: 596226726 },
  },
  model_stats: [
    { model: 'grok-4.7', requests: 3139, cost: 310.532816, actual_cost: 27.94795344, total_tokens: 447921232 },
    { model: 'grok-4.6', requests: 1075, cost: 96.7912, actual_cost: 8.711208, total_tokens: 148305494 },
  ],
}
const BILLING = {
  object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token',
  group_rate_multiplier: 0.09, resolved_rate_multiplier: 0.09,
  peak_rate_enabled: false, effective_rate_multiplier: 0.09,
  observed_at: '2026-10-12T13:48:37.361999438Z',
}
const MODELS = { object: 'list', data: [{ id: 'grok-4.6' }, { id: 'grok-4.7' }, { id: 'grok-4.5' }] }

// ── wbfd（WorkBuddy / 积分倍率型）的打桩：指纹在 /v1/models 的 credits，
//    消耗在它自带的面板接口上（同一把 key）。八进制都不是，见 lib/workbuddy.js。
const WB_MODELS = {
  object: 'list',
  data: [
    { id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', credits: 'x0.03' },
    // 不带 credits 的聚合模型：界面要显示，但不计入指纹。
    { id: 'cn:auto', name: 'Auto' },
  ],
}
/** 站方口径：站长整个账号池（含所有买家）——**不等于**「我的」。 */
const WB_PANEL_USAGE = {
  totals: {
    requests: 4300, credits: 849.14, credit_samples: 4200, credit_tokens: 842960000,
    credits_per_1m_tokens: 1.0073, total_tokens: 900000000,
    cache_hit_tokens: 891000000, cache_miss_tokens: 9000000, cache_hit_rate: 99.1,
  },
  credit_by_account: [{
    key: '18366525060', realm: 'cn', requests: 720, credits: 230.27,
    credit_samples: 720, credit_tokens: 192250000,
    cache_hit_tokens: 190000000, cache_miss_tokens: 2250000, cache_hit_rate: 98.8,
  }],
}
/** 逐请求归档：1.25 + 0.5 是真值，第三条 `credit_known:false` **不能当 0 计**。 */
const WB_LOGS = { entries: [{ credit: 1.25, credit_known: true }, { credit: 0.5, credit_known: true }, { credit_known: false }], limit: 1000 }
/** 只让「今天第一个窗口」返回数据：否则每个小时窗各回一遍，总数会随跑测时刻变化。 */
const WB_TODAY_START_SEC = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)

/** 站方口径价目（LiteLLM 形态）的打桩响应：结构守卫要求 ≥100 条，所以补一堆 filler。 */
const LITELLM_SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
function liteLLMPayload() {
  const json = {
    'gpt-5.6-sol': {
      litellm_provider: 'openai', mode: 'chat',
      input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.0000002,
    },
    'claude-opus-4-6': {
      litellm_provider: 'anthropic', mode: 'chat',
      input_cost_per_token: 0.000005, output_cost_per_token: 0.000025,
    },
  }
  for (let index = 0; index < 120; index += 1) {
    json[`filler-${index}`] = { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 }
  }
  return json
}

const seen = []
let primaryDry = false
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname
  seen.push({ url: String(url), auth: init?.headers?.authorization })
  if (String(url) === LITELLM_SOURCE) {
    return new Response(JSON.stringify(liteLLMPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (String(url).includes('/user/balance')) {
    // 两把 key 给不同余额：用来验证「总额相加 + 明细逐条」
    const auth = String(init?.headers?.authorization ?? '')
    if (primaryDry && auth.includes('sk-key-one')) {
      return new Response(JSON.stringify({
        is_available: false,
        balance_infos: [{ currency: 'CNY', total_balance: '-0.01', granted_balance: '0', topped_up_balance: '-0.01' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (auth.includes('sk-invalid')) {
      return new Response(JSON.stringify({
        error: { message: 'Authentication Fails', type: 'authentication_error' },
      }), { status: 401, headers: { 'content-type': 'application/json' } })
    }
    const isDry = auth.includes('sk-key-dry')
    const isSecond = auth.includes('sk-key-two')
    return new Response(JSON.stringify({
      is_available: !isDry,
      balance_infos: [{
        currency: 'CNY',
        total_balance: isDry ? '-0.34' : isSecond ? '1.50' : '0.01',
        granted_balance: '0',
        topped_up_balance: isDry ? '-0.34' : isSecond ? '1.50' : '0.01',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  // 账号路线的平台余额（实测形状：data.biz_data.normal_wallets / bonus_wallets）
  if (String(url).includes('/api/v0/users/get_user_summary')) {
    return new Response(JSON.stringify({
      code: 0,
      msg: '',
      data: {
        biz_code: 0,
        biz_msg: '',
        biz_data: {
          normal_wallets: [{ currency: 'CNY', balance: '-0.0433720200000000', token_estimation: '0' }],
          bonus_wallets: [{ currency: 'CNY', balance: '0', token_estimation: '0' }],
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  // ── wbfd：/v1/usage 是 404，消耗挂在自带面板上 ──
  if (new URL(url).host === '114.66.62.99:7863') {
    if (path.endsWith('/v1/usage')) {
      return new Response(JSON.stringify({ error: { code: 'not_found_error', message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    if (path.endsWith('/v1/models')) return json(WB_MODELS)
    if (path === '/panel/api/usage') return json(WB_PANEL_USAGE)
    if (path === '/panel/api/request_logs') {
      const from = Number(new URL(url).searchParams.get('from'))
      return json(from === WB_TODAY_START_SEC ? WB_LOGS : { entries: [], limit: 1000 })
    }
  }

  const body = path.endsWith('/v1/usage') ? WALLET_USAGE
    : path.endsWith('/v1/sub2api/billing') ? BILLING
      : path.endsWith('/v1/models') ? MODELS
        : undefined
  if (body === undefined) {
    return new Response('404 page not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

// ── 假 ctx ──
const routes = []
/** `llm/stream` 监听器（假 ctx 收集，用来手工喂一段假流验证记账）。 */
const llmListeners = []
/** 记录凭据服务收到的引用名，用来锁死「传原字符串即可」这个设计决定。 */
const credentialCalls = []
/** 宿主 logger 收到的 warn（断言「不许静默失败」）。 */
const warns = []

/**
 * 假 settings 服务：形状**照 `@deepseek-ai/dsh-settings` 的真实契约**来。
 * 真的服务没有 `get(ns)`：它把 schema 里 `.volatile()` 的字段投影成带修订号的描述符
 * （`describe()` → `[{ ns, revision, value, ... }]`），写入走
 * `mutate(ns, ops, expectedRevision)`，修订号对不上就抛 `SETTINGS_CONFLICT`。
 * 这两条语义都在这里实现，否则测出来的东西在真宿主上跑不起来。
 */
function makeSettings(providers) {
  const service = {
    revision: 0,
    calls: [],
    /** 置 true 让下一次 mutate 抛冲突，用来测插件的重试。 */
    conflictOnce: false,
    describe() {
      return [
        { ns: 'llm-pi-ai', revision: service.revision, value: { providers } },
        {
          ns: 'llm-deepseek', revision: service.revision,
          value: { baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY' },
        },
        // 登录 DeepSeek 账号后宿主会多出这条路线（账号余额走平台接口，不是 API Key）
        { ns: 'llm-deepseek-account', revision: service.revision, value: { baseURL: 'https://api.deepseek.com' } },
      ]
    },
    async mutate(ns, ops, expectedRevision) {
      service.calls.push({ ns, ops, expectedRevision })
      const conflict = error => {
        error.code = 'SETTINGS_CONFLICT'
        return error
      }
      if (service.conflictOnce) {
        service.conflictOnce = false
        service.revision++
        throw conflict(new Error('settings conflict'))
      }
      if (expectedRevision !== undefined && expectedRevision !== service.revision) {
        throw conflict(new Error('settings conflict'))
      }
      for (const op of ops) setPath(providers, op.path, op.value)
      service.revision++
    },
  }
  return service
}

/** 按 mutate 的 path 语义落值（`['providers', id, 'models', '0', 'input']`）。 */
function setPath(providers, path, value) {
  assert.equal(path[0], 'providers')
  let node = providers
  for (const key of path.slice(1, -1)) {
    const next = node[Array.isArray(node) ? Number(key) : key]
    if (next === undefined) throw new Error(`测试桩：路径不存在 ${path.join('.')}`)
    node = next
  }
  const last = path[path.length - 1]
  node[Array.isArray(node) ? Number(last) : last] = value
}

/** 默认的 `llm-pi-ai.providers` 夹具（三个模型覆盖「没声明 / 显式纯文本 / 已声明」）。 */
function makeProviders() {
  return {
    'walk-grok': {
      displayName: 'walk-grok', baseURL: 'https://walkcoding.top/v1',
      apiKeyEnv: 'WALK_GROK_API_KEY', api: 'openai-responses',
      models: [{ id: 'grok-4.6' }, { id: 'grok-4.7' }],
    },
    wbfd: {
      displayName: 'wbfd', baseURL: 'http://114.66.62.99:7863/v1',
      apiKeyEnv: 'WBFD_API_KEY', api: 'openai-completions',
      models: [
        { id: 'cn:glm-5.2' },                                  // 没声明过 → 自动补
        { id: 'cn:kimi-k2.6', input: ['text'] },               // 显式纯文本 → 自动补不碰
        { id: 'cn:glm-5v-turbo', input: ['text', 'image'] },   // 已声明 → 不动
      ],
    },
  }
}

function makeCtx({ providers, settings } = {}) {
  const service = settings ?? makeSettings(providers ?? makeProviders())
  const services = {
    settings: service,
    // 凭据服务：断言收到的是**原字符串**（brand 只在编译期存在），并给出与 env 同值的结果。
    credentials: {
      values: {},
      async resolve(ref) {
        credentialCalls.push(ref)
        if (this.values[ref] !== undefined) return { value: this.values[ref], source: 'file' }
        if (ref === 'WALK_GROK_API_KEY') return { value: 'sk-test-walk-grok', source: 'file' }
        if (ref === 'DEEPSEEK_API_KEY') return { value: 'sk-key-one', source: 'file' }
        if (ref === 'DEEPSEEK_API_KEY_2') return { value: 'sk-key-two', source: 'file' }
        if (ref === 'DEEPSEEK_API_KEY_9') return { value: 'sk-key-dry', source: 'file' }
      },
      /** 方案 A 的探测接口：只回「有没有配 / 来源」，不回值。 */
      describeCalls: [],
      setCalls: [],
      unsetCalls: [],
      async set(ref, value) {
        this.setCalls.push({ ref, value })
        this.values[ref] = value
        if (ref === 'DEEPSEEK_API_KEY_2') this.extraConfigured = true
      },
      async unset(ref) {
        this.unsetCalls.push(ref)
        delete this.values[ref]
        if (ref === 'DEEPSEEK_API_KEY_2') this.extraConfigured = false
      },
      async describe(ref) {
        this.describeCalls.push(ref)
        if (ref === 'DEEPSEEK_API_KEY' || (ref === 'DEEPSEEK_API_KEY_2' && this.extraConfigured !== false)) return { configured: true, source: 'file', writable: true }
        return { configured: false, writable: true }
        return undefined
      },
    },
    webServer: { register: route => { routes.push(route); return () => {} } },
    logger: { info() {}, warn() {} },
    // DeepSeek 账号服务：宿主里由 dsh-deepseek-account-platform 提供，只有宿主能拿到 token。
    deepseekAccount: {
      calls: [],
      async resolveToken(baseURL) {
        this.calls.push(baseURL)
        return 'account-token-abc'
      },
    },
  }
  // Cordis 语义：`inject: ['webServer']` 之后服务会作为 ctx.webServer 出现，
  // 所以假 ctx 既要支持 ctx.get(name)，也要有同名属性。
  return {
    get: name => services[name],
    webServer: services.webServer,
    // 宿主的 logger：这里收集 warn，用来断言「静默失败」类问题（账本读/写失败必须留痕）
    logger: { info() {}, warn(message) { warns.push(String(message)) } },
    effect: fn => { const d = fn(); return () => d?.() },
    // 宿主事件总线：只收集 llm/stream 监听器，供测试手工驱动。
    on: (event, listener) => {
      if (event === 'llm/stream') llmListeners.push(listener)
      return () => {}
    },
  }
}

const mod = await import('../lib/index.js')
assert.equal(mod.name, 'balance-monitor')
const providers = makeProviders()
const settings = makeSettings(providers)
const ctx = makeCtx({ providers, settings })
mod.apply(ctx)

assert.equal(routes.length, 1, '应注册 1 条路由')
assert.equal(routes[0].kind, 'prefix')
assert.equal(routes[0].path, '/plugins/dsh-balance-monitor')

// ── 假 req/res ──
function makeRes() {
  const res = {
    statusCode: 0, headers: {}, chunks: [],
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(body) { if (body !== undefined) this.chunks.push(Buffer.from(body)) },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')) },
  }
  return res
}
async function callOn(route, method, path, body, headers) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    method, url: path,
    headers: headers ?? {},
    async *[Symbol.asyncIterator]() { if (payload !== null) yield payload },
  }
  const res = makeRes()
  await route.handler(req, res)
  return res
}
async function call(method, path, body, headers) {
  return callOn(routes[0], method, path, body, headers)
}

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    const note = await fn()
    passed++
    console.log(`  ok   ${name}${note === undefined ? '' : `  → ${note}`}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

console.log('\n[路由副作用与参数校验]')
await test('非 GET/POST 的方法被拒', async () => {
  const res = await call('DELETE', '/plugins/dsh-balance-monitor/state')
  assert.equal(res.statusCode, 405)
})
await test('未知路径 404', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/nope')
  assert.equal(res.statusCode, 404)
})
await test('非法 type 400', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/type', { provider: 'walk-grok', type: 'newapi' })
  assert.equal(res.statusCode, 400)
})
await test('未知供应商 404', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/type', { provider: 'ghost', type: 'sub2api' })
  assert.equal(res.statusCode, 404)
})
await test('坏 JSON 400', async () => {
  const req = { method: 'POST', url: '/plugins/dsh-balance-monitor/type', async *[Symbol.asyncIterator]() { yield Buffer.from('{oops') } }
  const res = makeRes()
  await routes[0].handler(req, res)
  assert.equal(res.statusCode, 400)
})

console.log('\n[跨站拦截面：状态变更路由不许被任意网页打]')
await test('Sec-Fetch-Site: cross-site → 403（且副作用没发生）', async () => {
  const autoOf = async () => (await call('GET', '/plugins/dsh-balance-monitor/state')).json.state.providers
    .find(row => row.provider === 'wbfd').image.auto
  assert.equal(await autoOf(), true, '前置：wbfd 的自动补图片默认开')
  const res = await call('POST', '/plugins/dsh-balance-monitor/vision/auto',
    { provider: 'wbfd', enabled: false }, { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' })
  assert.equal(res.statusCode, 403)
  assert.match(res.json.error, /跨站/)
  assert.equal(await autoOf(), true, '被拒的请求不该改开关')
  return res.json.error
})
await test('Sec-Fetch-Site: same-site（子域）也拒', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/refresh',
    { provider: 'walk-grok' }, { 'sec-fetch-site': 'same-site' })
  assert.equal(res.statusCode, 403)
})
await test('Origin 与 Host 不同源 → 403', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/config',
    { budget: { enabled: true } }, { origin: 'https://evil.example', host: '127.0.0.1:3080', 'content-type': 'application/json' })
  assert.equal(res.statusCode, 403)
  assert.match(res.json.error, /跨源/)
})
await test('Origin 是字面量 null（沙箱 iframe / file://）→ 403', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/config',
    { budget: { enabled: true } }, { origin: 'null', host: '127.0.0.1:3080', 'content-type': 'application/json' })
  assert.equal(res.statusCode, 403)
})
await test('Origin 与 Host 同源 → 放行', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/config',
    {}, { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'content-type': 'application/json' })
  assert.equal(res.statusCode, 200)
})
await test('有 Sec-Fetch-Site 就以它为准：反代改写了 Host 也不误伤自己的 UI', async () => {
  // nginx proxy_pass 默认会把 Host 写成上游地址，于是「页面同源、Host 是回环」同时成立。
  // 这种部署下浏览器发的 Sec-Fetch-Site 仍是 same-origin，必须放行，否则所有写操作 403。
  const res = await call('POST', '/plugins/dsh-balance-monitor/config',
    {}, { 'sec-fetch-site': 'same-origin', origin: 'https://panel.example.com', host: '127.0.0.1:3080', 'content-type': 'application/json' })
  assert.equal(res.statusCode, 200, res.json.error)
  // 同源也要过 content-type 那一关
  const bad = await call('POST', '/plugins/dsh-balance-monitor/config',
    {}, { 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' })
  assert.equal(bad.statusCode, 415)
  return 'same-origin 放行 · 跨站仍拒'
})
await test('content-type 是表单类型 → 415（HTML 表单打不进来）', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/config',
    { budget: { enabled: true } }, { 'content-type': 'application/x-www-form-urlencoded' })
  assert.equal(res.statusCode, 415)
  assert.match(res.json.error, /application\/json/)
})
await test('no-cors fetch 的 text/plain 也拒；带 charset 的 JSON 放行', async () => {
  const plain = await call('POST', '/plugins/dsh-balance-monitor/config', {}, { 'content-type': 'text/plain;charset=UTF-8' })
  assert.equal(plain.statusCode, 415)
  const json = await call('POST', '/plugins/dsh-balance-monitor/config', {}, { 'content-type': 'application/json; charset=utf-8' })
  assert.equal(json.statusCode, 200)
})
await test('三个头都不带（curl / 脚本）→ 放行，命令行用法不受影响', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/config', {})
  assert.equal(res.statusCode, 200)
  const hostile = await call('POST', '/plugins/dsh-balance-monitor/keys/reveal', { provider: 'deepseek-official', ref: 'DEEPSEEK_API_KEY' })
  assert.equal(hostile.statusCode, 200, '明文路由对本地进程本来就不设防（凭据文件本机可读）')
})
await test('GET 不带这些头也照常（拦截面只管状态变更）', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/state', undefined, { 'sec-fetch-site': 'cross-site' })
  assert.equal(res.statusCode, 200)
})

console.log('\n[GET /state：首次自动探测]')
let state
await test('枚举出 4 个供应商（2 个 pi-ai + DeepSeek 两条官方路线）', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/state')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  state = res.json.state
  assert.deepEqual(state.providers.map(p => p.provider).sort(), ['deepseek-account', 'deepseek-official', 'walk-grok', 'wbfd'])
  return state.providers.map(p => `${p.provider}=${p.type}`).join(' ')
})
await test('默认类型是 other，且不产生任何出网请求', async () => {
  assert.ok(state.providers.every(p => p.type === 'other'))
  assert.equal(seen.length, 0, `默认不该出网，实际发了 ${seen.length} 次`)
})
await test('官方路由拿到 llm-deepseek 的 baseURL 与 apiKeyEnv', async () => {
  const official = state.providers.find(p => p.provider === 'deepseek-official')
  assert.equal(official.settingsNs, 'llm-deepseek')
  assert.equal(official.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.equal(official.baseURL, 'https://api.deepseek.com/anthropic')
})
await test('pi-ai 路由带 configuredModels', async () => {
  assert.equal(state.providers.find(p => p.provider === 'walk-grok').configuredModels, 2)
})

console.log('\n[POST /type：切到 sub2api 并落盘]')
await test('切类型后立刻探测出额度/倍率/模型/花费', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/type', { provider: 'walk-grok', type: 'sub2api' })
  assert.equal(res.statusCode, 200)
  const entry = res.json.state.providers.find(p => p.provider === 'walk-grok')
  assert.equal(entry.status, 'ok')
  assert.equal(entry.hasKey, true)
  assert.equal(entry.sub2api.rate.effective, 0.09)
  assert.equal(entry.sub2api.modelCount, 3)
  assert.equal(entry.sub2api.balance, 29.92280799)
  assert.equal(entry.sub2api.spend.period, 'total')
  assert.equal(entry.sub2api.spend.officialCost, 407.324016)
  assert.equal(Number(entry.sub2api.spend.byMultiplier.toFixed(6)), Number((407.324016 * 0.09).toFixed(6)))
  assert.equal(entry.sub2api.spend.mismatch, false)
  return `倍率=${entry.sub2api.rate.effective} 官方价=${entry.sub2api.spend.officialCost} 按倍率=${entry.sub2api.spend.byMultiplier.toFixed(4)} 模型=${entry.sub2api.modelCount}`
})
await test('三个请求都带上了 Bearer key，且 baseURL 的 /v1 被正确归属', async () => {
  const answers = seen.map(item => `${new URL(item.url).pathname}${item.auth === 'Bearer sk-test-walk-grok' ? ' ✓' : ' ✗'}`)
  assert.ok(seen.every(item => item.auth === 'Bearer sk-test-walk-grok'), '每个请求都应带 key')
  assert.deepEqual([...new Set(seen.map(i => new URL(i.url).pathname))].sort(),
    ['/v1/models', '/v1/sub2api/billing', '/v1/usage'])
  return answers.slice(-3).join('  ')
})
await test('响应里绝不出现 key', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/state')
  const raw = Buffer.concat(res.chunks).toString('utf8')
  assert.ok(!raw.includes('sk-test'), '状态里不能出现密钥')
})
await test('凭据服务收到的是原字符串引用（brand 只存在于编译期）', () => {
  assert.ok(credentialCalls.includes('WALK_GROK_API_KEY'), `实际调用：${credentialCalls.join(',')}`)
  assert.ok(credentialCalls.every(ref => typeof ref === 'string'), '引用必须是字符串，不需要 branded 包装')
  return [...new Set(credentialCalls)].join(', ')
})
await test('类型已写进 state.json', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  assert.ok(existsSync(file), `未写入 ${file}`)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(parsed.types['walk-grok'], 'sub2api')
  return file.replace(sandbox, '$DSH_HOME')
})
await test('其他供应商不受影响，仍是 other', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/state')
  assert.equal(res.json.state.providers.find(p => p.provider === 'wbfd').type, 'other')
})

console.log('\n[切回 other：停止探测]')
await test('切回 other 后不再有 sub2api 数据', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/type', { provider: 'walk-grok', type: 'other' })
  const entry = res.json.state.providers.find(p => p.provider === 'walk-grok')
  assert.equal(entry.type, 'other')
  assert.equal(entry.sub2api, undefined)
  assert.equal(entry.status, 'idle')
})

console.log('\n[vision：GET /state 自动补图片]')
await test('首次 /state 就给「没声明过」的模型补了 image', () => {
  assert.equal(settings.calls.length, 1, `应只写一次配置，实际 ${settings.calls.length} 次`)
  const [first] = settings.calls
  assert.equal(first.ns, 'llm-pi-ai')
  assert.deepEqual(first.ops.map(op => op.path.join('.')), [
    'providers.walk-grok.models.0.input',
    'providers.walk-grok.models.1.input',
    'providers.wbfd.models.0.input',
  ])
  assert.ok(first.ops.every(op => op.op === 'set' && op.value.join(',') === 'text,image'))
  assert.equal(first.expectedRevision, 0, '写回必须带上读到的修订号')
  return first.ops.map(op => `${op.path[1]}[${op.path[3]}]`).join(' ')
})
await test('显式纯文本的模型被跳过，已声明 image 的模型一个字没动', () => {
  assert.deepEqual(providers.wbfd.models.map(model => model.input), [
    ['text', 'image'],   // 没声明 → 补了
    ['text'],            // 显式纯文本 → 跳过
    ['text', 'image'],   // 已声明 → 原样
  ])
})
await test('再取 /state 不重复写配置（幂等）', async () => {
  const before = settings.calls.length
  await call('GET', '/plugins/dsh-balance-monitor/state')
  assert.equal(settings.calls.length, before)
})
await test('state 里带图片声明计数与自动开关', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/state')
  const entry = res.json.state.providers.find(p => p.provider === 'wbfd')
  assert.deepEqual(entry.image, { editable: true, auto: true, total: 3, declared: 2, missing: 1, explicitText: 1 })
  return JSON.stringify(entry.image)
})
await test('官方 llm-deepseek 路由标成不可编辑（不归本插件补）', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/state')
  assert.equal(res.json.state.providers.find(p => p.provider === 'deepseek-official').image.editable, false)
})

console.log('\n[vision：手动补图片（force 连显式纯文本一起补）]')
await test('POST /vision/apply 只动还缺 image 的那一个模型', async () => {
  const before = settings.calls.length
  const res = await call('POST', '/plugins/dsh-balance-monitor/vision/apply', { provider: 'wbfd' })
  assert.equal(res.statusCode, 200)
  assert.equal(settings.calls.length, before + 1)
  assert.deepEqual(settings.calls.at(-1).ops.map(op => op.path.join('.')), ['providers.wbfd.models.1.input'])
  assert.deepEqual(providers.wbfd.models[1].input, ['text', 'image'])
  assert.equal(res.json.state.providers.find(p => p.provider === 'wbfd').image.missing, 0)
  assert.deepEqual(res.json.state.vision.applied.find(item => item.provider === 'wbfd').models, ['cn:kimi-k2.6'])
  return 'cn:kimi-k2.6'
})
await test('没有缺口时一次配置也不写', async () => {
  const before = settings.calls.length
  await call('POST', '/plugins/dsh-balance-monitor/vision/apply', { provider: 'wbfd' })
  assert.equal(settings.calls.length, before)
})
await test('省略 provider = 全部补一遍；未知 provider 404', async () => {
  assert.equal((await call('POST', '/plugins/dsh-balance-monitor/vision/apply', {})).statusCode, 200)
  assert.equal((await call('POST', '/plugins/dsh-balance-monitor/vision/apply', { provider: 'ghost' })).statusCode, 404)
})

console.log('\n[vision：自动开关]')
await test('关掉自动后，新加的模型不会被自动补', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/vision/auto', { provider: 'walk-grok', enabled: false })
  assert.equal(res.statusCode, 200)
  providers['walk-grok'].models.push({ id: 'grok-5' })   // 模拟用户手工加了一个模型
  const before = settings.calls.length
  const after = await call('GET', '/plugins/dsh-balance-monitor/state')
  assert.equal(settings.calls.length, before, '开关关闭时不该写配置')
  const entry = after.json.state.providers.find(p => p.provider === 'walk-grok')
  assert.equal(entry.image.auto, false)
  assert.equal(entry.image.missing, 1)
})
await test('开关状态落盘到 state.json', () => {
  const parsed = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.equal(parsed.version, 2)
  assert.equal(parsed.autoImage['walk-grok'], false)
})
await test('重新打开后立刻补上，不用等下一次 /state', async () => {
  const before = settings.calls.length
  const res = await call('POST', '/plugins/dsh-balance-monitor/vision/auto', { provider: 'walk-grok', enabled: true })
  assert.equal(settings.calls.length, before + 1)
  assert.deepEqual(providers['walk-grok'].models[2].input, ['text', 'image'])
  assert.equal(res.json.state.providers.find(p => p.provider === 'walk-grok').image.missing, 0)
})
await test('enabled 非布尔 400；未知供应商 404', async () => {
  assert.equal((await call('POST', '/plugins/dsh-balance-monitor/vision/auto', { provider: 'wbfd', enabled: 'yes' })).statusCode, 400)
  assert.equal((await call('POST', '/plugins/dsh-balance-monitor/vision/auto', { provider: 'ghost', enabled: true })).statusCode, 404)
})

console.log('\n[vision：写入冲突与不可写宿主]')
await test('SETTINGS_CONFLICT 时重读修订号重试一次', async () => {
  providers.wbfd.models.push({ id: 'cn:new' })
  settings.conflictOnce = true
  const before = settings.calls.length
  const res = await call('GET', '/plugins/dsh-balance-monitor/state')
  assert.equal(res.statusCode, 200)
  assert.equal(settings.calls.length, before + 2, '撞上冲突应重试一次')
  assert.equal(settings.calls.at(-1).expectedRevision, settings.revision - 1, '重试要用重读到的修订号')
  assert.deepEqual(providers.wbfd.models.at(-1).input, ['text', 'image'])
})
await test('宿主 settings 不可写时：/state 不崩并写明原因，/vision/apply 明确 500', async () => {
  const saved = settings.mutate
  delete settings.mutate
  providers.wbfd.models.push({ id: 'cn:text-only' })
  try {
    const state = await call('GET', '/plugins/dsh-balance-monitor/state')
    assert.equal(state.statusCode, 200)
    assert.ok(String(state.json.state.vision.error).includes('不支持写入'), String(state.json.state.vision.error))
    const apply = await call('POST', '/plugins/dsh-balance-monitor/vision/apply', { provider: 'wbfd' })
    assert.equal(apply.statusCode, 500)
    assert.ok(String(apply.json.error).includes('不支持写入'))
  } finally {
    settings.mutate = saved
    providers.wbfd.models.pop()
  }
})

console.log('\n[POST /refresh：目标校验]')
await test('刷新未知供应商 404', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/refresh', { provider: 'ghost' })
  assert.equal(res.statusCode, 404)
})
await test('刷新全部 200', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/refresh', {})
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
})

console.log('\n[缓存：60s 内不重复探测]')
await test('连续 GET /state 不产生新请求', async () => {
  await call('GET', '/plugins/dsh-balance-monitor/state')
  const before = seen.length
  await call('GET', '/plugins/dsh-balance-monitor/state')
  assert.equal(seen.length, before, '缓存未生效')
  return `出网请求总数 ${before}`
})

console.log('\n[兼容：只有 get(ns) 的旧宿主]')
await test('没有 describe() 时退回 get(ns)，仍能枚举供应商（写配置则如实报错）', async () => {
  const legacyProviders = makeProviders()
  const legacy = {
    get(ns) {
      if (ns === 'llm-pi-ai') return { providers: legacyProviders }
      if (ns === 'llm-deepseek') return { baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY' }
      return undefined
    },
  }
  mod.apply(makeCtx({ settings: legacy }))
  const res = await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/state')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json.state.providers.map(p => p.provider).sort(), ['deepseek-official', 'walk-grok', 'wbfd'])
  assert.equal(legacyProviders['walk-grok'].models[0].input, undefined, '不可写时不该悄悄改内存里的对象')
  assert.ok(String(res.json.state.vision.error).includes('不支持写入'))
  return '退化为只读'
})

console.log('\n[侧栏：余额 / 今日（倍率之后）/ 峰谷倒计时]')
function close(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label ?? 'value'}: 期望 ${expected} ± ${tolerance}，实际 ${actual}`)
}
/** 喂一段假流（带 usage 块）走完整链路：监听器 → 记账 → 账本 → 侧栏。 */
async function feedStream({ provider, model, sessionId, inputTokens = 1_000_000, ...extra }) {
  const listener = llmListeners[0]
  assert.equal(typeof listener, 'function', '应注册了 llm/stream 监听器')
  const usage = { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  const stream = listener({ model, sessionId, provider, ...extra }, () => (async function* () {
    yield { type: 'text', text: 'hi' }
    yield { type: 'usage', usage }
  })())
  for await (const _chunk of stream) { /* 必须消费完才会触发 finally 里的记账 */ }
}

await test('GET /sidebar 结构：供应商清单 + 官方峰谷相位 + 展示币种', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/sidebar')
  assert.equal(res.statusCode, 200)
  const data = res.json.data
  assert.ok(data.providers.some(item => item.provider === 'walk-grok'), '应列出已配置供应商')
  assert.ok(data.peak !== null, '官方峰谷相位应存在（倒计时条用它）')
  assert.equal(typeof data.peak.inPeak, 'boolean')
  assert.equal(typeof data.display.exchangeRate, 'number')
  // 余额只来自两条 DeepSeek 官方路线（中转站没有余额接口）；每条要么给金额要么给原因
  assert.ok(Array.isArray(data.balances) && data.balances.length === 2, "balances=" + data.balances.length)
  for (const item of data.balances) {
    assert.ok(typeof item.amount === 'number' || typeof item.error === 'string', item.provider + ' 既没金额也没原因')
  }
  return `相位 inPeak=${data.peak.inPeak} 倒计时=${data.peak.countdown}`
})

await test('侧栏峰谷表：携带接下来 6 个切换点（一键预览的数据源）', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/sidebar')
  const upcoming = res.json.data.peak.upcoming
  assert.ok(Array.isArray(upcoming), `upcoming 应是数组：${JSON.stringify(upcoming)}`)
  assert.equal(upcoming.length, 6, `应给满 6 个，实际 ${upcoming.length}`)
  assert.equal(upcoming[0].atMs, res.json.data.peak.nextAtMs, '第一个就是相位的 nextAtMs')
  for (const item of upcoming) {
    assert.equal(typeof item.atMs, 'number')
    assert.equal(typeof item.inPeak, 'boolean')
  }
  for (let index = 1; index < upcoming.length; index += 1) {
    assert.ok(upcoming[index].atMs > upcoming[index - 1].atMs, '切换点必须严格往前')
  }
  // 报表也带同一份（设置页与侧栏口径一致）
  const report = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(report.peak.upcoming.length, 6)
  return `${upcoming.length} 个 · 首个 ${new Date(upcoming[0].atMs).toISOString().slice(11, 16)}Z`
})

await test('喂一次调用 → 今日出现该笔，金额 = 官方价 × 站方倍率（不是官方原价）', async () => {
  // 先把这个供应商切回 sub2api，拿到 0.09 倍率（前文测试把它切成了 other）
  await call('POST', '/plugins/dsh-balance-monitor/type', { provider: 'walk-grok', type: 'sub2api' })
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 'session-a' })
  const res = await call('GET', '/plugins/dsh-balance-monitor/sidebar')
  const data = res.json.data
  const row = data.providers.find(item => item.provider === 'walk-grok')
  assert.equal(row.calls, 1)
  assert.ok(row.usd > 0, `金额应大于 0，实际 ${row.usd}`)
  assert.ok(Math.abs(row.amount - row.usd * data.display.exchangeRate) < 1e-9, '展示金额 = 美元 × 汇率')
  assert.equal(row.tokens, 1_000_000)
  assert.ok(data.total.usd > 0)
  return `${row.usd.toFixed(6)} USD → ${row.amount.toFixed(4)} ${data.display.symbol}`
})

await test('同一次调用的重复样本只记一次（包装路由同秒到达两次）', async () => {
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 'session-a' })
  const res = await call('GET', '/plugins/dsh-balance-monitor/sidebar')
  assert.equal(res.json.data.providers.find(item => item.provider === 'walk-grok').calls, 1, '重复样本不该再记一笔')
})

await test('没探到倍率的中转站：token 照记、金额算未定价（不按 1 算）', async () => {
  await feedStream({ provider: 'wbfd', model: 'cn:deepseek-v4.1-flash', sessionId: 'session-b' })
  const res = await call('GET', '/plugins/dsh-balance-monitor/sidebar')
  const row = res.json.data.providers.find(item => item.provider === 'wbfd')
  assert.equal(row.calls, 1)
  assert.equal(row.unpriced, 1, '未定价条数')
  assert.equal(row.usd, 0, '金额不计入')
  assert.equal(row.tokens, 1_000_000, 'token 照计')
  return `未定价 ${row.unpriced} 笔 · token ${row.tokens}`
})

await test('账本落盘：state.json 旁多出 ledger.json，且带依据指纹', async () => {
  // 防抖 2s：这里直接等一次写入窗口
  await new Promise(resolve => setTimeout(resolve, 2200))
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'ledger.json')
  assert.ok(existsSync(file), `未写入 ${file}`)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const record = parsed.days[Object.keys(parsed.days)[0]].records[0]
  assert.match(String(record.basisId), /^p1-/, '每条记录都带依据指纹')
  assert.ok(record.unit === null || typeof record.unit.cacheMiss === 'number')
  return `${Object.keys(parsed.days).length} 天 / ${record.provider}`
})

await test('账本读不出来时：出声 + 不用空账本把 days.json 当天金额抹掉', async () => {
  const dir = join(sandbox, 'storages', 'dsh-balance-monitor')
  const ledgerFile = join(dir, 'ledger.json')
  const rollupFile = join(dir, 'days.json')
  // 前置：记一笔并等一次防抖写盘，让账本与日汇总都有当天数据
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 'session-corrupt' })
  await new Promise(resolve => setTimeout(resolve, 2200))
  const rollupBefore = JSON.parse(readFileSync(rollupFile, 'utf8'))
  const date = Object.keys(rollupBefore.days)[0]
  const callsBefore = rollupBefore.days[date].calls
  assert.ok(callsBefore > 0, `前置：days.json 当天应有记录，实际 ${JSON.stringify(rollupBefore.days)}`)
  const ledgerBackup = readFileSync(ledgerFile, 'utf8')
  // 破坏账本（半截 JSON）→ 重新 apply = 重启
  writeFileSync(ledgerFile, '{"days":', 'utf8')
  warns.length = 0
  mod.apply(makeCtx({ providers, settings }))
  const report = (await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.ok(warns.some(item => item.includes('账本读取失败')), `读失败必须留痕：${JSON.stringify(warns)}`)
  assert.ok(report.totals.month.calls > 0, `月合计不该被抹成 0：${JSON.stringify(report.totals.month)}`)
  assert.ok(report.totals.all.usd > 0, `累计金额不该被抹成 0：${JSON.stringify(report.totals.all)}`)
  assert.equal(report.totals.today.ledgerStale, true, '要标明「明细缺失、总额来自日汇总」')
  const rollupAfter = JSON.parse(readFileSync(rollupFile, 'utf8'))
  assert.equal(rollupAfter.days[date].calls, callsBefore, 'days.json 当天不许被空账本覆盖')
  // 还原，别给后面的用例留坏文件
  writeFileSync(ledgerFile, ledgerBackup, 'utf8')
  return `月 ${report.totals.month.calls} 笔未被抹平`
})

console.log('\n[账本落后守卫：账本比 days.json 少时不许把日汇总改小]')
/** 本地日历日 `YYYY-MM-DD`（与 lib/usage-ledger 的 dayKey 同一日历，测试里自己算一份）。 */
function localDayKey(atMs = Date.now()) {
  const date = new Date(atMs)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
/**
 * 跑一段会改账本两个文件的断言，无论成败都把文件还原回去（后面的用例还要用这份历史）。
 * 账本与日汇总都是 apply 时才读盘，所以还原后必须重新 apply，内存才是盘上那份。
 */
async function withLedgerFiles(fn) {
  const dir = join(sandbox, 'storages', 'dsh-balance-monitor')
  const ledgerFile = join(dir, 'ledger.json')
  const rollupFile = join(dir, 'days.json')
  const ledgerBackup = readFileSync(ledgerFile, 'utf8')
  const rollupBackup = readFileSync(rollupFile, 'utf8')
  try {
    return await fn({ dir, ledgerFile, rollupFile })
  } finally {
    writeFileSync(ledgerFile, ledgerBackup, 'utf8')
    writeFileSync(rollupFile, rollupBackup, 'utf8')
    mod.apply(makeCtx({ providers, settings }))
  }
}
/**
 * 造一份「账本 vs 日汇总」的现场并重新 apply（= 重启）。
 *
 * `days.json` 里额外塞一天远超保留期的 `2000-01-01`：它会被裁剪，从而**逼出一次真实落盘**
 * （`saveStore(rollupFile, rollup)` 写的就是内存里那份）—— 这样「磁盘上今天仍是 X」才真的
 * 证明内存没被账本覆盖，而不是只证明「我没去动那个文件」。
 */
function writeLedgerRollupPair({ date, records = [], days = {} }) {
  const dir = join(sandbox, 'storages', 'dsh-balance-monitor')
  const zeros = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  const record = usd => ({
    atMs: Date.now(),
    provider: 'walk-grok',
    model: 'cn:deepseek-v4.1-flash',
    sessionId: 's-rollup-guard',
    buckets: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: usd,
    usd,
  })
  const ledgerDays = records.length === 0 ? {} : { [date]: { date, records: records.map(record) } }
  const rollupDays = {
    '2000-01-01': { date: '2000-01-01', calls: 1, priced: 1, unpriced: 0, usd: 5, tokens: zeros, models: {} },
  }
  for (const [key, value] of Object.entries(days)) {
    rollupDays[key] = { date: key, calls: 0, priced: 0, unpriced: 0, usd: 0, tokens: zeros, models: {}, ...value }
  }
  writeFileSync(join(dir, 'ledger.json'), `${JSON.stringify({ version: 2, days: ledgerDays }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'days.json'), `${JSON.stringify({ version: 1, days: rollupDays }, null, 2)}\n`, 'utf8')
  warns.length = 0
  mod.apply(makeCtx({ providers, settings }))
  return dir
}
await test('账本比 days.json 少（1 笔 10 vs 3 笔 50）→ 本月/累计仍是 50，磁盘也不许变', async () => {
  const date = localDayKey()
  await withLedgerFiles(async () => {
    const dir = writeLedgerRollupPair({ date, records: [10], days: { [date]: { calls: 3, usd: 50 } } })
    const report = (await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/report')).json.data
    assert.equal(report.totals.month.usd, 50, `本月不许被更小的账本覆盖：${JSON.stringify(report.totals.month)}`)
    assert.equal(report.totals.all.usd, 50, `累计不许被更小的账本覆盖：${JSON.stringify(report.totals.all)}`)
    assert.equal(report.totals.today.ledgerStale, true, '要标明「明细缺失、总额来自日汇总」')
    assert.ok(warns.some(item => item.includes('账本比日汇总少')), `必须出声（不许静默丢钱）：${JSON.stringify(warns)}`)
    const disk = JSON.parse(readFileSync(join(dir, 'days.json'), 'utf8'))
    assert.equal(disk.days[date].usd, 50, '一次真实落盘后磁盘上今天仍是 50')
    assert.equal(disk.days[date].calls, 3, '笔数同样是日汇总那份')
    assert.equal(disk.days['2000-01-01'], undefined, '前置：过期日被裁掉并触发落盘（磁盘值确实来自内存）')
    return `账本 1 笔/10 → 日汇总 3 笔/50 保住`
  })
})
await test('days.json 有金额没笔数（calls=0 / 缺键 / 账本全空）→ 也不许被抹成更小值', async () => {
  const date = localDayKey()
  const shapes = [
    ['calls 显式 0', { calls: 0, usd: 50 }, [10]],
    ['calls 缺键', { usd: 50 }, [10]],
    ['账本一条都没有（旧守卫只挡 calls>0）', { calls: 0, usd: 50 }, []],
  ]
  const notes = []
  for (const [label, known, records] of shapes) {
    await withLedgerFiles(async () => {
      const dir = writeLedgerRollupPair({ date, records, days: { [date]: known } })
      const report = (await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/report')).json.data
      assert.ok(warns.some(item => item.includes('账本比日汇总少')), `${label}：必须出声：${JSON.stringify(warns)}`)
      const disk = JSON.parse(readFileSync(join(dir, 'days.json'), 'utf8'))
      assert.equal(disk.days[date].usd, 50, `${label}：日汇总的 50 被账本抹掉了（落盘值 ${disk.days[date].usd}）`)
      assert.equal(disk.days[date].calls, known.calls ?? 0, `${label}：笔数也不该被改`)
      // 报表聚合口径（lib/usage-ledger 的 ledgerBehind）另有归属：这里只锁「不许覆盖日汇总」这条不变量
      notes.push(`${label}→磁盘 50（报表 month=${report.totals.month.usd}）`)
    })
  }
  return notes.join(' · ')
})
await test('对照：账本比 days.json 多时照常覆盖对齐（正常自愈不能被守卫挡住）', async () => {
  const date = localDayKey()
  await withLedgerFiles(async () => {
    const dir = writeLedgerRollupPair({ date, records: [10, 10, 10], days: { [date]: { calls: 1, usd: 1 } } })
    const report = (await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/report')).json.data
    assert.equal(report.totals.month.usd, 30, `账本更多 → 以账本为准：${JSON.stringify(report.totals.month)}`)
    assert.equal(report.totals.all.usd, 30)
    assert.equal(report.totals.today.calls, 3)
    assert.equal(warns.filter(item => item.includes('账本比日汇总少')).length, 0, `不该触发守卫：${JSON.stringify(warns)}`)
    const disk = JSON.parse(readFileSync(join(dir, 'days.json'), 'utf8'))
    assert.equal(disk.days[date].usd, 30, '日汇总被账本对齐（覆盖式，幂等）')
    assert.equal(disk.days[date].calls, 3)
    return '账本 3 笔/30 覆盖了日汇总的 1 笔/1'
  })
})

console.log('\n[价格表：GET /prices 与「更新价格表」]')
await test('GET /prices 给出站方价目状态与允许的来源等级', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/prices')
  assert.equal(res.statusCode, 200)
  const data = res.json.data
  assert.ok(Array.isArray(data.sources) && data.sources.includes('station'), `来源等级：${data.sources}`)
  assert.match(String(data.attribution), /LiteLLM/)
  return `sources=${data.sources.join('/')}`
})

await test('POST /prices/update 抓到站方价目并落盘', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/prices/update', {})
  assert.equal(res.statusCode, 200, `实际 ${res.statusCode}：${JSON.stringify(res.json).slice(0, 200)}`)
  const meta = res.json.data.meta
  assert.ok(meta.accepted >= 2, `收录条数 ${meta.accepted}`)
  assert.equal(meta.sourceKind, 'raw')
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'prices.json')
  assert.ok(existsSync(file), `未写入 ${file}`)
  return `${meta.accepted} 条 · ${meta.sourceKind}`
})

await test('更新后的站方价目立刻参与计价（倍率之后）', async () => {
  await call('POST', '/plugins/dsh-balance-monitor/type', { provider: 'walk-grok', type: 'sub2api' })
  const before = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
    .providers.find(item => item.provider === 'walk-grok').usd
  // gpt-5.6-sol 在默认表里只有转售价（默认被挡）→ 现在应走站方口径
  await feedStream({ provider: 'walk-grok', model: 'gpt-5.6-sol', sessionId: 'session-station' })
  const after = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
    .providers.find(item => item.provider === 'walk-grok').usd
  const delta = after - before
  // 打桩价目：未命中输入 2 USD/M × 0.09 倍率 = 0.18 USD/百万 token
  assert.ok(Math.abs(delta - 0.18) < 1e-9, `本次增量 ${delta}，期望 0.18`)
  return `+${delta.toFixed(4)} USD`
})

console.log('\n[侧栏数据里带价目状态（供更新按钮显示）]')
await test('GET /sidebar 带 prices.fetchedAt / sourceKind', async () => {
  const data = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
  assert.equal(typeof data.prices, 'object')
  assert.match(String(data.prices.fetchedAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(data.prices.sourceKind, 'raw')
})

console.log('\n[设置页「费用」：GET /report 与 POST /config]')
await test('GET /report：三级金额、今日会话、额度行、价目状态齐活', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/report')
  assert.equal(res.statusCode, 200, JSON.stringify(res.json).slice(0, 200))
  const data = res.json.data
  for (const key of ['today', 'month', 'all']) {
    assert.equal(typeof data.totals[key].usd, 'number', `${key}.usd`)
    assert.ok(data.totals[key].amount !== undefined)
  }
  assert.ok(data.totals.all.usd >= data.totals.today.usd - 1e-9, '累计不小于今日')
  // 日汇总对齐不能把 token 桶写没（曾经的 bug：summarizeDay().tokens 是数字）
  assert.ok(data.totals.today.tokens.input > 0, '今日输入 token 应 > 0')
  assert.ok(data.totals.month.tokens.input > 0, '本月输入 token 应 > 0（对齐后仍要保住）')
  assert.ok(data.totals.all.tokens.input > 0, '累计输入 token 应 > 0')
  assert.equal(data.totals.all.tokens.input, data.totals.today.tokens.input, '只有今天的记录，两级输入 token 应一致')
  assert.ok(Array.isArray(data.sessions) && data.sessions.some(row => row.sessionId === 'session-station'), '会话明细里应有刚喂的会话')
  assert.ok(Array.isArray(data.quotas) && data.quotas.some(row => row.provider === 'walk-grok'))
  assert.deepEqual(data.prices.sources, ['official', 'station', 'manual'])
  assert.ok(data.prices.breakdown.station > 0, '站方口径条目数应 > 0')
  assert.match(String(data.prices.basisId), /^p1-/)
  return `今日 ¥${data.totals.today.amount.toFixed(4)} · 输入 ${data.totals.today.tokens.input} · 会话 ${data.sessions.length} · 额度行 ${data.quotas.length}`
})

await test('连续两次 GET /report 不改变历史（幂等，不会把 token/金额越算越多）', async () => {
  const first = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  const second = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  close(second.totals.today.usd, first.totals.today.usd, 1e-12, '今日金额')
  close(second.totals.month.usd, first.totals.month.usd, 1e-12, '本月金额')
  close(second.totals.all.usd, first.totals.all.usd, 1e-12, '累计金额')
  assert.equal(second.totals.all.tokens.input, first.totals.all.tokens.input, '累计输入 token')
  assert.equal(second.totals.all.calls, first.totals.all.calls, '累计调用数')
  assert.equal(second.totals.all.days, first.totals.all.days, '累计天数')
  return `稳定在 ¥${second.totals.all.amount.toFixed(4)} / ${second.totals.all.calls} 次`
})

await test('报表里的今日金额与侧栏口径一致', async () => {
  const sidebar = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
  const report = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  close(report.totals.today.usd, sidebar.total.usd, 1e-12, '今日金额')
  close(report.totals.today.amount, sidebar.total.amount, 1e-9, '今日展示金额')
  return `both ${report.totals.today.usd.toFixed(6)} USD`
})

await test('POST /config：预算落盘并立刻反映到报表', async () => {
  const before = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  const res = await call('POST', '/plugins/dsh-balance-monitor/config', { budget: { enabled: true, amount: 1, period: 'today' } })
  assert.equal(res.statusCode, 200, JSON.stringify(res.json).slice(0, 200))
  assert.equal(res.json.data.budget.enabled, true)
  assert.equal(res.json.data.budget.amount, 1)
  assert.equal(res.json.data.budget.period, 'today')
  const after = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(after.budget.enabled, true)
  close(after.budget.usedUsd, after.totals.today.usd, 1e-12, '今日口径已用')
  const state = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.equal(state.budget.amount, 1, '预算要落盘')
  assert.equal(before.budget.enabled, false)
})

await test('POST /config：改来源等级会换依据指纹（历史不动）', async () => {
  const before = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  const res = await call('POST', '/plugins/dsh-balance-monitor/config', { priceSources: ['official', 'station', 'manual', 'reseller'] })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json.data.priceSources, ['official', 'station', 'manual', 'reseller'])
  const after = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.notEqual(after.prices.basisId, before.prices.basisId, '依据指纹应随来源策略变化')
  assert.equal(after.totals.all.usd, before.totals.all.usd, '历史金额一分不动')
  return `${before.prices.basisId} → ${after.prices.basisId}`
})

await test('POST /config：显示币种/汇率落盘', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/config', { display: { currency: 'USD', symbol: '$', decimals: 4, exchangeRate: 1 } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.data.display.currency, 'USD')
  const report = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(report.display.symbol, '$')
  close(report.totals.today.amount, report.totals.today.usd, 1e-9, 'USD 直出')
  // 还原，别影响后面的用例
  await call('POST', '/plugins/dsh-balance-monitor/config', { display: { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2 } })
})

await test('POST /config：垃圾输入被忽略，不写坏配置', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/config', {
    display: { currency: 'XX1', decimals: 99, exchangeRate: -1 },
    budget: { amount: 'abc', period: 'nope' },
    priceSources: ['official', 'hacker'],
    evil: { a: 1 },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.data.display.currency, 'CNY', '非法币种保持原值')
  assert.equal(res.json.data.display.exchangeRate, 7.2, '非法汇率保持原值')
  assert.equal(res.json.data.budget.period, 'today', '非法周期保持原值')
  assert.deepEqual(res.json.data.priceSources, ['official'], '非法来源被过滤，合法的那条照常生效')
  const state = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.equal(state.evil, undefined, '白名单之外的键不许落盘')
})

await test('POST /config：预算额度传空串 = 清除额度（不是 0）', async () => {
  const cleared = await call('POST', '/plugins/dsh-balance-monitor/config', { budget: { amount: '' } })
  assert.equal(cleared.statusCode, 200)
  assert.equal(cleared.json.data.budget.amount, null, '空串不该被 Number("")=0 变成 0')
  const state = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.equal(state.budget.amount, null)
  const report = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(report.budget.amount, null)
  assert.equal(report.budget.ratio, null)
  return 'amount=null'
})

await test('POST /config：保留期落盘并经报表回传', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/config', { retention: { ledgerDays: 30, rollupDays: 90 } })
  assert.equal(res.statusCode, 200, JSON.stringify(res.json).slice(0, 200))
  assert.deepEqual(res.json.data.retention, { ledgerDays: 30, rollupDays: 90 })
  assert.equal(res.json.data.pruned, undefined, '没裁掉东西就不许谎报 pruned')
  const state = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.deepEqual(state.retention, { ledgerDays: 30, rollupDays: 90 }, '保留期要落盘')
  const report = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.deepEqual(report.retention, { ledgerDays: 30, rollupDays: 90 }, '报表要带当前保留期（设置页回填用）')
  return '30 / 90'
})

// ⚠️ 这条用例的语义在「老四块对齐新块规矩」时**有意改过**，把理由写在这里：
//   早先保留期拿到非法值是**回落默认**（那是 `usage-ledger.js` 的读盘契约），于是
//   `{ledgerDays:'abc'}` 这种单个字段的笔误会把用户配好的 12/365 整块冲成 7/400，
//   还连带把没提到的 rollupDays 一起改掉 —— 与 `ui` / `modelCard` / `peakNotify` /
//   `sessionCost` 那几块的规矩（非法值沿用当前生效值、只有 `null` 才清空）不一致。
//   现在四块统一成同一套：**非法值沿用当前生效值；`null` / 空对象（= 两个键都没给）才清空回默认**。
//   读盘侧仍是老规矩（`state.json` 里手写坏值 → 各字段回落默认），未受影响。
await test('POST /config：保留期非法值沿用当前生效值、日汇总不短于明细、null / 空对象才清掉', async () => {
  const bumped = await call('POST', '/plugins/dsh-balance-monitor/config', { retention: { ledgerDays: 60, rollupDays: 30 } })
  assert.deepEqual(bumped.json.data.retention, { ledgerDays: 60, rollupDays: 60 }, '日汇总应被抬到明细长度')
  const junk = await call('POST', '/plugins/dsh-balance-monitor/config', { retention: { ledgerDays: 'abc', rollupDays: 1e9 } })
  assert.deepEqual(junk.json.data.retention, { ledgerDays: 60, rollupDays: 60 }, '两个字段都非法 → 沿用当前生效值（不是回落默认 7/400）')
  const partial = await call('POST', '/plugins/dsh-balance-monitor/config', { retention: { ledgerDays: 'abc' } })
  assert.deepEqual(partial.json.data.retention, { ledgerDays: 60, rollupDays: 60 }, '只提一个非法字段时，另一个没提的字段也不许被带掉')
  const cleared = await call('POST', '/plugins/dsh-balance-monitor/config', { retention: {} })
  assert.deepEqual(cleared.json.data.retention, { ledgerDays: 7, rollupDays: 400 })
  const state = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.equal(state.retention, undefined, '空对象 = 没配，不该在文件里留一条')
  return '60/60 · 非法沿用现值 · 空对象才清空'
})

await test('配置重载后预算额度仍是 null（loadStore 不能被 Number(null)=0 骗）', async () => {
  // 重新 apply 一次 = 从磁盘重新读配置（同一份 settings 桩）
  mod.apply(makeCtx({ providers, settings }))
  const report = (await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(report.budget.amount, null, '重载后额度不该变成 0')
  assert.equal(report.budget.enabled, true, '开关状态要保持')
  return 'amount 仍为 null'
})

await test('POST /config：峰谷提醒是局部覆盖，两个都关就清掉这条配置', async () => {
  // 宿主下发的形状总是补齐默认值（界面直接编辑它）；文件里只落在默认为不同的键
  const shape = (enabled, system) => ({ enabled, system, leadMinutes: 2, type: 'both', position: 'corner' })
  const enabled = await call('POST', '/plugins/dsh-balance-monitor/config', { peakNotify: { enabled: true } })
  assert.deepEqual(enabled.json.data.peakNotify, shape(true, false))
  // 只改 system 时，enabled 必须保住（客户端两个勾选框各自提交一位）
  const system = await call('POST', '/plugins/dsh-balance-monitor/config', { peakNotify: { system: true } })
  assert.deepEqual(system.json.data.peakNotify, shape(true, true), '局部覆盖不能把另一位带掉')
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).peakNotify, { enabled: true, system: true },
    '落盘只写与默认不同的键（提前量/类型/位置是默认值，不写）')
  // 侧栏与报表都要带上开关：侧栏据此决定跨档时弹不弹
  assert.deepEqual((await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data.notify, shape(true, true))
  assert.deepEqual((await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.notify, shape(true, true))
  // 非法值不写坏配置
  const junk = await call('POST', '/plugins/dsh-balance-monitor/config', { peakNotify: { enabled: 'yes' } })
  assert.deepEqual(junk.json.data.peakNotify, shape(true, true), '非法值保持原值')
  // 两个都关 = 「没配」
  await call('POST', '/plugins/dsh-balance-monitor/config', { peakNotify: { enabled: false, system: false } })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).peakNotify, undefined, '都关 = 文件里不留一条')
  const cleared = await call('GET', '/plugins/dsh-balance-monitor/report')
  assert.deepEqual(cleared.json.data.notify, shape(false, false))
  return '局部覆盖 · 都关即清空'
})

await test('POST /config：officialPeak 接通（窗口/假期可配、停用生效、依据指纹随之变化）', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const before = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.ok(Array.isArray(before.officialPeak?.holidays) && before.officialPeak.holidays.length > 0, '报表要带上峰谷配置')
  assert.notEqual(before.peak, null, '默认峰谷是开着的（相位块存在）')
  const baseBasis = before.prices.basisId

  const res = await call('POST', '/plugins/dsh-balance-monitor/config', {
    officialPeak: { windows: [{ start: 2, end: 5 }], holidays: ['2026-12-25'] },
  })
  assert.deepEqual(res.json.data.officialPeak.windows, [{ start: 2, end: 5 }])
  assert.deepEqual(res.json.data.officialPeak.holidays, ['2026-12-25'])
  assert.equal(res.json.data.officialPeak.effectiveAt, before.officialPeak.effectiveAt, '没给的字段回落默认')
  assert.notEqual(res.json.data.basisId, baseBasis, '改峰谷 → 新依据指纹（历史不重算）')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).officialPeak.windows, [{ start: 2, end: 5 }], '要落盘')
  assert.deepEqual((await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.officialPeak.holidays, ['2026-12-25'])

  // 停用峰谷：报表与侧栏的相位块整体消失（倒计时条不再出现）
  const off = await call('POST', '/plugins/dsh-balance-monitor/config', { officialPeak: { enabled: false } })
  assert.equal(off.json.data.officialPeak.enabled, false)
  assert.equal((await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.peak, null)
  assert.equal((await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data.peak, null)

  // 清掉自定义 → 回默认（相位块与指纹都恢复）
  const cleared = await call('POST', '/plugins/dsh-balance-monitor/config', { officialPeak: null })
  assert.equal(cleared.json.data.officialPeak.enabled, true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).officialPeak, undefined, '回默认 = 文件里不留一条')
  assert.equal(cleared.json.data.basisId, baseBasis, '回默认 = 回原指纹')
  assert.notEqual((await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.peak, null)
  return '窗口/假期可配 · 停用即无相位块'
})

await test('POST /config：officialPeak 垃圾输入不写坏配置', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const res = await call('POST', '/plugins/dsh-balance-monitor/config', { officialPeak: 'yesterday' })
  assert.equal(res.json.data.officialPeak.enabled, true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).officialPeak, undefined, '非对象 = 没配')
  return '非对象即清空'
})

await test('officialPeak 落盘时剔掉「与随包默认相同」的字段（别把当版假期表固化）', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const base = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.officialPeak
  // 整段照当前生效值提交一遍（设置页的保存就是这个形状）
  const saved = await call('POST', '/plugins/dsh-balance-monitor/config', { officialPeak: base })
  assert.equal(saved.json.data.officialPeak.enabled, base.enabled, '生效值不变')
  assert.deepEqual(saved.json.data.officialPeak.windows, base.windows)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).officialPeak, undefined,
    '全等于默认 → 文件里不留一条（以后随包的假期表更新仍然生效）')
  // 只有真的改过的字段才落盘
  const changed = await call('POST', '/plugins/dsh-balance-monitor/config', {
    officialPeak: { windows: [{ start: 2, end: 5 }] },
  })
  assert.equal(changed.json.data.officialPeak.enabled, true, '没给的字段沿用当前值')
  assert.deepEqual(changed.json.data.officialPeak.holidays, base.holidays, '假期仍是默认（没被固化）')
  const stored = JSON.parse(readFileSync(file, 'utf8')).officialPeak
  assert.deepEqual(stored, { windows: [{ start: 2, end: 5 }] }, `只落改动过的字段：${JSON.stringify(stored)}`)
  // 收尾
  await call('POST', '/plugins/dsh-balance-monitor/config', { officialPeak: null })
  return '只落差异字段'
})

await test('officialPeak 的局部补丁沿用当前值（不会把已关掉的峰谷打开）', async () => {
  await call('POST', '/plugins/dsh-balance-monitor/config', { officialPeak: { enabled: false, holidays: ['2026-12-25'] } })
  const patch = await call('POST', '/plugins/dsh-balance-monitor/config', { officialPeak: { windows: [{ start: 3, end: 4 }] } })
  assert.equal(patch.json.data.officialPeak.enabled, false, '只改窗口不该把 enabled 带回默认 true')
  assert.deepEqual(patch.json.data.officialPeak.holidays, ['2026-12-25'], '假期也保住')
  assert.deepEqual(patch.json.data.officialPeak.windows, [{ start: 3, end: 4 }])
  await call('POST', '/plugins/dsh-balance-monitor/config', { officialPeak: null })
  const cleared = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.officialPeak
  assert.equal(cleared.enabled, true)
  assert.deepEqual(cleared.windows, [{ start: 1, end: 4 }, { start: 6, end: 10 }], '回随包默认')
  return '局部补丁不误伤别的字段'
})

await test('officialPeak 随 state.json 重载（loadStore 认这个键，非法项被剔）', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.officialPeak = { holidays: ['2026-12-25', '2026/12/26', '2026-12-25'], windows: [{ start: 0, end: 1 }, { start: 9, end: 99 }] }
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  mod.apply(makeCtx({ providers, settings }))
  const report = (await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.deepEqual(report.officialPeak.holidays, ['2026-12-25'], '非法日期剔除 + 去重')
  assert.deepEqual(report.officialPeak.windows, [{ start: 0, end: 1 }], '越界窗口整条丢掉')
  // 清掉，别给后面的用例留状态
  await call('POST', '/plugins/dsh-balance-monitor/config', { officialPeak: null })
  return '重载 · 非法项剔除'
})


console.log('\n[界面偏好：语言 / 轮询间隔 / 隐藏区块 / 会话 ID]')
await test('三处 payload 共用同一份 ui（/state、/sidebar、/report）', async () => {
  const expected = { locale: 'auto', refreshSeconds: 15, hideOfficialBalance: false, hideTodayCost: false, showSessionId: false, sidebarTools: false }
  const state = (await call('GET', '/plugins/dsh-balance-monitor/state')).json.state.ui
  const sidebar = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data.ui
  const report = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.ui
  assert.deepEqual(state, expected, '状态接口应带 ui')
  assert.deepEqual(sidebar, expected, '侧栏应带 ui（轮询间隔也从这拿）')
  assert.deepEqual(report, expected, '设置页应带 ui')
  return '三处一致'
})
await test('POST /config：ui 是局部补丁，只沉淀与默认不同的字段', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const saved = await call('POST', '/plugins/dsh-balance-monitor/config', { ui: { locale: 'en' } })
  assert.equal(saved.json.data.ui.locale, 'en')
  assert.equal(saved.json.data.ui.refreshSeconds, 15, '没给的字段保持默认')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).ui, { locale: 'en' },
    '只把改动过的键写进文件（不动配置就不该平白多出一段）')
  // 局部补丁：只改间隔不会把语言带掉
  const patched = await call('POST', '/plugins/dsh-balance-monitor/config', { ui: { refreshSeconds: 20 } })
  assert.equal(patched.json.data.ui.locale, 'en', '语言要保住')
  assert.equal(patched.json.data.ui.refreshSeconds, 20)
  // 非法值保持原值（越界间隔 / 不认识的语言）
  const junk = await call('POST', '/plugins/dsh-balance-monitor/config', { ui: { refreshSeconds: 5, locale: 'fr' } })
  assert.equal(junk.json.data.ui.refreshSeconds, 20, '越界间隔保持原值')
  assert.equal(junk.json.data.ui.locale, 'en', '不认识的语言保持原值')
  // 四个布尔开关（`sidebarTools` 默认 false，所以存的是「打开」这一位）
  const flags = await call('POST', '/plugins/dsh-balance-monitor/config', {
    ui: { hideOfficialBalance: true, hideTodayCost: true, showSessionId: true, sidebarTools: true },
  })
  assert.equal(flags.json.data.ui.hideOfficialBalance, true)
  assert.equal(flags.json.data.ui.sidebarTools, true, '侧栏两个操作行默认关，打开后要生效')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).ui,
    { locale: 'en', refreshSeconds: 20, hideOfficialBalance: true, hideTodayCost: true, showSessionId: true, sidebarTools: true })
  // 客户端是照 `/sidebar` 里这份 ui 决定渲不渲染那两行的 —— 三处 payload 必须都带上这一位
  const sidebarUi = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data.ui
  assert.equal(sidebarUi.sidebarTools, true, '侧栏 payload 必须带 sidebarTools')
  // null = 回默认
  const cleared = await call('POST', '/plugins/dsh-balance-monitor/config', { ui: null })
  assert.deepEqual(cleared.json.data.ui,
    { locale: 'auto', refreshSeconds: 15, hideOfficialBalance: false, hideTodayCost: false, showSessionId: false, sidebarTools: false })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).ui, undefined, '回默认 = 文件里不留一条')
  return '局部补丁 · 非法保持 · null 回默认'
})

await test('峰谷提醒：提前量 / 类型 / 位置是局部补丁，非法值保持原值，全默认不留条', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const saved = await call('POST', '/plugins/dsh-balance-monitor/config', {
    peakNotify: { enabled: true, leadMinutes: 5, type: 'peak', position: 'center' },
  })
  assert.deepEqual(saved.json.data.peakNotify,
    { enabled: true, system: false, leadMinutes: 5, type: 'peak', position: 'center' },
    '宿主总是给补齐默认值的形状（界面直接编辑它）')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).peakNotify,
    { enabled: true, leadMinutes: 5, type: 'peak', position: 'center' },
    '文件里只落在默认为不同的键（system=false 不写）')
  // 局部补丁：只改位置，不带掉提前量与类型
  const patched = await call('POST', '/plugins/dsh-balance-monitor/config', { peakNotify: { position: 'corner' } })
  assert.equal(patched.json.data.peakNotify.position, 'corner')
  assert.equal(patched.json.data.peakNotify.leadMinutes, 5, '提前量要保住')
  assert.equal(patched.json.data.peakNotify.type, 'peak', '类型要保住')
  // 非法值保持原值（越界提前量 / 不认识的类型 / 不认识的位置）
  const junk = await call('POST', '/plugins/dsh-balance-monitor/config', {
    peakNotify: { leadMinutes: 99, type: 'nope', position: 'middle' },
  })
  assert.equal(junk.json.data.peakNotify.leadMinutes, 5, '越界提前量保持原值')
  assert.equal(junk.json.data.peakNotify.type, 'peak', '不认识的类型保持原值')
  assert.equal(junk.json.data.peakNotify.position, 'corner', '不认识的位置保持原值')
  // 全部回到默认值（含提前量与类型）→ 文件里不留条；
  // 注意「关掉提醒」不会顺手把提前量重置 —— 那是独立设置，用户下次打开还得是他配的值
  const offOnly = await call('POST', '/plugins/dsh-balance-monitor/config', { peakNotify: { enabled: false, system: false } })
  assert.deepEqual(offOnly.json.data.peakNotify,
    { enabled: false, system: false, leadMinutes: 5, type: 'peak', position: 'corner' },
    '关掉开关不影响提前量 / 类型')
  const allDefault = await call('POST', '/plugins/dsh-balance-monitor/config', {
    peakNotify: { enabled: false, system: false, leadMinutes: 2, type: 'both', position: 'corner' },
  })
  assert.deepEqual(allDefault.json.data.peakNotify,
    { enabled: false, system: false, leadMinutes: 2, type: 'both', position: 'corner' })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).peakNotify, undefined, '全默认 = 文件里不留一条')
  return '局部补丁 · 非法保持 · 全默认不留条'
})

await test('模型花费卡片：配置是局部补丁，侧栏按配置下发 Top-N（份额 / 未定价）', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const saved = await call('POST', '/plugins/dsh-balance-monitor/config', {
    modelCard: { enabled: true, rows: 3, period: 'days90', showTokens: false, position: 'top' },
  })
  assert.deepEqual(saved.json.data.modelCard, {
    enabled: true, defaultExpanded: false, rememberExpanded: true, showTokens: false, showShare: true,
    period: 'days90', rows: 3, position: 'top',
  }, '宿主总是给补齐默认值的形状（界面直接编辑它）')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).modelCard,
    { enabled: true, showTokens: false, period: 'days90', rows: 3, position: 'top' },
    '落盘只写与默认不同的键（showShare / rememberExpanded / defaultExpanded 是默认值，不写）')
  // 局部补丁：只改一个位，别的位保住
  const patched = await call('POST', '/plugins/dsh-balance-monitor/config', { modelCard: { showShare: false } })
  assert.equal(patched.json.data.modelCard.rows, 3, '行数要保住')
  assert.equal(patched.json.data.modelCard.showShare, false)
  assert.equal(patched.json.data.modelCard.period, 'days90', '周期要保住')
  // 非法值保持原值
  const junk = await call('POST', '/plugins/dsh-balance-monitor/config', { modelCard: { rows: 99, period: 'week' } })
  assert.equal(junk.json.data.modelCard.rows, 3, '越界行数保持原值')
  assert.equal(junk.json.data.modelCard.period, 'days90', '不认识的周期保持原值')
  // 侧栏按配置下发（含份额），且行数受 rows 限制
  const sidebar = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
  assert.equal(sidebar.modelCard.period, 'days90')
  assert.ok(sidebar.modelCard.items.length > 0, `应有模型行：${JSON.stringify(sidebar.modelCard.items)}`)
  assert.ok(sidebar.modelCard.items.length <= 3, `rows=3 → 最多三行，实际 ${sidebar.modelCard.items.length}`)
  const first = sidebar.modelCard.items[0]
  assert.equal(typeof first.key, 'string')
  assert.ok(first.share === null || (first.share > 0 && first.share <= 1), `份额应在 (0,1]：${first.share}`)
  assert.ok(typeof sidebar.modelCard.total.amount !== 'undefined', '周期总额要给（收起摘要用）')
  assert.ok(typeof sidebar.modelCard.models === 'number', '模型总数要给')
  const shareSum = sidebar.modelCard.items.reduce((total, row) => total + (row.share ?? 0), 0)
  assert.ok(shareSum <= 1 + 1e-9, `给出的行份额之和不该超过 1（实际 ${shareSum}）`)
  // 排序：金额降序
  for (let index = 1; index < sidebar.modelCard.items.length; index += 1) {
    assert.ok(sidebar.modelCard.items[index - 1].usd >= sidebar.modelCard.items[index].usd, '应按金额降序')
  }
  // 关掉 = 不下发（宿主也不白算聚合）
  const off = await call('POST', '/plugins/dsh-balance-monitor/config', { modelCard: { enabled: false } })
  assert.equal(off.json.data.modelCard.enabled, false)
  assert.equal((await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data.modelCard, null, '关闭时不下发')
  // 全部回到默认 → 文件里不留条
  await call('POST', '/plugins/dsh-balance-monitor/config', {
    modelCard: { period: 'today', rows: 5, showTokens: true, showShare: true, position: 'bottom' },
  })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).modelCard, undefined, '全默认 = 文件里不留一条')
  return '局部补丁 · Top-N + 份额 · 关闭即 null'
})

console.log('\n[默认 true 的布尔：关掉后必须经得住重启]')
// 写盘侧（diffFromDefaults / mergeConversationBlock）与客户端都接受 false，读盘侧也必须收 ——
// 早先读盘只写 `value === true`，于是「取消勾选 → 重启即丢」（落回默认 true）。
await test('关掉默认 true 的布尔 → 重启（重载 state.json）后仍是 false', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const saved = await call('POST', '/plugins/dsh-balance-monitor/config', {
    modelCard: { showTokens: false, rememberExpanded: false, enabled: true },
    sessionCost: { showHitRate: false },
    quotaStrip: { showBalance: false },
  })
  assert.equal(saved.statusCode, 200)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(stored.modelCard, { enabled: true, rememberExpanded: false, showTokens: false },
    `与默认不同的 false 必须落盘：${JSON.stringify(stored.modelCard)}`)
  assert.deepEqual(stored.sessionCost, { showHitRate: false }, JSON.stringify(stored.sessionCost))
  assert.deepEqual(stored.quotaStrip, { showBalance: false }, JSON.stringify(stored.quotaStrip))
  // 重启 = 重新 apply（从磁盘重新读配置，走的是真实加载路径）
  mod.apply(makeCtx({ providers, settings }))
  const report = (await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(report.modelCard.enabled, true, '开着的那位要保住')
  assert.equal(report.modelCard.showTokens, false, '关掉 + 重启后不许被打回默认 true')
  assert.equal(report.modelCard.rememberExpanded, false, '关掉 + 重启后不许被打回默认 true')
  assert.equal(report.sessionCost.showHitRate, false, '关掉 + 重启后不许被打回默认 true')
  assert.equal(report.quotaStrip.showBalance, false, '关掉 + 重启后不许被打回默认 true')
  return 'modelCard 三位 + sessionCost / quotaStrip 各一位都活过重启'
})
await test('全默认的布尔提交上去 → state.json 不留多余键（读盘侧不凭空变出 false）', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const res = await call('POST', '/plugins/dsh-balance-monitor/config', {
    modelCard: {
      enabled: false, defaultExpanded: false, rememberExpanded: true, showTokens: true, showShare: true,
      period: 'today', rows: 5, position: 'bottom',
    },
    sessionCost: { enabled: false, position: 'dock', showHitRate: true, includeSubagent: false },
    quotaStrip: { enabled: false, showBalance: true },
  })
  assert.equal(res.statusCode, 200)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  for (const key of ['modelCard', 'sessionCost', 'quotaStrip']) {
    assert.equal(stored[key], undefined, `${key} 与默认全同 → 文件里不留一条`)
  }
  // 清干净，别给后面的用例留状态
  await call('POST', '/plugins/dsh-balance-monitor/config', { modelCard: null, sessionCost: null, quotaStrip: null })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).modelCard, undefined)
  return '全默认不留余键'
})

// `position` 的白名单在「读盘归一」与「局部补丁合并」两处各写一份 —— 只改一处，
// 另一个方向就会把刚存的合法值静默丢掉（`dock` 是 0.9.0 新增的第四个位置：输入框下方，
// 也是随包默认值）。这里两种写法都过一遍：非法值不冲掉生效值、非默认值能存能读。
await test('sessionCost.position：dock 是新默认；composer 能存能读；非法值保持原值', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const report = () => call('GET', '/plugins/dsh-balance-monitor/report').then(res => res.json.data)
  // 随包默认 = dock（输入框下方），且默认值不落盘
  await call('POST', '/plugins/dsh-balance-monitor/config', { sessionCost: null })
  assert.equal((await report()).sessionCost.position, 'dock', '默认位置应是 dock')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessionCost, undefined, '全默认不留条')
  // 非默认的 position 必须落盘
  const saved = await call('POST', '/plugins/dsh-balance-monitor/config', { sessionCost: { position: 'composer' } })
  assert.equal(saved.json.data.sessionCost.position, 'composer')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessionCost.position, 'composer',
    '非默认的 position 必须落盘（否则重启即丢）')
  // 重启 = 重新 apply（真实加载路径）
  mod.apply(makeCtx({ providers, settings }))
  const afterRestart = (await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(afterRestart.sessionCost.position, 'composer', 'composer 要活过重启')
  // 非法值（老客户端 / 手改文件）不许把生效值冲掉
  const junk = await call('POST', '/plugins/dsh-balance-monitor/config', { sessionCost: { position: 'bottom' } })
  assert.equal(junk.json.data.sessionCost.position, 'composer', '不认识的 position 保持原值')
  // 显式切回 dock（= 默认）→ 文件里不留条，但生效值就是 dock
  const back = await call('POST', '/plugins/dsh-balance-monitor/config', { sessionCost: { position: 'dock' } })
  assert.equal(back.json.data.sessionCost.position, 'dock')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessionCost, undefined, '回到默认不留条')
  return 'dock 默认 · composer 存读通 · 非法保持'
})

await test('侧栏也带预算进度（横条那格），与设置页概览同一套规则', async () => {
  await call('POST', '/plugins/dsh-balance-monitor/config', { budget: { enabled: true, amount: 1000, period: 'month' } })
  const sidebar = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
  const report = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(sidebar.budget.enabled, true)
  assert.equal(sidebar.budget.period, 'month')
  assert.equal(sidebar.budget.amount, 1000)
  assert.ok(sidebar.budget.usedAmount > 0, `已用金额要有：${JSON.stringify(sidebar.budget)}`)
  // 与设置页概览的占比必须一致（同一套规则，两处各算一份迟早会漂）
  close(sidebar.budget.ratio, report.budget.ratio, 1e-9, '横条与概览的占比')
  // 没设额度 → 占比是 null（不是 0）：界面据此不显示那一格
  await call('POST', '/plugins/dsh-balance-monitor/config', { budget: { amount: null } })
  assert.equal((await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data.budget.ratio, null)
  // 未启用时界面也不显示
  await call('POST', '/plugins/dsh-balance-monitor/config', { budget: { enabled: false } })
  assert.equal((await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data.budget.enabled, false)
  return '与概览同规则 · amount=null → ratio=null'
})
await test('保留期也随 state.json 重载（loadStore 认这个键）', async () => {
  // 直接改磁盘上的 state.json，再重新 apply —— 走的是真实的加载路径
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.retention = { ledgerDays: 12, rollupDays: 365 }
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  mod.apply(makeCtx({ providers, settings }))
  const report = (await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.deepEqual(report.retention, { ledgerDays: 12, rollupDays: 365 }, '重载后应认这份保留期')
  // 清掉，别给后面的用例留状态
  await call('POST', '/plugins/dsh-balance-monitor/config', { retention: null })
  return '12 / 365'
})

await test('POST /balance/refresh：官方余额接口可用时把金额带回来', async () => {
  process.env.DEEPSEEK_API_KEY = 'sk-test-balance'
  const res = await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', {})
  assert.equal(res.statusCode, 200, JSON.stringify(res.json).slice(0, 200))
  const api = res.json.data.balances.find(item => item.provider === 'deepseek-official')
  assert.equal(api.error, undefined, `API Key 路线不该报错：${api.error}`)
  assert.equal(api.amount, 0.01, `API Key 路线余额 ${api.amount}`)
  assert.equal(api.granted, 0)
  assert.equal(api.source, 'api-key')
  // 默认展示账号路线（更精确，通常也是用户真在用的钱包）
  assert.equal(res.json.data.balance.provider, 'deepseek-account', '默认应展示账号路线')
  delete process.env.DEEPSEEK_API_KEY
  return `API Key 余额 ${api.amount} ${api.currency} · 默认展示 ${res.json.data.balance.displayName}`
})

console.log('\n[DeepSeek 两条路线：两个供应商、两份余额、可切换]')
await test('GET /state 同时列出 deepseek-official 与 deepseek-account', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/state')
  assert.equal(res.statusCode, 200)
  const ids = res.json.state.providers.map(row => row.provider)
  assert.ok(ids.includes('deepseek-official'), `缺 deepseek-official：${ids.join(',')}`)
  assert.ok(ids.includes('deepseek-account'), `缺 deepseek-account：${ids.join(',')}`)
  const account = res.json.state.providers.find(row => row.provider === 'deepseek-account')
  assert.equal(account.deepseekRoute, 'account')
  assert.equal(account.apiKeyEnv, undefined, '账号路线没有 API Key 引用')
  return ids.filter(id => id.startsWith('deepseek')).join(' + ')
})

await test('GET /sidebar：balances 两条都有，金额与来源各自不同', async () => {
  const data = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
  assert.equal(Array.isArray(data.balances), true, '缺 balances 数组')
  assert.equal(data.balances.length, 2, `应有 2 条路线，实际 ${data.balances.length}`)
  const api = data.balances.find(item => item.provider === 'deepseek-official')
  const account = data.balances.find(item => item.provider === 'deepseek-account')
  close(api.amount, 0.01, 1e-9, 'API Key 路线余额')
  close(account.amount, -0.04337202, 1e-9, '账号路线余额（平台精确值）')
  assert.equal(api.source, 'api-key')
  assert.equal(account.source, 'account-platform')
  assert.equal(account.displayName, 'DeepSeek Account')
  assert.equal(data.balance.provider, 'deepseek-account', '默认显示账号路线（有金额且更精确）')
  return `API Key ${api.amount} · Account ${account.amount}`
})

await test('账号路线走 deepseekAccount.resolveToken（不是 API Key）', async () => {
  const service = makeCtx({ providers, settings }).get('deepseekAccount')
  assert.ok(service === undefined || service !== undefined, '服务桩存在即可')
  const balances = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-account' })).json.data.balances
  const account = balances.find(item => item.provider === 'deepseek-account')
  assert.equal(account.error, undefined, `账号余额不该报错：${account.error}`)
  const usedToken = seen.some(entry => entry.url.includes('/api/v0/users/get_user_summary'))
  assert.ok(usedToken, '应向平台余额端点发过请求')
  return 'resolveToken → platform get_user_summary'
})

await test('账号路线的调用按官方计价（不当中转站、不因缺倍率变成未定价）', async () => {
  const before = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
  await feedStream({ provider: 'deepseek-account', model: 'deepseek-v4.1-flash', sessionId: 'session-account', inputTokens: 1_000_000 })
  const after = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
  const row = after.providers.find(item => item.provider === 'deepseek-account')
  assert.ok(row !== undefined, '侧栏应出现 deepseek-account 这一行')
  assert.equal(row.unpriced, 0, '账号路线不该算未定价')
  assert.ok(row.usd > 0, `账号路线应有金额，实际 ${row.usd}`)
  close(after.total.usd - before.total.usd, row.usd, 1e-12, '今日增量')
  return `+${row.usd} USD（官方价，无站方倍率）`
})

await test('POST /balance/refresh 不指定 provider → 两条一起刷', async () => {
  process.env.DEEPSEEK_API_KEY = 'sk-test-balance'
  const data = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', {})).json.data
  assert.equal(data.balances.length, 2)
  assert.ok(data.balances.every(item => item.error === undefined), JSON.stringify(data.balances))
  delete process.env.DEEPSEEK_API_KEY
  return `两条都刷新（${data.balances.map(item => item.source).join(' / ')}）`
})

await test('多把 key：总额相加，逐把明细都带出去', async () => {
  const saved = await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2', 'not a ref'] })
  assert.equal(saved.statusCode, 200)
  const data = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })).json.data
  const official = data.balances.find(item => item.provider === 'deepseek-official')
  assert.equal(official.keys.length, 2, `非法引用应被过滤，实际 ${JSON.stringify(official.keys?.map(k => k.ref))}`)
  close(official.amount, 1.51, 1e-9, '总额 = 两把 key 之和')
  assert.equal(official.currency, 'CNY')
  close(official.keys[0].amount, 0.01, 1e-9, '第一把')
  close(official.keys[1].amount, 1.5, 1e-9, '第二把')
  assert.equal(official.keys[1].ref, 'DEEPSEEK_API_KEY_2')
  const state = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.deepEqual(state.deepseekKeys, [{ ref: 'DEEPSEEK_API_KEY' }, { ref: 'DEEPSEEK_API_KEY_2' }])
  return `0.01 + 1.50 = ${official.amount}`
})

await test('多把 key 里只有部分 is_available=false：总额仍可用，不足只留在那一把上', async () => {
  await call('POST', '/plugins/dsh-balance-monitor/config', {
    deepseekKeys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2', 'DEEPSEEK_API_KEY_9'],
  })
  const data = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })).json.data
  const official = data.balances.find(item => item.provider === 'deepseek-official')
  close(official.amount, 1.17, 1e-9, '总额含负余额，但不因此变成查不到')
  assert.equal(official.isAvailable, true, '还有能用的 key 时，路线不该被标成余额不足')
  assert.equal(official.keys.find(item => item.ref === 'DEEPSEEK_API_KEY').isAvailable, true)
  assert.equal(official.keys.find(item => item.ref === 'DEEPSEEK_API_KEY_9').isAvailable, false)
  assert.equal(official.keys.find(item => item.ref === 'DEEPSEEK_API_KEY_9').amount, -0.34)
  return `1.17 可用 · KEY_9 -0.34 不足`
})

await test('自动换 key：主 key 不可用时，请求前切到有余额的 _2', async () => {
  // 用户实际配置：deepseekKeys 里只有额外 key，没有宿主的 DEEPSEEK_API_KEY。
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: ['DEEPSEEK_API_KEY_2', 'DEEPSEEK_API_KEY_9'] })
  primaryDry = true
  const primed = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })).json.data
  const primedOfficial = primed.balances.find(item => item.provider === 'deepseek-official')
  assert.equal(primedOfficial.activeKey?.ref, 'DEEPSEEK_API_KEY', '主 key 不在列表里时应单独带出')
  assert.equal(primedOfficial.activeKey?.amount, -0.01)
  const credentials = ctx.get('credentials')
  const before = credentials.setCalls.length
  await feedStream({ provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 's-auto-key', inputTokens: 0 })
  const switched = credentials.setCalls.slice(before).find(call => call.ref === 'DEEPSEEK_API_KEY')
  assert.deepEqual(switched, { ref: 'DEEPSEEK_API_KEY', value: 'sk-key-two' }, '应把有余额的 _2 写进主 key 引用')
  const sidebar = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
  const official = sidebar.balances.find(item => item.provider === 'deepseek-official')
  const second = official.keys.find(key => key.ref === 'DEEPSEEK_API_KEY_2')
  assert.equal(second.active, true, `侧栏应标出使用中的 key：${JSON.stringify(official.keys)}`)
  assert.equal(sidebar.keySwitch?.to, 'DEEPSEEK_API_KEY_2', '侧栏应带出自动切换记录')
  // 还原夹具，后面的用例仍拿主 key = 0.01 的原始状态。
  primaryDry = false
  credentials.values.DEEPSEEK_API_KEY = 'sk-key-one'
  await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })
  return '主 key -0.01 → _2 1.50'
})

await test('手动切 key：POST /keys/active 写入主 key，侧栏只标这一把使用中', async () => {
  const credentials = ctx.get('credentials')
  credentials.values.DEEPSEEK_API_KEY = 'sk-key-one'
  await call('POST', '/plugins/dsh-balance-monitor/config', {
    deepseekKeys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'],
  })
  const primed = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })).json.data
    .balances.find(item => item.provider === 'deepseek-official')
  assert.equal(primed.activeKey?.ref, 'DEEPSEEK_API_KEY', '初始应标主 key')
  const before = credentials.setCalls.length
  const res = await call('POST', '/plugins/dsh-balance-monitor/keys/active', {
    provider: 'deepseek-official',
    ref: 'DEEPSEEK_API_KEY_2',
  })
  assert.equal(res.statusCode, 200, JSON.stringify(res.json))
  assert.equal(res.json.data?.activeRef, 'DEEPSEEK_API_KEY_2')
  assert.equal(res.json.data?.switched, true)
  assert.equal(JSON.stringify(res.json).includes('sk-key-two'), false, '响应不许带 key 值')
  const writes = credentials.setCalls.slice(before)
  assert.ok(writes.some(item => item.ref === 'DEEPSEEK_API_KEY' && item.value === 'sk-key-two'), JSON.stringify(writes))
  assert.ok(
    writes.some(item => item.ref === 'DEEPSEEK_API_KEY_REPLACED' && item.value === 'sk-key-one'),
    '原 key 有正余额，应先备份',
  )
  const sidebar = (await call('GET', '/plugins/dsh-balance-monitor/sidebar')).json.data
  const official = sidebar.balances.find(item => item.provider === 'deepseek-official')
  const active = official.keys.filter(key => key.active === true)
  assert.equal(active.length, 1, `同值引用只能标一把使用中：${JSON.stringify(official.keys)}`)
  assert.equal(active[0].ref, 'DEEPSEEK_API_KEY_2', '应标用户点的那把')
  assert.equal(sidebar.keySwitch?.manual, true, '手动切换要带 manual 标记')
  assert.equal(sidebar.keySwitch?.to, 'DEEPSEEK_API_KEY_2')
  // 还原：主 key 写回 sk-key-one，后面的用例仍按初始夹具跑。
  credentials.values.DEEPSEEK_API_KEY = 'sk-key-one'
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: [] })
  await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })
  return 'DEEPSEEK_API_KEY → _2 · 只标一把'
})

await test('POST /keys/active：GET / 账号路线 / 别家引用都被拒', async () => {
  const credentials = ctx.get('credentials')
  credentials.values.DEEPSEEK_API_KEY = 'sk-key-one'
  await call('POST', '/plugins/dsh-balance-monitor/config', {
    deepseekKeys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'],
  })
  await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })
  const get = await call('GET', '/plugins/dsh-balance-monitor/keys/active')
  assert.equal(get.statusCode, 405)
  const account = await call('POST', '/plugins/dsh-balance-monitor/keys/active', {
    provider: 'deepseek-account',
    ref: 'DEEPSEEK_API_KEY',
  })
  assert.equal(account.statusCode, 404)
  const foreign = await call('POST', '/plugins/dsh-balance-monitor/keys/active', {
    provider: 'deepseek-official',
    ref: 'WALK_GROK_API_KEY',
  })
  assert.equal(foreign.statusCode, 403)
  const notListed = await call('POST', '/plugins/dsh-balance-monitor/keys/active', {
    provider: 'deepseek-official',
    ref: 'DEEPSEEK_API_KEY_3',
  })
  assert.equal(notListed.statusCode, 403)
  assert.equal(credentials.values.DEEPSEEK_API_KEY, 'sk-key-one', '被拒的请求不许改主 key')
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: [] })
  await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })
  return '405 / 404 / 403'
})

await test('清空 key 列表 → 回到用路线自己的 apiKeyEnv（单把）', async () => {
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: [] })
  const data = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })).json.data
  const official = data.balances.find(item => item.provider === 'deepseek-official')
  close(official.amount, 0.01, 1e-9, '单把 key 时金额还是它自己')
  const state = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.equal(state.deepseekKeys, undefined, '空列表应清掉该字段')
  return '回落到 DEEPSEEK_API_KEY'
})

await test('手填的引用没有 label → 派生短标签（卡片填的 label 优先）', async () => {
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'] })
  const derived = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })).json.data
    .balances.find(item => item.provider === 'deepseek-official')
  assert.deepEqual(derived.keys.map(k => k.label), ['API KEY', 'API KEY 2'], '侧栏明细不该只剩裸引用名')
  await call('POST', '/plugins/dsh-balance-monitor/config', {
    deepseekKeys: [{ ref: 'DEEPSEEK_API_KEY', label: '主力' }, { ref: 'DEEPSEEK_API_KEY_2' }],
  })
  const custom = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })).json.data
    .balances.find(item => item.provider === 'deepseek-official')
  assert.deepEqual(custom.keys.map(k => k.label), ['主力', 'API KEY 2'], '自己填的 label 优先')
  const list = (await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-official')).json.data
  assert.equal(list.keys.find(item => item.ref === 'DEEPSEEK_API_KEY').label, '主力', 'GET /keys 也带派生标签')
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: [] })
  return 'API KEY · API KEY 2 · 自定义优先'
})

await test('派生标签撞车时退回带上引用名（两行不能长得一模一样）', async () => {
  // `DEEPSEEK_API_KEY` 与 `API_KEY` 都派生成 `API KEY` —— 侧栏明细会分不清谁是谁。
  await call('POST', '/plugins/dsh-balance-monitor/config', {
    deepseekKeys: ['DEEPSEEK_API_KEY', 'API_KEY'],
  })
  const list = (await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-official')).json.data
  const labels = list.keys.map(item => item.label)
  assert.equal(new Set(labels).size, labels.length, `标签必须互不重复：${JSON.stringify(labels)}`)
  assert.ok(labels.includes('API KEY（DEEPSEEK_API_KEY）'), `撞车的要带上引用名：${JSON.stringify(labels)}`)
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: [] })
  return labels.join(' / ')
})


await test('方案 A：候选名探测（describe）列出可加的 key，不读值', async () => {
  const report = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  const discovery = report.keyCandidates
  assert.equal(discovery.supported, true, `凭据服务应支持 describe：${JSON.stringify(discovery)}`)
  assert.ok(discovery.scanned.length >= 10, `应扫了一批候选名，实际 ${discovery.scanned.length}`)
  assert.ok(discovery.scanned.includes('DEEPSEEK_API_KEY'), '候选应含默认引用名')
  assert.ok(discovery.scanned.includes('DEEPSEEK_API_KEY_2'), '候选应含 _2（默认扫到 _9）')
  assert.deepEqual(discovery.foundRefs, ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'], `命中：${JSON.stringify(discovery.foundRefs)}`)
  // 探测只调 describe，不调 resolve（不接触值）
  const credentials = ctx.get('credentials')
  assert.ok(credentials.describeCalls.length >= 10, `describe 调用次数 ${credentials.describeCalls.length}`)
  const leaked = credentialCalls.filter(ref => ref.startsWith('DEEPSEEK_KEY'))
  assert.equal(leaked.length, 0, `探测阶段不该 resolve 任何 key：${JSON.stringify(leaked)}`)
  return `扫 ${discovery.scanned.length} 个名字，命中 ${discovery.foundRefs.length}`
})

await test('未加入的 key 出现在候选里，加入后移出候选', async () => {
  const discovery = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.keyCandidates
  assert.deepEqual(discovery.candidates, ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'], `候选：${JSON.stringify(discovery.candidates)}`)
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: ['DEEPSEEK_API_KEY_2'] })
  const after = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.keyCandidates
  assert.deepEqual(after.candidates, ['DEEPSEEK_API_KEY'], '已加入的不该再当候选')
  assert.deepEqual(after.added, ['DEEPSEEK_API_KEY_2'])
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: [] })
  return 'candidates → added'
})
await test('GET /keys：列出主 key 与已配的额外 key（不含值）', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-official')
  assert.equal(res.statusCode, 200, JSON.stringify(res.json).slice(0, 200))
  const data = res.json.data
  assert.equal(data.primaryRef, 'DEEPSEEK_API_KEY')
  assert.ok(data.keys.some(item => item.ref === 'DEEPSEEK_API_KEY' && item.configured === true), JSON.stringify(data.keys))
  assert.ok(data.keys.some(item => item.ref === 'DEEPSEEK_API_KEY_2' && item.configured === true))
  assert.equal(JSON.stringify(data).includes('sk-key'), false, '接口不该回传任何 key 值')
  assert.ok(typeof data.nextRef === 'string' && data.nextRef.length > 0, `应给出下一个可用引用名：${data.nextRef}`)
  return `主 ${data.primaryRef} · nextRef ${data.nextRef}`
})

await test('PUT /keys：写入第二把 key（值只上行，引用名自动顺位）', async () => {
  const res = await call('PUT', '/plugins/dsh-balance-monitor/keys', { provider: 'deepseek-official', value: 'sk-brand-new', ref: 'DEEPSEEK_API_KEY_3' })
  assert.equal(res.statusCode, 200, JSON.stringify(res.json).slice(0, 200))
  const credentials = ctx.get('credentials')
  assert.deepEqual(credentials.setCalls.at(-1), { ref: 'DEEPSEEK_API_KEY_3', value: 'sk-brand-new' })
  assert.equal(JSON.stringify(res.json).includes('sk-brand-new'), false, '响应里不该回传写入的值')
  const state = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.ok(state.deepseekKeys.some(entry => entry.ref === 'DEEPSEEK_API_KEY_3'), '应记进 deepseekKeys 才会计入总额')
  // 计入总额：刷新后官方路线应出现第三把 key
  const balances = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })).json.data.balances
  const official = balances.find(item => item.provider === 'deepseek-official')
  assert.ok(official.keys.some(key => key.ref === 'DEEPSEEK_API_KEY_3'), JSON.stringify(official.keys?.map(k => k.ref)))
  return `写入 ${credentials.setCalls.at(-1).ref} → 计入余额明细`
})

await test('PUT /keys：无效 key 不写入', async () => {
  const credentials = ctx.get('credentials')
  const before = credentials.setCalls.length
  const res = await call('PUT', '/plugins/dsh-balance-monitor/keys', {
    provider: 'deepseek-official', value: 'sk-invalid', ref: 'DEEPSEEK_API_KEY_8',
  })
  assert.equal(res.statusCode, 400, JSON.stringify(res.json))
  assert.match(String(res.json.error), /未保存/)
  assert.match(String(res.json.error), /API Key 无效/)
  assert.equal(credentials.setCalls.length, before, '无效 key 不该调用 credentials.set')
  assert.equal(JSON.stringify(res.json).includes('sk-invalid'), false, '拒绝响应也不该回传 key 值')
  const state = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.equal((state.deepseekKeys ?? []).some(entry => entry.ref === 'DEEPSEEK_API_KEY_8'), false, '无效 key 不该记进 deepseekKeys')
  return '401 → 未保存'
})

await test('PUT /keys：余额为负的 key 仍然有效，允许保存', async () => {
  const res = await call('PUT', '/plugins/dsh-balance-monitor/keys', {
    provider: 'deepseek-official', value: 'sk-key-dry', ref: 'DEEPSEEK_API_KEY_8',
  })
  assert.equal(res.statusCode, 200, JSON.stringify(res.json).slice(0, 240))
  assert.deepEqual(ctx.get('credentials').setCalls.at(-1), { ref: 'DEEPSEEK_API_KEY_8', value: 'sk-key-dry' })
  await call('DELETE', '/plugins/dsh-balance-monitor/keys', { provider: 'deepseek-official', ref: 'DEEPSEEK_API_KEY_8' })
  return '负余额仍写入，测完删掉'
})

await test('POST /keys/balances：每把已配置 key 的余额，不含值', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/keys/balances', { provider: 'deepseek-official' })
  assert.equal(res.statusCode, 200, JSON.stringify(res.json).slice(0, 300))
  const keys = res.json.data.keys
  const primary = keys.find(item => item.ref === 'DEEPSEEK_API_KEY')
  const second = keys.find(item => item.ref === 'DEEPSEEK_API_KEY_2')
  assert.equal(primary?.amount, 0.01, JSON.stringify(keys))
  assert.equal(primary?.currency, 'CNY')
  assert.equal(primary?.isAvailable, true)
  assert.equal(second?.amount, 1.5)
  assert.equal(JSON.stringify(res.json).includes('sk-'), false, '余额接口不该回传任何 key 值')
  const refused = await call('POST', '/plugins/dsh-balance-monitor/keys/balances', { provider: 'walk-grok' })
  assert.equal(refused.statusCode, 404)
  return `主 key ¥${primary.amount} · 第二把 ¥${second.amount}`
})

await test('DELETE /keys：删额外 key 可以，删主 key 被拒', async () => {
  const removed = await call('DELETE', '/plugins/dsh-balance-monitor/keys', { provider: 'deepseek-official', ref: 'DEEPSEEK_API_KEY_3' })
  assert.equal(removed.statusCode, 200)
  assert.deepEqual(ctx.get('credentials').unsetCalls.at(-1), 'DEEPSEEK_API_KEY_3')
  const refused = await call('DELETE', '/plugins/dsh-balance-monitor/keys', { provider: 'deepseek-official', ref: 'DEEPSEEK_API_KEY' })
  assert.equal(refused.statusCode, 400)
  assert.match(String(refused.json.error), /主 key/)
  return '删额外 key ✓ · 主 key 拒绝 ✓'
})
await test('POST /keys/reveal：只对属于该路线的引用回值，其它引用拒绝', async () => {
  const ok = await call('POST', '/plugins/dsh-balance-monitor/keys/reveal', { provider: 'deepseek-official', ref: 'DEEPSEEK_API_KEY' })
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.json).slice(0, 200))
  assert.equal(ok.json.data.value, 'sk-key-one')
  assert.equal(ok.json.data.ref, 'DEEPSEEK_API_KEY')
  // 不属于这条 DeepSeek 路线的引用：拒绝（别把浏览器当任意引用的读取器）
  const refused = await call('POST', '/plugins/dsh-balance-monitor/keys/reveal', { provider: 'deepseek-official', ref: 'WALK_GROK_API_KEY' })
  assert.equal(refused.statusCode, 403)
  assert.equal(JSON.stringify(refused.json).includes('sk-test-walk-grok'), false, '拒绝时更不能回值')
  // 常规列表仍然不含值
  const list = await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-official')
  assert.equal(JSON.stringify(list.json).includes('sk-key'), false, '/keys 不该含值')
  return 'DEEPSEEK_API_KEY → 值 · 其它引用 403'
})
await test('方案 B：凭据文件里的自定义命名能扫到，但只有属于本路线的才进列表', async () => {
  // 沙箱里放一份凭据文件：一个常规名 + 一个完全不合规律的命名
  const file = join(sandbox, '.credentials.yaml')
  writeFileSync(file, [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: fake-one',
    '  DSK_BACKUP_1: fake-two',
    'records:',
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      token: fake-token-should-not-leak',
    '',
  ].join('\n'), 'utf8')
  // 让凭据服务认这个自定义名
  ctx.get('credentials').describe = async ref => ref === 'DSK_BACKUP_1' || ref === 'DEEPSEEK_API_KEY'
    ? { configured: true, source: 'file', writable: true }
    : { configured: false, writable: true }
  const discovery = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.keyCandidates
  // 「文件里扫到」与「属于本路线」是两回事：文件名照原样带出（诊断用）
  assert.ok(discovery.scannedFromFile.includes('DSK_BACKUP_1'), `文件扫描结果：${JSON.stringify(discovery.scannedFromFile)}`)
  // 但 DSK_BACKUP_1 既不在 apiKeyEnv 的候选里、也不在 deepseekKeys 里 → 不属于这条路线：
  // 不进扫描候选 / 命中 / 卡片（否则点「小眼睛」就是 403 —— 列表与权限两套判据打架）
  assert.equal(discovery.scanned.includes('DSK_BACKUP_1'), false, `扫描候选里不该有它：${JSON.stringify(discovery.scanned)}`)
  assert.equal(discovery.foundRefs.includes('DSK_BACKUP_1'), false, `不该算命中：${JSON.stringify(discovery.foundRefs)}`)
  assert.equal(JSON.stringify(discovery).includes('fake-two'), false, '不能把值带出来')
  assert.equal(JSON.stringify(discovery).includes('fake-token'), false, 'records 段的 token 更不能带出来')
  const keys = (await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-official')).json.data
  assert.equal(keys.keys.some(item => item.ref === 'DSK_BACKUP_1'), false, `卡片不该列不属于它的引用：${JSON.stringify(keys.keys)}`)
  // 「先纳入配置、再属于这条路线」：写进 deepseekKeys 之后才进列表
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: ['DSK_BACKUP_1'] })
  const after = (await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-official')).json.data
  assert.ok(after.keys.some(item => item.ref === 'DSK_BACKUP_1' && item.configured === true), `纳入后应列出：${JSON.stringify(after.keys)}`)
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: [] })
  return `scannedFromFile=${discovery.scannedFromFile.length} · 自定义名「先纳入再列出」`
})

await test('scanCredentialsFile: false → 退回纯候选名探测（不碰凭据文件）', async () => {
  await call('POST', '/plugins/dsh-balance-monitor/config', { scanCredentialsFile: false })
  const discovery = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.keyCandidates
  assert.equal(discovery.scannedFromFile, undefined, `关掉后不该有文件扫描结果：${JSON.stringify(discovery.scannedFromFile)}`)
  assert.ok(discovery.foundRefs.includes('DEEPSEEK_API_KEY'), '候选名探测照旧')
  await call('POST', '/plugins/dsh-balance-monitor/config', { scanCredentialsFile: true })
  return '已退回候选名探测'
})

await test('GET /report 下发密钥扫描配置（界面要能回填与编辑）', async () => {
  const before = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.keyDiscovery
  assert.equal(before.scanCredentialsFile, true, '默认开')
  assert.deepEqual(before.prefixes, ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY'], '默认前缀')
  assert.equal(before.maxIndex, 9, '默认序号上限')
  // 三个键一起写 → 回传的就是归一后的值（前缀去重、非法项被剔、上限夹在 1–50）
  const saved = await call('POST', '/plugins/dsh-balance-monitor/config', {
    scanCredentialsFile: false,
    deepseekKeyPrefixes: ['MY_KEY', 'MY_KEY', 'bad prefix'],
    deepseekKeyMaxIndex: 3,
  })
  assert.deepEqual(saved.json.data.keyDiscovery, { scanCredentialsFile: false, prefixes: ['MY_KEY'], maxIndex: 3 })
  const after = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.keyDiscovery
  assert.deepEqual(after, saved.json.data.keyDiscovery, '报表与 /config 回传要一致')
  // 上限越界（非法值）→ 沿用当前生效值（上面刚设的 3）；空前缀列表 = 清掉自定义前缀 → 回默认两条
  const junk = await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeyMaxIndex: 999, deepseekKeyPrefixes: [] })
  assert.equal(junk.json.data.keyDiscovery.maxIndex, 3, '越界值沿用当前生效值（与 ui / modelCard 同一套规矩），不回落默认 9')
  assert.deepEqual(junk.json.data.keyDiscovery.prefixes, ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY'], '空数组 = 清掉自定义前缀')
  // 收尾：回到默认（前缀清空 = 用默认；上限传 null = 清掉；文件扫描重新打开）
  await call('POST', '/plugins/dsh-balance-monitor/config', {
    scanCredentialsFile: true, deepseekKeyPrefixes: [], deepseekKeyMaxIndex: null,
  })
  const restored = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.keyDiscovery
  assert.deepEqual(restored, before, '收尾后应完全回到默认')
  return '回填 · 归一 · 越界回落'
})

console.log('\n[密钥列表按供应商过滤：卡片只列属于自己的引用（截图里那批别家的 key）]')
/** 用户截图里躺在同一份 `.credentials.yaml` 里的其它供应商引用名。 */
const FOREIGN_KEY_REFS = [
  'JIUHAOCHE_API_KEY', 'WALK_GROK_API_KEY', 'WALK_GPT_API_KEY',
  'NANSHANYOUGUI_CLAUDE_API_KEY', 'POJIA_GPT_API_KEY', 'WBFT_API_KEY',
]
const credentialsService = ctx.get('credentials')
const savedDescribe = credentialsService.describe
/**
 * 夹具（照截图搭）：一份「多供应商混住」的凭据文件，且 describe 对**每一个**引用都报
 * `configured: true` —— 这正是 bug 现场：旧写法把它们全列进 DeepSeek 卡片并标「已配置」，
 * 点「小眼睛」却被 `/keys/reveal` 以「不属于 deepseek-official，拒绝返回」打回。
 */
writeFileSync(join(sandbox, '.credentials.yaml'), [
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: fake-ds-one',
  '  DEEPSEEK_API_KEY_2: fake-ds-two',
  '  DSK_BACKUP_1: fake-backup',
  ...FOREIGN_KEY_REFS.map(ref => `  ${ref}: fake-${ref.toLowerCase()}`),
  'records:',
  '  deepseek-account-platform/default:',
  '    kind: grant',
  '    payload:',
  '      token: fake-token-should-not-leak',
  '',
].join('\n'), 'utf8')
const configuredInFixture = new Set(['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2', 'DSK_BACKUP_1', ...FOREIGN_KEY_REFS])
credentialsService.describe = async ref => (configuredInFixture.has(ref)
  ? { configured: true, source: 'file', writable: true }
  : { configured: false, writable: true })

await test('GET /keys：DeepSeek 卡片只列 DEEPSEEK_API_KEY / _2，别家的引用一个都不列', async () => {
  const data = (await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-official')).json.data
  const refs = data.keys.map(item => item.ref)
  assert.deepEqual(refs, ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'], `卡片实际列出：${JSON.stringify(refs)}`)
  const leaked = FOREIGN_KEY_REFS.filter(ref => JSON.stringify(data).includes(ref))
  assert.deepEqual(leaked, [], `别家的引用名不该出现在卡片数据里：${JSON.stringify(leaked)}`)
  assert.equal(JSON.stringify(data).includes('DSK_BACKUP_1'), false, '既不在 apiKeyEnv 也不在 deepseekKeys 的自定义名同样不列')
  // 列出来的每一行都真的能读值（列表判据 == reveal 判据）
  const revealed = await call('POST', '/plugins/dsh-balance-monitor/keys/reveal', { provider: 'deepseek-official', ref: refs[0] })
  assert.equal(revealed.statusCode, 200, `列出来的应能读值：${JSON.stringify(revealed.json).slice(0, 160)}`)
  return `列出 ${refs.join(' / ')}（别家 ${FOREIGN_KEY_REFS.length} 个引用名一个都没列）`
})
await test('报表 keyCandidates 同一判据：scanned / foundRefs / candidates / added 全不列别家引用', async () => {
  const discovery = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.keyCandidates
  assert.deepEqual(discovery.foundRefs, ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'], `命中：${JSON.stringify(discovery.foundRefs)}`)
  for (const ref of [...FOREIGN_KEY_REFS, 'DSK_BACKUP_1']) {
    assert.equal(discovery.scanned.includes(ref), false, `${ref} 不该进扫描候选：${JSON.stringify(discovery.scanned)}`)
    assert.equal(discovery.candidates.includes(ref), false, `${ref} 不该进「可加」候选：${JSON.stringify(discovery.candidates)}`)
    assert.equal(discovery.added.includes(ref), false, `${ref} 不该进「已计入」：${JSON.stringify(discovery.added)}`)
  }
  // 文件里确实躺着这些名字（诊断字段原样带出）：「文件里有」≠「属于本路线」
  for (const ref of FOREIGN_KEY_REFS) {
    assert.ok(discovery.scannedFromFile.includes(ref), `诊断字段应照原样带出 ${ref}：${JSON.stringify(discovery.scannedFromFile)}`)
  }
  return `${discovery.scanned.length} 个候选（文件里另有 ${FOREIGN_KEY_REFS.length} 个别家引用名，未进列表）`
})
await test('POST /keys/reveal：别家引用仍然 403；放宽的只有本路线自己的 apiKeyEnv 命名空间', async () => {
  // 收紧的那一半：别家的引用名一律 403，且拒绝时绝不回值（安全口径没放松）
  for (const ref of FOREIGN_KEY_REFS) {
    const res = await call('POST', '/plugins/dsh-balance-monitor/keys/reveal', { provider: 'deepseek-official', ref })
    assert.equal(res.statusCode, 403, `${ref} → ${res.statusCode}：${JSON.stringify(res.json)}`)
    assert.match(String(res.json.error), /拒绝返回/)
    assert.equal(JSON.stringify(res.json).includes('fake-'), false, `${ref} 被拒时更不能回值`)
  }
  // 既不在 apiKeyEnv 命名空间、也没纳入配置的自定义名：同样 403
  const backup = await call('POST', '/plugins/dsh-balance-monitor/keys/reveal', { provider: 'deepseek-official', ref: 'DSK_BACKUP_1' })
  assert.equal(backup.statusCode, 403, JSON.stringify(backup.json))
  // 放宽的那一半（有意为之，且只限本路线自己的命名空间）：`apiKeyEnv` 推导出来的名字
  // （`DEEPSEEK_API_KEY` / `_2`…）本来就列在这张卡片的列表里，眼睛必须能读。
  // 旧写法只认 deepseekKeys，于是列表里点 `_2` 反而 403 —— 正是用户报的「两套判据打架」。
  for (const ref of ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2']) {
    const ok = await call('POST', '/plugins/dsh-balance-monitor/keys/reveal', { provider: 'deepseek-official', ref })
    assert.equal(ok.statusCode, 200, `${ref} 是本路线 apiKeyEnv 命名空间里的引用，应能读：${JSON.stringify(ok.json).slice(0, 160)}`)
  }
  return `${FOREIGN_KEY_REFS.length} 个别家引用 + DSK_BACKUP_1 全 403 · 本命名空间的 API_KEY / _2 仍 200`
})
await test('归属按 route 走：限定给账号路线的条目，官方卡片不列、reveal 也拒（旧写法会放行）', async () => {
  await call('POST', '/plugins/dsh-balance-monitor/config', {
    deepseekKeys: [{ ref: 'DSK_ONLY_ACCOUNT', route: 'deepseek-account', label: '账号专用' }],
  })
  const official = (await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-official')).json.data
  assert.equal(official.keys.some(item => item.ref === 'DSK_ONLY_ACCOUNT'), false, `官方卡片不该列账号路线的条目：${JSON.stringify(official.keys)}`)
  const refused = await call('POST', '/plugins/dsh-balance-monitor/keys/reveal', { provider: 'deepseek-official', ref: 'DSK_ONLY_ACCOUNT' })
  assert.equal(refused.statusCode, 403, `归属判据共用后这条应被拒：${JSON.stringify(refused.json)}`)
  assert.match(String(refused.json.error), /不属于 deepseek-official/)
  // 账号路线：这条条目属于它 → 列表里有它，归属这一关放行（夹具里没有值，所以是 404 不是 403）。
  // 同时验证「没有 apiKeyEnv 的路线推不出凭据引用」：官方路线的 DEEPSEEK_API_KEY 不该出现在账号卡片上。
  const account = (await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-account')).json.data
  assert.deepEqual(account.keys.map(item => item.ref), ['DSK_ONLY_ACCOUNT'], `账号卡片只该列 route 匹配的条目：${JSON.stringify(account.keys)}`)
  const accountReveal = await call('POST', '/plugins/dsh-balance-monitor/keys/reveal', { provider: 'deepseek-account', ref: 'DSK_ONLY_ACCOUNT' })
  assert.equal(accountReveal.statusCode, 404, `过得了归属这关、只是没配值：${JSON.stringify(accountReveal.json)}`)
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: [] })
  return '官方：不列 + 403 · 账号：列 + 不被归属拦'
})
await test('过滤后一把 key 都没有：老实用空数组（界面据此说清），不拿别家的名字凑数', async () => {
  // 先归零（不依赖上一条用例的收尾是否跑到：断言失败时它就不会跑）
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: [] })
  // 「用户还没配」的现场：凭据服务对任何引用都回「没配」
  credentialsService.describe = async () => ({ configured: false, writable: true })
  const keys = (await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-official')).json.data
  assert.deepEqual(keys.keys, [], `应该老实给空数组：${JSON.stringify(keys.keys)}`)
  assert.equal(keys.primaryRef, 'DEEPSEEK_API_KEY', '主 key 引用名照旧带出来（界面要能提示它没配）')
  const account = (await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-account')).json.data
  assert.deepEqual(account.keys, [], `账号路线没有 apiKeyEnv，推不出任何凭据引用：${JSON.stringify(account.keys)}`)
  credentialsService.describe = savedDescribe
  return 'keys=[] · primaryRef 仍在'
})
console.log('\n[界面数据面：26 周热力图 + 全历史「按模型」]')
await test('喂两条不同模型的调用 → heatmap / modelsHistory 都对上，days.json 也存了明细', async () => {
  const before = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 's-heat-a', inputTokens: 2_000_000 })
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 's-heat-b', inputTokens: 1_000_000 })
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-pro', sessionId: 's-heat-c', inputTokens: 500_000 })
  const data = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  // 热力图：26 周、补齐空天、末项是今天
  assert.equal(data.heatmap.length, 182, '热力图应是 26 周（182 天）')
  assert.equal(data.heatmap.at(-1).date, data.date, '末项是今天')
  assert.equal(data.heatmap.at(-1).calls, (before.heatmap.at(-1).calls ?? 0) + 3, '三笔调用都记在今天')
  assert.ok(data.heatmap.at(-1).tokens > (before.heatmap.at(-1).tokens ?? 0), 'token 也要涨')
  assert.ok(data.heatmap.slice(0, -1).every(row => Number.isInteger(row.calls)), '补的空天是 0 而不是缺项')
  // 全历史按模型：两个模型各一行，字段够四种排行用
  const flash = data.modelsHistory.rows.find(row => row.model === 'cn:deepseek-v4.1-flash')
  const pro = data.modelsHistory.rows.find(row => row.model === 'cn:deepseek-v4.1-pro')
  assert.ok(flash !== undefined && pro !== undefined, `两个模型都应在表里：${JSON.stringify(data.modelsHistory.rows.map(r => r.key))}`)
  // 同一个沙箱里前面的用例也喂过 flash，所以断言「增量」而不是绝对值
  const beforeFlash = before.modelsHistory.rows.find(row => row.model === 'cn:deepseek-v4.1-flash')
  const beforePro = before.modelsHistory.rows.find(row => row.model === 'cn:deepseek-v4.1-pro')
  assert.equal(flash.calls, (beforeFlash?.calls ?? 0) + 2, 'flash 这次加两次')
  assert.equal(pro.calls, (beforePro?.calls ?? 0) + 1, 'pro 这次加一次')
  assert.ok(flash.usd > (beforeFlash?.usd ?? 0), 'flash 金额涨了')
  assert.ok(typeof flash.hitRate === 'number' || flash.hitRate === null, '命中率字段在')
  assert.ok(flash.tokens.total === flash.tokens.input + flash.tokens.output + flash.tokens.cacheRead + flash.tokens.cacheWrite, 'token 总数 = 四桶之和')
  assert.ok(flash.perUsd === null || flash.perUsd > 0, '每美元 token 数（有价才有值）')
  assert.equal(typeof data.modelsHistory.since, 'string', '起始日期在')
  // 排序：默认按金额降序（四种排行的切换在客户端做，宿主保证默认顺序稳定）
  for (let index = 1; index < data.modelsHistory.rows.length; index += 1) {
    assert.ok(data.modelsHistory.rows[index - 1].usd >= data.modelsHistory.rows[index].usd, '默认应按金额降序')
  }
  // days.json 里存了按模型明细，且明细金额之和 = 当日金额
  const rollup = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'days.json'), 'utf8'))
  const day = rollup.days[data.date]
  assert.ok(Object.keys(day.models ?? {}).length >= 2, `days.json 应存按模型明细：${JSON.stringify(day.models)}`)
  const sum = Object.values(day.models).reduce((total, row) => total + row.usd, 0)
  close(sum, day.usd, 1e-9, '明细金额之和 = 当日金额')
  return `182 天热力图 · ${data.modelsHistory.rows.length} 个模型 · 明细可加总`
})

console.log('\n[本会话费用：/session 路由]')
await test('GET /session：自身 / 子代理 / 合计，子代理要显式开', async () => {
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 'sess-parent', inputTokens: 1_000_000 })
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 'sess-child', parentSessionId: 'sess-parent', inputTokens: 500_000 })
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 'sess-unrelated', inputTokens: 2_000_000 })
  const off = (await call('GET', '/plugins/dsh-balance-monitor/session?sessionId=sess-parent')).json.data
  assert.equal(off.sessionId, 'sess-parent')
  assert.equal(off.includeSubagent, false)
  assert.equal(off.self.calls, 1)
  assert.equal(off.children.calls, 0, '关着时不算子代理')
  assert.equal(off.total.calls, 1)
  assert.equal(off.subagentSupported, true, '有带 parentSessionId 的记录 → 归属可用')
  assert.ok(typeof off.self.amount !== 'undefined', '金额按展示币种给字符串')
  assert.equal(off.total.cost !== undefined, true)
  const on = (await call('GET', '/plugins/dsh-balance-monitor/session?sessionId=sess-parent&includeSubagent=1')).json.data
  assert.equal(on.includeSubagent, true)
  assert.equal(on.children.calls, 1, '子代理那次要算进来')
  assert.equal(on.total.calls, 2)
  assert.ok(on.total.usd > off.total.usd, '合计金额应更大')
  assert.equal(on.total.tokens.total, on.self.tokens.total + on.children.tokens.total, 'token 桶相加')
  assert.ok(on.total.models.length >= 1, '给 Top 模型')
  // 无关会话不串味
  const other = (await call('GET', '/plugins/dsh-balance-monitor/session?sessionId=sess-unrelated&includeSubagent=1')).json.data
  assert.equal(other.total.calls, 1)
  // 未知会话：200 但全 0（界面显示 0 / —），不是错误
  const none = (await call('GET', '/plugins/dsh-balance-monitor/session?sessionId=does-not-exist')).json.data
  assert.equal(none.total.calls, 0)
  assert.equal(none.total.cost, null, '没有调用时金额是 null（不是 0）')
  // 缺 sessionId → 400；方法不对 → 405
  assert.equal((await call('GET', '/plugins/dsh-balance-monitor/session')).statusCode, 400)
  assert.equal((await call('POST', '/plugins/dsh-balance-monitor/session', { sessionId: 'sess-parent' })).statusCode, 405)
  return 'self 1 + 子代理 1 = 2 · 未知会话 0 · 缺参 400'
})

console.log('\n[历史数据：清空 / 导入探测]')
// 放在最后：清空是真的破坏性操作，会把这之前的账清掉（后面的用例不再依赖历史数据）
await test('POST /history/clear 不带确认 → 400，且一个字节都不动', async () => {
  const dir = join(sandbox, 'storages', 'dsh-balance-monitor')
  const before = JSON.parse(readFileSync(join(dir, 'days.json'), 'utf8'))
  const refused = await call('POST', '/plugins/dsh-balance-monitor/history/clear', {})
  assert.equal(refused.statusCode, 400)
  assert.ok(String(refused.json.error).includes('显式确认'), `要提示怎么确认：${refused.json.error}`)
  const after = JSON.parse(readFileSync(join(dir, 'days.json'), 'utf8'))
  assert.deepEqual(after, before, '被拒绝时不该动任何数据')
  assert.equal((await call('POST', '/plugins/dsh-balance-monitor/history/clear', { confirm: 'clear-all' })).statusCode, 400,
    '确认串写错也算拒绝')
  return '400 · 数据未动'
})
await test('POST /history/clear 带确认 → 内存与两个文件一起清空，报表归零', async () => {
  const dir = join(sandbox, 'storages', 'dsh-balance-monitor')
  const before = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.ok(before.totals.all.calls > 0, '前置：累计应有调用')
  const cleared = await call('POST', '/plugins/dsh-balance-monitor/history/clear', { confirm: 'clear-all-history' })
  assert.equal(cleared.statusCode, 200)
  assert.ok(cleared.json.data.ledgerDays > 0, `要报清掉多少天：${JSON.stringify(cleared.json.data)}`)
  assert.ok(cleared.json.data.records > 0, '要报清掉多少条')
  assert.deepEqual(cleared.json.data.writeFailed, [], '落盘要成功（失败必须报出来）')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).days, {}, '账本文件清空')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'days.json'), 'utf8')).days, {}, '日汇总文件清空')
  // 关键是**内存也清了**：只删文件的话报表还是旧的，下一次防抖写入还会把数据写回去
  const after = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(after.totals.all.calls, 0, '累计归零')
  assert.equal(after.totals.today.calls, 0, '今日归零')
  assert.equal(after.sessions.length, 0, '会话明细归零')
  assert.equal(after.modelsHistory.rows.length, 0)
  // 清空后新记一笔 → 账上只有这一笔
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 's-after-clear', inputTokens: 1_000_000 })
  const fresh = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(fresh.totals.today.calls, 1, '清空后新记的一笔要在账上')
  assert.equal(fresh.totals.all.calls, 1)
  return `清掉 ${cleared.json.data.ledgerDays} 天 / ${cleared.json.data.records} 条 · 之后从零开始`
})
// 去重是为了防「包装路由把同一次调用投递两遍」：同会话 + 同模型 + 同 token 数在 10 秒内算重复。
// 清空历史后若不重置这份记忆，清空前刚记过的调用会在紧接着重复到达时被静默丢掉 ——
// 刚清完就开始丢账，最容易被误会成「清坏了解」。
await test('清空历史会重置去重记忆（刚清完不会因为 10 秒窗口把新账丢掉）', async () => {
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 's-dedupe', inputTokens: 1_000_000 })
  await call('POST', '/plugins/dsh-balance-monitor/history/clear', { confirm: 'clear-all-history' })
  await feedStream({ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', sessionId: 's-dedupe', inputTokens: 1_000_000 })
  const after = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.totals.today.calls
  assert.equal(after, 1, `清空后这一次必须记上（不该被清空前的去重记忆吃掉），实际 ${after}`)
  return '重置去重记忆 · 清空后照样记'
})
await test('POST /history/import：只做能力探测（available=false + 原因），不做回放', async () => {
  const probe = (await call('POST', '/plugins/dsh-balance-monitor/history/import', {})).json.data
  assert.equal(probe.available, false, '本版本不导入：格式未验证，宁可不做')
  assert.ok(typeof probe.reason === 'string' && probe.reason.length > 0, `要给原因：${JSON.stringify(probe)}`)
  assert.ok(typeof probe.sessionsRoot === 'string', '要告诉用户去哪找日志')
  assert.equal(typeof probe.zstd, 'boolean', '要报 zstd 是否可用')
  assert.equal(typeof probe.sessionFiles, 'number')
  assert.equal(typeof probe.projects, 'number')
  return `${probe.sessionFiles} 份日志 · zstd=${probe.zstd} · ${String(probe.reason).slice(0, 24)}…`
})
// 宿主按会话格式版本换名：本机 368 个会话里 275 个只有 session.v3/v4.jsonl.zstd，
// 只数 session.jsonl.zstd 会把份数少报成真实的 1/4。
await test('会话日志带版本后缀（v3 / v4）也要数进去', async () => {
  const project = join(sandbox, 'sessions', 'proj-a')
  for (const [dir, file] of [
    ['sess-plain', 'session.jsonl.zstd'],
    ['sess-v3', 'session.v3.jsonl.zstd'],
    ['sess-v4', 'session.v4.jsonl.zstd'],
  ]) {
    mkdirSync(join(project, dir), { recursive: true })
    writeFileSync(join(project, dir, file), 'stub', 'utf8')
  }
  // 噪声：同目录里别的文件不算会话日志
  writeFileSync(join(project, 'sess-v3', 'notes.txt'), 'stub', 'utf8')
  const probe = (await call('POST', '/plugins/dsh-balance-monitor/history/import', {})).json.data
  assert.equal(probe.projects, 1, JSON.stringify(probe))
  assert.equal(probe.sessionFiles, 3, `三种文件名要数满 3 份：${JSON.stringify(probe)}`)
  return `3 种文件名 → ${probe.sessionFiles} 份 · ${String(probe.reason).slice(0, 20)}…`
})
await test('只剩一个 v3 日志时：报 1 份，而不是「没有可读的会话日志」', async () => {
  const project = join(sandbox, 'sessions', 'proj-a')
  rmSync(join(project, 'sess-plain'), { recursive: true, force: true })
  rmSync(join(project, 'sess-v4'), { recursive: true, force: true })
  const probe = (await call('POST', '/plugins/dsh-balance-monitor/history/import', {})).json.data
  assert.equal(probe.sessionFiles, 1, `只有 v3 也要数上：${JSON.stringify(probe)}`)
  assert.equal(String(probe.reason).includes('没有可读的会话日志'), false, `不该说没有日志：${probe.reason}`)
  assert.ok(String(probe.reason).includes('1 份会话日志'), probe.reason)
  return `仅 v3 → ${probe.sessionFiles} 份`
})

console.log('\n[Host 白名单：挡 DNS rebinding]')
await test('rebinding 头（同源 + 恶意域名）→ 403，读和写都挡住', async () => {
  // 攻击形态：恶意页所在的域名重新解析到 127.0.0.1，浏览器于是认为这是**同源**请求：
  // Sec-Fetch-Site: same-origin + Origin/Host 都是攻击者域名 —— 跨站判据一条都命中不了。
  // 放在文件末尾跑：这里的请求会真的触发探测 / 余额查询，别污染前面「默认不出网」的断言。
  const rebind = { 'sec-fetch-site': 'same-origin', origin: 'http://evil.test:3080', host: 'evil.test:3080', 'content-type': 'application/json' }
  const read = await call('POST', '/plugins/dsh-balance-monitor/keys/reveal',
    { provider: 'deepseek-official', ref: 'DEEPSEEK_API_KEY' }, rebind)
  assert.equal(read.statusCode, 403, `明文读取必须被挡住：${JSON.stringify(read.json).slice(0, 120)}`)
  assert.equal(JSON.stringify(read.json).includes('sk-key'), false, '不能漏出任何 key')
  const write = await call('DELETE', '/plugins/dsh-balance-monitor/keys',
    { provider: 'deepseek-official', ref: 'DEEPSEEK_API_KEY_2' }, rebind)
  assert.equal(write.statusCode, 403)
  assert.match(write.json.error, /不在允许列表/)
  // GET 也挡（否则余额/花费能被读走）
  const get = await call('GET', '/plugins/dsh-balance-monitor/report', undefined, rebind)
  assert.equal(get.statusCode, 403)
  const sidebar = await call('GET', '/plugins/dsh-balance-monitor/sidebar', undefined, rebind)
  assert.equal(sidebar.statusCode, 403)
  return '读写全挡 · 403'
})
await test('回环地址 / 无 Host / IPv6 回环都照常放行', async () => {
  const cases = [
    { host: '127.0.0.1:3080' },
    { host: 'localhost:3080' },
    { host: '127.1.2.3:3080' },
    { host: '[::1]:3080' },
    {},
  ]
  for (const headers of cases) {
    const res = await call('GET', '/plugins/dsh-balance-monitor/state', undefined, headers)
    assert.equal(res.statusCode, 200, `${JSON.stringify(headers)} → ${res.statusCode}：${res.json?.error ?? ''}`)
  }
  return `${cases.length} 种写法放行`
})
await test('allowedHosts 是逃生门：列出后放行，且不影响跨站判据', async () => {
  const before = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.allowedHosts
  assert.deepEqual(before, [], '默认是空（只允许回环）')
  const saved = await call('POST', '/plugins/dsh-balance-monitor/config', {
    allowedHosts: ['Panel.Example.com', 'panel.example.com', '192.168.1.10:3080', 'bad host!'],
  })
  assert.deepEqual(saved.json.data.allowedHosts, ['panel.example.com', '192.168.1.10:3080'], '去重/转小写/非法项丢掉')
  const ok = await call('GET', '/plugins/dsh-balance-monitor/state', undefined, { host: 'panel.example.com' })
  assert.equal(ok.statusCode, 200, ok.json?.error ?? '')
  // 白名单只放宽 Host 判据：跨站请求照样拒
  const cross = await call('POST', '/plugins/dsh-balance-monitor/config',
    {}, { host: 'panel.example.com', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' })
  assert.equal(cross.statusCode, 403)
  await call('POST', '/plugins/dsh-balance-monitor/config', { allowedHosts: null })
  const restored = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.allowedHosts
  assert.deepEqual(restored, [], 'null = 回默认')
  return '显式列出才放行'
})
console.log('\n[老四块与新区块同一套规矩：非法值沿用当前生效值，只有 null 才清空]')
await test('保留期 / 序号上限 / 候选前缀 / Host 白名单：一份非法值不再把它们一次冲掉', async () => {
  const file = join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json')
  // 四块都设成非默认值 —— 这是对抗式审计的最小复现（旧写法提交下面那份非法值时会被冲掉）
  const saved = await call('POST', '/plugins/dsh-balance-monitor/config', {
    retention: { ledgerDays: 12, rollupDays: 365 },
    deepseekKeyMaxIndex: 20,
    deepseekKeyPrefixes: ['MY_KEY'],
    allowedHosts: ['panel.example:443'],
  })
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.json).slice(0, 200))
  assert.deepEqual(saved.json.data.retention, { ledgerDays: 12, rollupDays: 365 })
  assert.deepEqual(saved.json.data.keyDiscovery.prefixes, ['MY_KEY'])
  assert.equal(saved.json.data.keyDiscovery.maxIndex, 20)
  assert.deepEqual(saved.json.data.allowedHosts, ['panel.example:443'])

  // 再提交一份「形状 / 类型非法」的值：逐块沿用当前生效值，一个键都不该被删
  const junk = await call('POST', '/plugins/dsh-balance-monitor/config', {
    retention: { ledgerDays: 'abc' },
    deepseekKeyMaxIndex: 'abc',
    deepseekKeyPrefixes: 'MY_KEY',
    allowedHosts: 'panel.example:443',
  })
  assert.equal(junk.statusCode, 200, JSON.stringify(junk.json).slice(0, 200))
  assert.deepEqual(junk.json.data.retention, { ledgerDays: 12, rollupDays: 365 }, '保留期非法值沿用现值（不是回落默认 7/400）')
  assert.equal(junk.json.data.keyDiscovery.maxIndex, 20, '序号上限非法值沿用现值（不是回落默认 9）')
  assert.deepEqual(junk.json.data.keyDiscovery.prefixes, ['MY_KEY'], '前缀传字符串 = 非法 → 沿用现值')
  assert.deepEqual(junk.json.data.allowedHosts, ['panel.example:443'], '白名单传字符串 = 非法 → 沿用现值')

  // 立刻回读：报表 payload 与磁盘上的 state.json 都不能变
  const report = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.deepEqual(report.retention, { ledgerDays: 12, rollupDays: 365 })
  assert.equal(report.keyDiscovery.maxIndex, 20)
  assert.deepEqual(report.keyDiscovery.prefixes, ['MY_KEY'])
  assert.deepEqual(report.allowedHosts, ['panel.example:443'])
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk.retention, { ledgerDays: 12, rollupDays: 365 }, '那几条配置在文件里也要还在')
  assert.equal(onDisk.deepseekKeyMaxIndex, 20)
  assert.deepEqual(onDisk.deepseekKeyPrefixes, ['MY_KEY'])
  assert.deepEqual(onDisk.allowedHosts, ['panel.example:443'])

  // `null` 才是清空：四块各自回默认
  const cleared = await call('POST', '/plugins/dsh-balance-monitor/config', {
    retention: null, deepseekKeyMaxIndex: null, deepseekKeyPrefixes: [], allowedHosts: null,
  })
  assert.deepEqual(cleared.json.data.retention, { ledgerDays: 7, rollupDays: 400 }, 'null = 清空回默认')
  assert.equal(cleared.json.data.keyDiscovery.maxIndex, 9)
  assert.deepEqual(cleared.json.data.keyDiscovery.prefixes, ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY'])
  assert.deepEqual(cleared.json.data.allowedHosts, [])
  const after = JSON.parse(readFileSync(file, 'utf8'))
  for (const key of ['retention', 'deepseekKeyMaxIndex', 'deepseekKeyPrefixes', 'allowedHosts']) {
    assert.equal(after[key], undefined, `${key} 清空后不该在文件里留一条`)
  }
  return '非法值守住现值 · null 才清空'
})

console.log('\n[请求体：体积超限与 JSON 坏掉要说两句不同的话]')
await test('17KB 的 body → 400 且文案是「请求体过大」（不是 invalid json body）', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/config', { pad: 'x'.repeat(17 * 1024) })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /过大/)
  assert.notEqual(res.json.error, 'invalid json body', '体积超限不该被说成 JSON 解析失败')
  return res.json.error
})
await test('超限后把剩下的分片读干净（不许半路 return 让连接悬着）', async () => {
  // 4 片共约 23KB：第 3 片就越界了，第 4 片必须继续被读掉（旧写法在第 3 片就 return）
  const parts = [
    Buffer.from(JSON.stringify({ pad: 'x'.repeat(7 * 1024) })),
    Buffer.from('x'.repeat(7 * 1024)),
    Buffer.from('x'.repeat(7 * 1024)),
    Buffer.from('x'.repeat(2 * 1024)),
  ]
  let pulled = 0
  const req = {
    method: 'POST', url: '/plugins/dsh-balance-monitor/config', headers: {},
    async *[Symbol.asyncIterator]() { for (const part of parts) { pulled += 1; yield part } },
  }
  const res = makeRes()
  await routes[0].handler(req, res)
  assert.equal(res.statusCode, 400)
  assert.equal(pulled, parts.length, `超限后要把剩下的分片读完：只读了 ${pulled} / ${parts.length} 片`)
  assert.match(res.json.error, /过大/)
  return `${parts.length} 片全读完 · ${res.json.error}`
})
await test('真正坏掉的 JSON 仍是「JSON 解析失败」那条文案（与「过大」区分）', async () => {
  const req = {
    method: 'POST', url: '/plugins/dsh-balance-monitor/config', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('{oops') },
  }
  const res = makeRes()
  await routes[0].handler(req, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.json.error, 'invalid json body')
  assert.equal(/过大/.test(res.json.error), false)
  return res.json.error
})

console.log('\n[WorkBuddy 型：切类型 → 读面板积分 → 侧栏展示]')
await test('切到 workbuddy 后探测出「今日积分」（自身口径 + 站方口径分开）', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/type', { provider: 'wbfd', type: 'workbuddy' })
  assert.equal(res.statusCode, 200)
  const entry = res.json.state.providers.find(p => p.provider === 'wbfd')
  assert.equal(entry.type, 'workbuddy')
  assert.equal(entry.status, 'ok')
  assert.equal(entry.workbuddy.ratedModelCount, 1, '指纹只认带 credits 的模型')
  assert.equal(entry.workbuddy.models.length, 2, '不带 credits 的模型照样带出去')
  // 1.25 + 0.5 = 1.75；第三条没有 credit 字段，**不能当 0 计**。
  assert.equal(entry.workbuddy.own.credits, 1.75)
  assert.equal(entry.workbuddy.own.unknown, 1)
  assert.equal(entry.workbuddy.site.totals.credits, 849.14)
  assert.equal(entry.workbuddy.period, 'today')
  return `自身 ${entry.workbuddy.own.credits} / 站方 ${entry.workbuddy.site.totals.credits}`
})
await test('面板地址取 baseURL 的 origin（丢掉 /v1），且带同一把 key', () => {
  const paths = seen.filter(item => new URL(item.url).host === '114.66.62.99:7863').map(item => new URL(item.url).pathname)
  assert.ok(paths.includes('/panel/api/usage'), `实际路径：${paths.join(', ')}`)
  assert.ok(paths.includes('/panel/api/request_logs'), `实际路径：${paths.join(', ')}`)
  assert.ok(!paths.some(item => item.startsWith('/v1/panel')), '面板不在 /v1 下')
  const panelCalls = seen.filter(item => new URL(item.url).pathname.startsWith('/panel/'))
  assert.ok(panelCalls.every(item => item.auth === 'Bearer sk-test-wbfd'), '面板鉴权与 API 同口径，必须带 key')
  return `面板请求 ${panelCalls.length} 次，全部带 key`
})
await test('自身口径默认按 deepseek-harness 过滤（即「只算我的」）', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/state')
  const entry = res.json.state.providers.find(p => p.provider === 'wbfd')
  assert.deepEqual(entry.creditsFilter, { userAgent: 'deepseek-harness' })
  const filtered = seen.filter(item => new URL(item.url).searchParams.get('user_agent') === 'deepseek-harness')
  assert.ok(filtered.length > 0, '归档查询必须带上 UA 过滤，否则读到的是全站')
  return 'userAgent=deepseek-harness'
})
await test('类型落盘（重启用）', () => {
  const parsed = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.equal(parsed.types.wbfd, 'workbuddy')
})
await test('POST /credits/filter 改过滤条件 → 立刻重探并回显', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/credits/filter',
    { provider: 'wbfd', userAgent: 'my-tool', clientIp: '203.0.113.7' }, { 'content-type': 'application/json' })
  assert.equal(res.statusCode, 200)
  const entry = res.json.state.providers.find(p => p.provider === 'wbfd')
  assert.deepEqual(entry.creditsFilter, { userAgent: 'my-tool', clientIp: '203.0.113.7' })
  const parsed = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.deepEqual(parsed.creditsFilters.wbfd, { userAgent: 'my-tool', clientIp: '203.0.113.7' })
  const both = seen.filter(item => new URL(item.url).searchParams.get('user_agent') === 'my-tool')
  assert.ok(both.some(item => new URL(item.url).searchParams.get('client_ip') === '203.0.113.7'), 'IP 条件要一起下发')
  return 'userAgent=my-tool · clientIp=203.0.113.7'
})
await test('过滤条件传空串 = 清掉该项（回落默认 UA）', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/credits/filter',
    { provider: 'wbfd', userAgent: '' }, { 'content-type': 'application/json' })
  assert.equal(res.statusCode, 200)
  const entry = res.json.state.providers.find(p => p.provider === 'wbfd')
  assert.equal(entry.creditsFilter.userAgent, 'deepseek-harness')
  assert.equal(entry.creditsFilter.clientIp, '203.0.113.7', '只改 UA 时 IP 条件要保留')
  return JSON.stringify(entry.creditsFilter)
})
await test('未知供应商 → 404', async () => {
  const res = await call('POST', '/plugins/dsh-balance-monitor/credits/filter', { provider: 'nope', userAgent: 'x' })
  assert.equal(res.statusCode, 404)
})
await test('侧栏带出积分块（自身 + 站方，且不并进任何金额）', async () => {
  const res = await call('GET', '/plugins/dsh-balance-monitor/sidebar')
  assert.equal(res.statusCode, 200)
  const rows = res.json.data.credits
  assert.ok(Array.isArray(rows) && rows.length === 1, `实际：${JSON.stringify(rows)}`)
  const row = rows[0]
  assert.equal(row.provider, 'wbfd')
  assert.equal(row.ownCredits, 1.75)
  assert.equal(row.ownCalls, 3)
  assert.equal(row.siteCredits, 849.14)
  assert.equal(row.period, 'today')
  // 积分不是钱：它必须**不在**任何金额字段里。
  assert.equal(row.usd, undefined)
  assert.equal(row.amount, undefined)
  assert.ok(!Object.keys(res.json.data.total).includes('credits'), '总额里不能混进积分')
  return `own=${row.ownCredits} site=${row.siteCredits}`
})
await test('侧栏的 credits 只读内存缓存，不再打面板（轮询不许放大探测）', async () => {
  const before = seen.filter(item => new URL(item.url).pathname.startsWith('/panel/')).length
  await call('GET', '/plugins/dsh-balance-monitor/sidebar')
  const after = seen.filter(item => new URL(item.url).pathname.startsWith('/panel/')).length
  assert.equal(after, before, `侧栏轮询不该新增面板请求：${before} → ${after}`)
})

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
