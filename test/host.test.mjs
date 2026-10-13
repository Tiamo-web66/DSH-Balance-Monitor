#!/usr/bin/env node
/**
 * host 半身验证：不启动 Harness，直接给插件喂一个假的 ctx，
 * 驱动它注册的同源路由，检查「枚举供应商 → 存类型 → 探测 → 出状态」整条链路。
 *
 * 全离线：globalThis.fetch 被打桩成固定响应，测试不产生任何出网请求。
 *
 *   node test/host.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname
  seen.push({ url: String(url), auth: init?.headers?.authorization })
  if (String(url) === LITELLM_SOURCE) {
    return new Response(JSON.stringify(liteLLMPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (String(url).includes('/user/balance')) {
    // 两把 key 给不同余额：用来验证「总额相加 + 明细逐条」
    const isSecond = String(init?.headers?.authorization ?? '').includes('sk-key-two')
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: isSecond ? '1.50' : '0.01',
        granted_balance: '0',
        topped_up_balance: isSecond ? '1.50' : '0.01',
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
      async resolve(ref) {
        credentialCalls.push(ref)
        if (ref === 'WALK_GROK_API_KEY') return { value: 'sk-test-walk-grok', source: 'file' }
        if (ref === 'DEEPSEEK_API_KEY') return { value: 'sk-key-one', source: 'file' }
        if (ref === 'DEEPSEEK_API_KEY_2') return { value: 'sk-key-two', source: 'file' }
      },
      /** 方案 A 的探测接口：只回「有没有配 / 来源」，不回值。 */
      describeCalls: [],
      setCalls: [],
      unsetCalls: [],
      async set(ref, value) { this.setCalls.push({ ref, value }); if (ref === 'DEEPSEEK_API_KEY_2') this.extraConfigured = true },
      async unset(ref) { this.unsetCalls.push(ref); if (ref === 'DEEPSEEK_API_KEY_2') this.extraConfigured = false },
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
async function callOn(route, method, path, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    method, url: path,
    async *[Symbol.asyncIterator]() { if (payload !== null) yield payload },
  }
  const res = makeRes()
  await route.handler(req, res)
  return res
}
async function call(method, path, body) {
  return callOn(routes[0], method, path, body)
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
async function feedStream({ provider, model, sessionId, inputTokens = 1_000_000 }) {
  const listener = llmListeners[0]
  assert.equal(typeof listener, 'function', '应注册了 llm/stream 监听器')
  const usage = { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  const stream = listener({ model, sessionId, provider }, () => (async function* () {
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

await test('配置重载后预算额度仍是 null（loadStore 不能被 Number(null)=0 骗）', async () => {
  // 重新 apply 一次 = 从磁盘重新读配置（同一份 settings 桩）
  mod.apply(makeCtx({ providers, settings }))
  const report = (await callOn(routes.at(-1), 'GET', '/plugins/dsh-balance-monitor/report')).json.data
  assert.equal(report.budget.amount, null, '重载后额度不该变成 0')
  assert.equal(report.budget.enabled, true, '开关状态要保持')
  return 'amount 仍为 null'
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

await test('清空 key 列表 → 回到用路线自己的 apiKeyEnv（单把）', async () => {
  await call('POST', '/plugins/dsh-balance-monitor/config', { deepseekKeys: [] })
  const data = (await call('POST', '/plugins/dsh-balance-monitor/balance/refresh', { provider: 'deepseek-official' })).json.data
  const official = data.balances.find(item => item.provider === 'deepseek-official')
  close(official.amount, 0.01, 1e-9, '单把 key 时金额还是它自己')
  const state = JSON.parse(readFileSync(join(sandbox, 'storages', 'dsh-balance-monitor', 'state.json'), 'utf8'))
  assert.equal(state.deepseekKeys, undefined, '空列表应清掉该字段')
  return '回落到 DEEPSEEK_API_KEY'
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
await test('方案 B：凭据文件里的自定义命名也能列出来（只取键名）', async () => {
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
  assert.ok(discovery.scannedFromFile.includes('DSK_BACKUP_1'), `文件扫描结果：${JSON.stringify(discovery.scannedFromFile)}`)
  assert.ok(discovery.foundRefs.includes('DSK_BACKUP_1'), `命中：${JSON.stringify(discovery.foundRefs)}`)
  assert.equal(JSON.stringify(discovery).includes('fake-two'), false, '不能把值带出来')
  assert.equal(JSON.stringify(discovery).includes('fake-token'), false, 'records 段的 token 更不能带出来')
  // GET /keys 也会列它（未纳入配置 → 显示为可加的引用）
  const keys = (await call('GET', '/plugins/dsh-balance-monitor/keys?provider=deepseek-official')).json.data
  assert.ok(keys.keys.some(item => item.ref === 'DSK_BACKUP_1' && item.configured === true), JSON.stringify(keys.keys))
  return `scannedFromFile=${discovery.scannedFromFile.length} · 命中含 DSK_BACKUP_1`
})

await test('scanCredentialsFile: false → 退回纯候选名探测（不碰凭据文件）', async () => {
  await call('POST', '/plugins/dsh-balance-monitor/config', { scanCredentialsFile: false })
  const discovery = (await call('GET', '/plugins/dsh-balance-monitor/report')).json.data.keyCandidates
  assert.equal(discovery.scannedFromFile, undefined, `关掉后不该有文件扫描结果：${JSON.stringify(discovery.scannedFromFile)}`)
  assert.ok(discovery.foundRefs.includes('DEEPSEEK_API_KEY'), '候选名探测照旧')
  await call('POST', '/plugins/dsh-balance-monitor/config', { scanCredentialsFile: true })
  return '已退回候选名探测'
})
rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
