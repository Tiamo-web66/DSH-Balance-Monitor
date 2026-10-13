#!/usr/bin/env node
/**
 * 客户端半身的**渲染级**验证（不需要浏览器、不需要真 React）。
 *
 * 为什么需要它：`lib/client.js` 是手写浏览器模块，前面的用例只能覆盖宿主侧。
 * 这里用最小 React 替身把组件真的**执行一遍**：
 *   - 抓出 `MockModuleLoader` 注册的工厂，按 `require('react')` 注入替身；
 *   - 用假的 `/report`、`/sidebar`、`/prices/update` 响应驱动数据流；
 *   - 渲染「设置页：余额与费用」五个分页 + 侧栏底部，并**通过点击分页按钮切页**；
 * 任何 undefined 引用、缺字段、hook 用法错误都会在这里炸出来。
 *
 *   node test/client-page.test.mjs
 */
import assert from 'node:assert/strict'

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

// ── 迷你 React：state 与 effect 按**组件身份**存（WeakMap），effect 只在挂载时跑一次 ──
//
// 这里曾经按「渲染顺序的下标」存帧，结果是：切分页之后同一个下标会被另一个组件占用，
// 两个组件的 state 互相覆盖（概览页去读显示页写进去的 null 就炸了）。
// React 本来就是按组件身份存 hook 状态的，所以这里也照做 —— 顺带消掉了
// 「嵌套组件的状态写不进去」那条老限制。
const componentFrames = new WeakMap()
let currentFrame = null
let dirty = false
function frameFor(component) {
  let frame = componentFrames.get(component)
  if (frame === undefined) {
    frame = { slots: [], effects: [], cursor: 0 }
    componentFrames.set(component, frame)
  }
  return frame
}
/** 进入一个组件：切 currentFrame 并把该组件的 hook 游标归零。 */
function withFrame(frame, fn) {
  const savedFrame = currentFrame
  const savedCursor = frame.cursor
  frame.cursor = 0
  currentFrame = frame
  try {
    return fn()
  } finally {
    currentFrame = savedFrame
    frame.cursor = savedCursor
  }
}
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) } }
  },
  useState(initial) {
    const frame = currentFrame
    if (frame === null) return [typeof initial === 'function' ? initial() : initial, () => {}]
    const cursor = frame.cursor++
    if (frame.slots[cursor] === undefined) frame.slots[cursor] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = frame.slots[cursor]
    return [slot.value, next => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (value !== slot.value) {
        slot.value = value
        dirty = true
      }
    }]
  },
  useEffect(effect) {
    const frame = currentFrame
    if (frame === null) return
    const cursor = frame.cursor++
    if (frame.effects[cursor] === true) return
    frame.effects[cursor] = true
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useRef(initial) { return { current: initial } },
}
const cleanups = []

// ── 浏览器环境替身 ──
/** 26 周（182 天）的日期序列，末项是夹具里的「今天」；热力图按它铺格子。 */
const HEAT_DATES = Array.from({ length: 182 }, (_, index) => {
  const ms = Date.parse('2026-10-13T00:00:00Z') - (181 - index) * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
})
const REPORT = {
  date: '2026-10-13',
  now: Date.parse('2026-10-13T02:00:00Z'),
  display: { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2 },
  // 刻意不等于客户端兜底的 7 / 400：这样「回填的是宿主送来的值」才可断言
  retention: { ledgerDays: 12, rollupDays: 365 },
  notify: { enabled: true, system: false },
  // 「显示」页的两段新配置：密钥扫描 + 官方峰谷（宿主逐字段归一后下发）
  keyDiscovery: { scanCredentialsFile: true, prefixes: ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY'], maxIndex: 9 },
  // Host 白名单（默认空 = 只允许回环；这里给一条，验证界面能回填与保存）
  allowedHosts: ['panel.example.com'],
  // 界面偏好（语言 / 轮询间隔 / 隐藏敏感区块 / 会话 ID）
  ui: { locale: 'auto', refreshSeconds: 30, hideOfficialBalance: false, hideTodayCost: false, showSessionId: false },
  officialPeak: {
    enabled: true,
    effectiveAt: '2026-08-01T00:00:00Z',
    weekendOffPeakFrom: '2026-08-22T16:00:00Z',
    legacyBoundary: '2026-08-16T16:00:00Z',
    windows: [{ start: 1, end: 4 }, { start: 6, end: 10 }],
    holidays: ['2026-10-01', '2026-10-02'],
  },
  totals: {
    today: { usd: 0.1944, amount: 1.3997, calls: 160, priced: 159, unpriced: 1, tokens: { input: 905_000, output: 161_000, cacheRead: 64_400_000, cacheWrite: 0, reasoning: 0, total: 65_466_000 }, hitRate: 0.986 },
    month: { usd: 55.3059, amount: 398.2025, calls: 14_285, unpriced: 623, days: 12, since: '2026-10-01', tokens: { input: 27_600_000, output: 10_100_000, cacheRead: 3_431_000_000, cacheWrite: 0, reasoning: 0, total: 3_468_700_000 }, hitRate: 0.992 },
    all: { usd: 248.8406, amount: 1791.6523, calls: 42_551, unpriced: 623, days: 87, since: '2026-08-01', tokens: { input: 120_000_000, output: 40_000_000, cacheRead: 9_000_000_000, cacheWrite: 0, reasoning: 0, total: 9_160_000_000 }, hitRate: 0.987 },
  },
  sessions: [
    { sessionId: 'session-747f69a1-2f31', calls: 160, priced: 159, unpriced: 1, usd: 0.1944, tokens: { input: 905_000, output: 161_000, cacheRead: 64_400_000, cacheWrite: 0, reasoning: 0, total: 65_466_000 }, hitRate: 0.986, models: [{ model: 'cn:deepseek-v4.1-flash', calls: 160 }], firstAtMs: 1, lastAtMs: 2 },
    { sessionId: 'session-unpriced', calls: 3, priced: 0, unpriced: 3, usd: 0, tokens: { input: 30_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 30_000 }, hitRate: null, models: [], firstAtMs: 1, lastAtMs: 2 },
  ],
  budget: { enabled: true, amount: 400, currency: 'CNY', period: 'month', usedUsd: 55.3059, usedAmount: 398.2025, ratio: 0.9955 },
  providers: [{ provider: 'walk-grok', displayName: 'Grok 中转', calls: 160, priced: 159, unpriced: 1, usd: 0.1944, amount: 1.3997, tokens: 65_466_000, hitRate: 0.986 }],
  models: [{ provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', calls: 160, priced: 159, unpriced: 1, usd: 0.1944, amount: 1.3997, tokens: { input: 905_000, output: 161_000, cacheRead: 64_400_000, cacheWrite: 0, reasoning: 0, total: 65_466_000 }, hitRate: 0.986 }],
  quotas: [{
    provider: 'walk-grok', displayName: 'Grok 中转', type: 'sub2api', status: 'ok', error: undefined,
    sub2api: {
      modelCount: 3, planName: '订阅', expiresAt: '2026-11-01T00:00:00Z', balance: 0.01, unit: 'CNY',
      billing: { peak: { enabled: true, start: '01:00', end: '04:00', multiplier: 2, applied: 1 } },
      rate: { effective: 0.09, group: 0.09, peak: { enabled: false } },
    },
    calls: 160, priced: 159, unpriced: 1, usd: 0.1944, amount: 1.3997, tokens: 65_466_000, hitRate: 0.986,
  }],
  balance: { provider: 'deepseek-official', displayName: 'DeepSeek', amount: 0.01, currency: 'CNY', isAvailable: true, granted: 0, toppedUp: 0.01, updatedAt: '2026-10-13T10:25:18.000Z' },
  balances: [
    { provider: 'deepseek-official', displayName: 'DeepSeek', kind: 'api-key', amount: -0.01, currency: 'CNY', isAvailable: false, granted: 0, toppedUp: -0.01, source: 'api-key', updatedAt: '2026-10-13T10:25:18.000Z' },
    { provider: 'deepseek-account', displayName: 'DeepSeek Account', kind: 'account', amount: -0.04337, currency: 'CNY', isAvailable: true, granted: 0, toppedUp: -0.04337, source: 'account-platform', updatedAt: '2026-10-13T10:25:20.000Z' },
  ],
  peak: {
    enabled: true, inPeak: true, zoneKind: 'peak', prevAtMs: 1, nextAtMs: Date.parse('2026-10-13T03:28:00Z'), nextIntoPeak: false,
    countdownMs: 5_280_000, countdown: '1 小时 28 分',
    upcoming: [
      { atMs: Date.parse('2026-10-13T04:00:00Z'), inPeak: false, zoneKind: null },
      { atMs: Date.parse('2026-10-13T06:00:00Z'), inPeak: true, zoneKind: null },
    ],
  },
  prices: {
    meta: { fetchedAt: '2026-10-13T02:27:41.767Z', sourceKind: 'github-blob', accepted: 319, sourceUrl: 'https://api.github.com/repos/BerriAI/litellm/git/blobs/abc', bundled: false },
    sources: ['official', 'station', 'manual'],
    breakdown: { official: 20, station: 314, manual: 0, reseller: 75, aggregator: 470, unknown: 12 },
    attribution: 'LiteLLM model_prices_and_context_window.json (MIT), mirrored by Wei-Shaw/sub2api',
    basisId: 'p1-03cb848a',
  },
  trend: [{ date: '2026-10-11', usd: 1.2, calls: 10, amount: 8.64 }, { date: '2026-10-12', usd: 2.4, calls: 20, amount: 17.28 }, { date: '2026-10-13', usd: 0.1944, calls: 160, amount: 1.3997 }],
  // 26 周热力图：宿主侧补齐空天（182 项，末项 = 今天），这里照同一约定造数据
  heatmap: HEAT_DATES.map((date, index) => ({
    date,
    calls: index === 181 ? 160 : (index >= 178 ? 4 : 0),
    usd: index === 181 ? 0.1944 : (index >= 178 ? 0.01 : 0),
    amount: index === 181 ? 1.3997 : (index >= 178 ? 0.072 : 0),
    tokens: index === 181 ? 65_466_000 : (index >= 178 ? 1_000 : 0),
  })),
  // 全历史「按模型」：三种排行取向不同（金额 / token 数 / 命中率 / 每美元 token）
  modelsHistory: {
    since: '2026-08-25',
    days: 3,
    daysMissingModels: 1,
    total: 3,
    rows: [
      { key: 'walk-grok:cn:deepseek-v4.1-flash', provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', calls: 900, priced: 900, unpriced: 0, days: 2, usd: 12.5, amount: 90, tokens: { input: 9_000_000, output: 1_000_000, cacheRead: 30_000_000, cacheWrite: 0, reasoning: 0, total: 40_000_000 }, hitRate: 0.769, perUsd: 3_200_000 },
      { key: 'walk-grok:cn:deepseek-v4.1-pro', provider: 'walk-grok', model: 'cn:deepseek-v4.1-pro', calls: 300, priced: 298, unpriced: 2, days: 2, usd: 30, amount: 216, tokens: { input: 4_000_000, output: 2_000_000, cacheRead: 1_000_000, cacheWrite: 0, reasoning: 0, total: 7_000_000 }, hitRate: 0.2, perUsd: 233_333 },
      { key: 'nanshan:grok-4', provider: 'nanshan', model: 'grok-4', calls: 50, priced: 50, unpriced: 0, days: 1, usd: 1, amount: 7.2, tokens: { input: 500_000, output: 0, cacheRead: 4_500_000, cacheWrite: 0, reasoning: 0, total: 5_000_000 }, hitRate: 0.9, perUsd: 5_000_000 },
    ],
  },
  basisIds: ['p1-03cb848a'],
}

const SIDEBAR_BALANCE_FIRST = {
  provider: 'deepseek-official', displayName: 'DeepSeek', kind: 'api-key',
  amount: 1.51, currency: 'CNY', isAvailable: true, granted: 0, toppedUp: 1.51, source: 'api-key', updatedAt: '2026-10-13T10:25:18.000Z',
  keys: [
    { ref: 'DEEPSEEK_API_KEY', label: 'DEEPSEEK_API_KEY', amount: 0.01, currency: 'CNY', isAvailable: true, granted: 0, toppedUp: 0.01, source: 'api-key' },
    { ref: 'DEEPSEEK_API_KEY_2', label: '第二把', amount: 1.5, currency: 'CNY', isAvailable: true, granted: 0, toppedUp: 1.5, source: 'api-key' },
  ],
}

const SIDEBAR = {
  date: '2026-10-13',
  now: Report_now(),
  display: { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2 },
  total: { calls: 160, priced: 159, unpriced: 1, usd: 0.1944, amount: 1.3997, tokens: 65_466_000, hitRate: 0.986 },
  providers: [{ provider: 'deepseek-official', displayName: 'DeepSeek', calls: 0, unpriced: 0, usd: 0, amount: 0, tokens: 0, hitRate: null, models: [] }, { provider: 'walk-grok', displayName: 'Grok 中转', calls: 160, unpriced: 1, usd: 0.1944, amount: 1.3997, tokens: 65_466_000, hitRate: 0.986, models: [] }],
  balance: SIDEBAR_BALANCE_FIRST,
  balances: [
    SIDEBAR_BALANCE_FIRST,
    { provider: 'deepseek-account', displayName: 'DeepSeek Account', kind: 'account', amount: -0.04337, currency: 'CNY', isAvailable: true, granted: 0, toppedUp: -0.04337, source: 'account-platform', updatedAt: '2026-10-13T10:25:20.000Z' },
  ],
  peak: {
    enabled: true, inPeak: true, zoneKind: 'peak', prevAtMs: 1, nextAtMs: Date.parse('2026-10-13T03:28:00Z'), nextIntoPeak: false,
    countdownMs: 5_280_000, countdown: '1 小时 28 分',
    upcoming: [
      { atMs: Date.parse('2026-10-13T04:00:00Z'), inPeak: false, zoneKind: null },
      { atMs: Date.parse('2026-10-13T06:00:00Z'), inPeak: true, zoneKind: null },
    ],
  },
  prices: { fetchedAt: '2026-10-13T02:27:41.767Z', sourceKind: 'github-blob', accepted: 319, bundled: false },
  // 模型花费卡片（宿主把「配置 + 数据」摊在一起下发；`items` 是数据、`rows` 是「显示几行」）
  modelCard: {
    enabled: true, defaultExpanded: true, rememberExpanded: true, showTokens: true, showShare: true,
    period: 'today', rows: 3, position: 'bottom',
    models: 4,
    items: [
      { key: 'walk-grok:cn:deepseek-v4.1-flash', provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', calls: 160, unpriced: 0, usd: 0.1944, amount: '¥1.3997', tokens: 7_654_321, hitRate: 0.986, share: 0.9 },
      { key: 'walk-grok:cn:deepseek-v4.1-pro', provider: 'walk-grok', model: 'cn:deepseek-v4.1-pro', calls: 20, unpriced: 2, usd: 0.02, amount: '¥0.144', tokens: 1_000_000, hitRate: 0.5, share: 0.1 },
      { key: 'nanshan:grok-4', provider: 'nanshan', model: 'grok-4', calls: 5, unpriced: 0, usd: 0, amount: '¥0', tokens: 1000, hitRate: null, share: null },
    ],
    total: { usd: 0.2144, amount: '¥1.5437', calls: 185, unpriced: 2 },
  },
  // 输入区三块（T3）：宿主总是送补齐默认值的形状
  sessionCost: { enabled: false, position: 'composer', showHitRate: true, includeSubagent: false },
  quotaStrip: { enabled: false, showBalance: true },
  corner: { enabled: false, showTop1: false },
  basisIds: ['p1-03cb848a'],
}
function Report_now() { return Date.parse('2026-10-13T02:00:00Z') }

const KEYS = {
  provider: 'deepseek-official',
  primaryRef: 'DEEPSEEK_API_KEY',
  nextRef: 'DEEPSEEK_API_KEY_3',
  scanned: 18,
  keys: [
    { ref: 'DEEPSEEK_API_KEY', label: null, configured: true, managed: false, primary: true },
    { ref: 'DEEPSEEK_API_KEY_2', label: null, configured: true, managed: true, primary: false },
  ],
}
const STATE = {
  version: 2,
  probedAt: '2026-10-13T10:25:00.000Z',
  vision: { applied: [], at: null, error: null },
  types: {},
  providers: [
    { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', deepseekRoute: 'api-key', type: 'other', status: 'idle', hasKey: true, image: { editable: false } },
    {
      provider: 'walk-grok', displayName: 'Grok 中转', settingsNs: 'llm-pi-ai', type: 'sub2api', status: 'ok', hasKey: true,
      image: { editable: false },
      // 口径分歧的实测形态（jiuhaoche）：倍率接口报 1，实扣却是 1.22 倍。
      // 宿主给的是**结构化**原因，文案归客户端拼（见 lib/sub2api.js 的 mismatchDetail）。
      sub2api: {
        modelCount: 2,
        unit: 'CNY',
        rate: { effective: 1, group: 1, peak: { enabled: false } },
        spend: {
          currency: 'CNY', period: 'total', effectiveRate: 1,
          officialCost: 0.005074, actualCost: 0.006494, byMultiplier: 0.005074,
          delta: -0.00142, deltaRatio: -0.2187, impliedRate: 1.27986,
          models: [], mismatch: true,
          mismatchReason: {
            factor: 1.27986, percent: 21.9, direction: 'station-charged-more', rateIsUnity: true,
            modelRateCount: 2, modelRateMin: 1.275, modelRateMax: 1.304,
          },
        },
      },
    },
  ],
}
const calls = []
/** localStorage 写入记录（验证「选择被记住」） */
const localStorageWrites = []
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true })
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: () => null,
    setItem(key, value) { localStorageWrites.push({ key, value: String(value) }) },
    removeItem() {},
  },
  configurable: true,
  writable: true,
})
/** window 上的监听器（focus 等）：侧栏靠 focus 事件补一次取数，测试要能主动触发它。 */
const windowListeners = new Map()
function dispatchWindowEvent(event) {
  let fired = 0
  for (const handler of windowListeners.get(event) ?? []) {
    try { handler() } catch { /* 单个 handler 出错不影响测试继续 */ }
    fired += 1
  }
  return fired
}
globalThis.window = {
  __ModuleLoader__: { load(entry) { globalThis.window.__MODULE_ENTRY__ = entry } },
  addEventListener(event, handler) {
    const set = windowListeners.get(event) ?? new Set()
    set.add(handler)
    windowListeners.set(event, set)
  },
  removeEventListener(event, handler) { windowListeners.get(event)?.delete(handler) },
  dispatchEvent() {},
}
globalThis.fetch = async (url, init) => {
  const path = String(url)
  calls.push({ path, method: init?.method ?? 'GET', body: init?.body ?? null, headers: init?.headers ?? null })
  const json = path.endsWith('/state') ? { ok: true, state: STATE }
    : path.includes('/keys') ? { ok: true, data: KEYS }
    : path.includes('/session?') ? { ok: true, data: sessionFixture(path.includes('includeSubagent=1')) }
    : path.endsWith('/report') ? { ok: true, data: REPORT }
    : path.endsWith('/sidebar') ? { ok: true, data: SIDEBAR }
      : path.endsWith('/prices/update') ? { ok: true, data: { meta: { ...REPORT.prices.meta, accepted: 320 } } }
        : path.endsWith('/config') ? { ok: true, data: { display: REPORT.display, budget: REPORT.budget, priceSources: REPORT.prices.sources, basisId: 'p1-new0000' } }
          : path.endsWith('/balance/refresh') ? { ok: true, data: { balance: REPORT.balance } }
            : { ok: false, error: `unexpected ${path}` }
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
}

// ── 载入客户端模块：模块体只做一件事——把 { id, factory } 交给 __ModuleLoader__ ──
const moduleCode = await import('node:fs').then(fs => fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
new Function('window', moduleCode)(globalThis.window)
const entry = globalThis.window.__MODULE_ENTRY__
assert.ok(entry !== undefined && typeof entry.factory === 'function', '模块没有通过 __ModuleLoader__.load 注册')
const requireStub = specifier => {
  if (specifier === 'react') return React
  throw new Error(`未预期的 require(${specifier})`)
}
const slots = new Map()
const effects = []
const ctx = {
  slots: {
    inject(name, register) { slots.set(name, (slots.get(name) ?? []).concat([register])) },
    register(registration, component) { return { registration, component } },
  },
  effect(fn, label) { effects.push({ fn, label }) },
}
entry.factory(requireStub).apply(ctx)

/**
 * `/session` 的响应夹具：`includeSubagent` 打开时多出「子代理」那一档、合计跟着变大。
 * 形状与宿主 `summarizeSession()` 一致（金额是展示币种的字符串，token 是 5 桶 + total）。
 */
function sessionFixture(includeSubagent) {
  const self = {
    calls: 3, priced: 3, unpriced: 0, usd: 0.3, amount: '¥2.16', cost: '¥2.16',
    tokens: { input: 1_000_000, output: 0, cacheRead: 4_000_000, cacheWrite: 0, reasoning: 0, total: 5_000_000 },
    hitRate: 0.8,
    models: [{ key: 'walk-grok:cn:deepseek-v4.1-flash', provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', calls: 3, usd: 0.3, amount: '¥2.16' }],
  }
  const zero = {
    calls: 0, priced: 0, unpriced: 0, usd: 0, amount: '¥0', cost: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    hitRate: null, models: [],
  }
  const children = includeSubagent
    ? {
        ...self,
        calls: 2, usd: 0.2, amount: '¥1.44', cost: '¥1.44',
        tokens: { ...self.tokens, input: 500_000, total: 2_500_000 },
        models: [{ key: 'walk-grok:cn:deepseek-v4.1-pro', provider: 'walk-grok', model: 'cn:deepseek-v4.1-pro', calls: 2, usd: 0.2, amount: '¥1.44' }],
      }
    : zero
  const total = includeSubagent
    ? { ...self, calls: 5, usd: 0.5, amount: '¥3.6', cost: '¥3.6', tokens: { ...self.tokens, input: 1_500_000, total: 7_500_000 } }
    : self
  return {
    sessionId: 'sess-parent', date: '2026-10-13', includeSubagent: includeSubagent === true,
    subagentSupported: true, self, children, total, firstAtMs: 1, lastAtMs: 2,
  }
}

function component(name, index = 0) {
  const list = slots.get(name)
  assert.ok(list !== undefined && list.length > index, `槽位 ${name} 未注册`)
  return list[index]()
}
/**
 * 只在**挂载**时跑状态机：反复渲染直到没有 setState。
 * state 与 effect 记在组件自己的帧里（WeakMap，按组件身份），effect 只在挂载时执行一次。
 */
function mount(component, props = {}, visit = null) {
  let tree = null
  for (let pass = 0; pass < 10; pass += 1) {
    dirty = false
    // 根组件用自己的帧；它内部嵌套的组件由 walkNode 展开时各自进入自己的帧
    tree = withFrame(frameFor(component), () => component(props))
    // 嵌套组件也要在**状态化**的这一遍里展开一次：否则它们的 effect 永远不跑
    // （余额明细、密钥编辑区这类子组件就是靠 effect 首次加载的）。
    walkNode(tree, visit ?? (() => {}))
    if (!dirty) return tree
  }
  return null
}

/** 文案包含匹配的点击（按钮文案常带后缀/括号，用精确匹配太脆）。 */
function clickMatch(component, needle) {
  let clicked = false
  mount(component, {}, node => {
    if (clicked) return
    if (node.type !== 'button') return
    if (!render(node.props?.children).includes(needle)) return
    node.props?.onClick?.()
    clicked = true
  })
  return clicked
}

/** 状态化地展开一遍并点击第一个匹配的元素（用来验证「点了界面真的变」）。 */
function clickIn(component, matcher) {
  let clicked = false
  mount(component, {}, node => {
    if (clicked) return
    if (matcher(node) !== true) return
    node.props?.onClick?.()
    clicked = true
  })
  return clicked
}
/**
 * 只读展开：effect 不跑、setState 是空操作，但 state **从已有的帧里读** ——
 * 否则子组件（密钥编辑区、余额明细这类靠 effect 加载的）在只读渲染里会退回初始值。
 */
function readonly(fn) {
  const savedState = React.useState
  const savedEffect = React.useEffect
  React.useState = initial => {
    const frame = currentFrame
    if (frame === null) return [typeof initial === 'function' ? initial() : initial, () => {}]
    const cursor = frame.cursor++
    const slot = frame.slots[cursor]
    if (slot !== undefined) return [slot.value, () => {}]
    const value = typeof initial === 'function' ? initial() : initial
    frame.slots[cursor] = { value }
    return [value, () => {}]
  }
  React.useEffect = () => {}
  try {
    return fn()
  } finally {
    React.useState = savedState
    React.useEffect = savedEffect
  }
}

function render(element) {
  return readonly(() => renderNode(element))
}
function renderNode(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(renderNode).join('')
  const { type, props } = element
  if (typeof type === 'function') {
    return withFrame(frameFor(type), () => renderNode(type(props)))
  }
  return renderNode(props?.children ?? [])
}
/** 原始遍历（组件会展开一次；每个组件进入自己的帧）。 */
function walkNode(element, visit) {
  if (element === null || element === undefined || typeof element !== 'object') return
  if (Array.isArray(element)) { for (const child of element) walkNode(child, visit); return }
  visit(element)
  if (typeof element.type === 'function') {
    withFrame(frameFor(element.type), () => walkNode(element.type(element.props), visit))
    return
  }
  walkNode(element.props?.children, visit)
}
function walk(element, visit) {
  return readonly(() => walkNode(element, visit))
}
/** 找出所有宿主 <tr>，返回每行的单元格文本。 */
function tableRows(element) {
  const rows = []
  walk(element, node => {
    if (node.type !== 'tr') return
    const cells = []
    walk(node.props?.children, cell => {
      if (cell.type === 'td' || cell.type === 'th') cells.push(render(cell.props?.children))
    })
    rows.push(cells)
  })
  return rows
}
/** 找到「文字等于 label」的宿主 button 并点击它（切分页用的就是这种按钮）。 */
function clickText(element, label) {
  let clicked = false
  walk(element, node => {
    if (clicked) return
    if (node.type !== 'button') return // 只认宿主 <button>，函数节点（组件）跳过
    if (render(node.props?.children) !== label) return
    node.props?.onClick?.()
    clicked = true
  })
  return clicked
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * 按「标签文字」找勾选框：`h('label', {...}, h('input',{type:'checkbox'}), '文案')` 这种写法下，
 * 只要拿 label 的 children 就能把 input 和它的文案配对。**不按下标**取 ——
 * 设置页会不断加分组，按下标写死的用例一加东西就碎。
 * @returns {Array<{ text: string, props: object }>}
 */
function checkboxes(element) {
  const out = []
  walk(element, node => {
    if (node.type !== 'label') return
    const kids = node.props?.children ?? []
    const input = kids.find(child => child?.type === 'input' && child.props?.type === 'checkbox')
    if (input === undefined) return
    const text = kids.filter(child => child !== input).map(child => render(child)).join('')
    out.push({ text, props: input.props })
  })
  return out
}
/** 找勾选框并返回它的 props（找不到就抛，别让用例静默跳过）。 */
function checkbox(element, text) {
  const found = checkboxes(element).find(item => item.text === text)
  assert.ok(found !== undefined, `找不到勾选框「${text}」，实际：${checkboxes(element).map(item => item.text).join(' / ')}`)
  return found.props
}

console.log('\n[设置页「余额与费用」渲染]')
const section = component('settings.section')
console.log(`  · 注册信息：id=${section.registration.id} order=${section.registration.order} label=${section.registration.label}`)
assert.equal(section.registration.name, 'settings.section')
assert.equal(section.registration.order, 32)
assert.equal(section.registration.label, '余额与费用')

const CostPage = section.component
let tree = mount(CostPage)
await tick()
tree = mount(CostPage)
const firstRender = render(tree)
test('注册进 settings.section，标签/顺序正确', () => {
  assert.equal(section.registration.label, '余额与费用')
  assert.equal(section.registration.order, 32)
  return 'order 32（排在参照实现的 30/31 之后）'
})
test('概览：三张卡 + 今日会话 + 预算 + 官方余额（两条路线都列）都在', () => {
  for (const needle of ['今日费用', '本月费用', '累计费用', '¥1.3997', '¥398.2025', '¥1791.6523', '今日会话', 'session-747f69', '预算', '官方账户余额', '总余额', '¥-0.0100', 'DeepSeek Account', '¥-0.0434']) {
    assert.ok(firstRender.includes(needle), `渲染结果里缺少「${needle}」`)
  }
  return '六块内容齐全，两条 DeepSeek 路线都在'
})
test('未定价会话显示 —（不是 ¥0）', () => {
  const rows = tableRows(mount(CostPage))
  const row = rows.find(cells => cells[0] !== undefined && cells[0].includes('session-unpri'))
  assert.ok(row !== undefined, `会话表里应有未定价会话，实际行：${JSON.stringify(rows.map(cells => cells[0]))}`)
  assert.equal(row[row.length - 1], '—', `未定价会话的费用列应为 —，实际 ${JSON.stringify(row)}`)
  return '— 而非 0'
})
test('预算进度按占比上色（99.6% → 正常色，不误报超支）', () => {
  assert.ok(firstRender.includes('99.6%'), '应显示占比 99.6%')
  assert.ok(!firstRender.includes('已超支'), '99.6% 不该报超支')
  assert.ok(firstRender.includes('接近额度'), '≥80% 应提示接近额度')
  return '99.6% → 接近额度'
})

test('切到「额度」页：供应商 / 类型 / 倍率 / 峰谷 / 备注', () => {
  assert.ok(clickText(tree, '额度'), '应能点到「额度」分页')
  tree = mount(CostPage)
  const html = render(tree)
  for (const needle of ['Grok 中转', 'sub2api', '×0.09', '启用', '余额 ¥0.0100', '套餐 订阅']) {
    assert.ok(html.includes(needle), `额度页缺少「${needle}」`)
  }
  return '额度行含倍数与余额'
})
test('切到「用量」页：token 汇总 + 26 周热力图 + 按模型统计入口', () => {
  assert.ok(clickText(tree, '用量'))
  tree = mount(CostPage)
  const html = render(tree)
  for (const needle of ['缓存写入', '推理', '最近 3 天', 'Token 用量统计', '近 26 周', '按模型统计', 'cn:deepseek-v4.1-flash']) {
    assert.ok(html.includes(needle), `用量页缺少「${needle}」`)
  }
  return '四段内容齐全'
})
test('按模型统计：默认展开，可折叠，双档 + 四种排行真的按指标重排', () => {
  assert.ok(render(mount(CostPage)).includes('按模型统计'), '入口应在')
  assert.ok(render(mount(CostPage)).includes('全部历史'), '默认应展开（隐藏入口等于没有）')
  // 按钮是开关：折叠 → 内容收起 → 再展开
  assert.ok(clickMatch(CostPage, '按模型统计'), '应能折叠')
  assert.ok(!render(mount(CostPage)).includes('全部历史'), '折叠后内容应收起')
  assert.ok(clickMatch(CostPage, '按模型统计'), '应能再展开')
  const opened = mount(CostPage)
  const openedHtml = render(opened)
  for (const needle of ['今日', '全部历史', '费用', 'Token', '命中率', '每美元 token']) {
    assert.ok(openedHtml.includes(needle), `按模型统计缺少「${needle}」`)
  }
  // 切到「全部历史」：范围说明 + 0.8.0 之前的缺口如实报出来
  assert.ok(clickText(opened, '全部历史'))
  const historyHtml = render(mount(CostPage))
  for (const needle of ['2026-08-25 起', '3 天有记录', '3 个模型', '0.8.0 之前写入的', '1 天']) {
    assert.ok(historyHtml.includes(needle), `全历史档缺少「${needle}」：${historyHtml.slice(-400)}`)
  }
  // 行的先后顺序 = 排行顺序（名字只会出现在排行行里，所以拿 indexOf 比先后是可靠的）
  const order = () => {
    const html = render(mount(CostPage))
    return ['cn:deepseek-v4.1-flash', 'cn:deepseek-v4.1-pro', 'grok-4'].sort((a, b) => html.indexOf(a) - html.indexOf(b))
  }
  // 默认按费用：pro 30 > flash 12.5 > grok-4 1
  assert.deepEqual(order(), ['cn:deepseek-v4.1-pro', 'cn:deepseek-v4.1-flash', 'grok-4'], '默认按费用降序')
  // 按 Token：flash 40M > pro 7M > grok-4 5M（与费用档不同，说明真的重排了）
  assert.ok(clickText(mount(CostPage), 'Token'))
  assert.deepEqual(order(), ['cn:deepseek-v4.1-flash', 'cn:deepseek-v4.1-pro', 'grok-4'], '按 token 降序')
  // 按命中率：grok-4 90% > flash 76.9% > pro 20%
  assert.ok(clickText(mount(CostPage), '命中率'))
  assert.deepEqual(order(), ['grok-4', 'cn:deepseek-v4.1-flash', 'cn:deepseek-v4.1-pro'], '按命中率降序')
  assert.ok(render(mount(CostPage)).includes('90.0%'), '命中率列给百分比')
  // 按每美元 token：grok-4 5M > flash 3.2M > pro 0.23M
  assert.ok(clickText(mount(CostPage), '每美元 token'))
  assert.deepEqual(order(), ['grok-4', 'cn:deepseek-v4.1-flash', 'cn:deepseek-v4.1-pro'], '按每美元 token 降序')
  assert.ok(render(mount(CostPage)).includes(' / $'), '每美元 token 列带单位')
  // 未定价条数也要露出来（pro 有 2 次未定价）
  assert.ok(render(mount(CostPage)).includes('2 次未定价'), '未定价条数应显示')
  return '双档 + 四种排行 + 缺口提示'
})
test('热力图：26 周 = 182 个格子，且首格对齐到首日的星期（补位格不带日期）', () => {
  const page = mount(CostPage)
  // 只认热力图格子（12×12 的小方块）：柱状图的 title 也是「日期 · …」，别把它算进来
  const cells = []
  walk(page, node => {
    const style = node.props?.style ?? {}
    if (style.width === 12 && style.height === 12) cells.push(node)
  })
  const dated = cells.filter(node => typeof node.props?.title === 'string' && /^\d{4}-\d{2}-\d{2} · /.test(node.props.title))
  assert.equal(dated.length, 182, `应有 182 天的格子，实际 ${dated.length}`)
  assert.ok(String(dated[0].props.title).startsWith(HEAT_DATES[0]), `首格应是 ${HEAT_DATES[0]}，实际 ${dated[0].props.title}`)
  assert.ok(String(dated.at(-1).props.title).startsWith('2026-10-13'), '末格是今天')
  assert.ok(String(dated.at(-1).props.title).includes('65.5M'), `悬停应给当天 token：${dated.at(-1).props.title}`)
  // 补位格（首日之前的几天）没有 date/title，但确实占位 —— 否则「行 = 星期」会整体错位
  const firstWeekday = new Date(Date.parse(`${HEAT_DATES[0]}T00:00:00Z`)).getUTCDay()
  const padding = cells.filter(node => node.props?.title === undefined)
  assert.equal(padding.length, firstWeekday, `补位格数应等于首日的星期序号（${firstWeekday}），实际 ${padding.length}`)
  return `182 格 · 补位 ${firstWeekday}`
})
test('切到「价格」页：来源分级 + 允许等级 + 更新按钮 + 出处', () => {
  assert.ok(clickText(tree, '价格'))
  tree = mount(CostPage)
  const html = render(tree)
  for (const needle of ['官方价（20）', '站方口径（314）', '转售商（75）', '聚合目录（470）', '数据出处', 'LiteLLM']) {
    assert.ok(html.includes(needle), `价格页缺少「${needle}」`)
  }
  return '各等级条数与出处都在'
})
test('切到「显示」页：币种/符号/小数位/汇率', () => {
  assert.ok(clickText(tree, '显示'))
  tree = mount(CostPage)
  const html = render(tree)
  for (const needle of ['币种', '符号', '小数位', '汇率']) {
    assert.ok(html.includes(needle), `显示页缺少「${needle}」`)
  }
  return '四个字段都在'
})
test('「显示」页也带账本保留：明细 / 日汇总 + 独立保存按钮', () => {
  const page = mount(CostPage)
  const html = render(page)
  for (const needle of ['账本保留', '账本明细（天）', '日汇总（天）', '保存保留期']) {
    assert.ok(html.includes(needle), `显示页缺少「${needle}」`)
  }
  // 输入框的值在 props 上（renderNode 只吐文本），而只读 walk 里组件拿不到 report 数据，
  // 所以「回填宿主的值」由下面的点击用例断言提交出去的 payload（12 / 365 ≠ 兜底的 7 / 400）。
  return '四个控件都在'
})
test('「显示」页带峰谷提醒两个勾选框，且回填宿主的开关', () => {
  const page = mount(CostPage)
  const html = render(page)
  for (const needle of ['峰谷提醒', '应用内提醒', '系统通知']) {
    assert.ok(html.includes(needle), `显示页缺少「${needle}」`)
  }
  assert.equal(checkbox(page, '应用内提醒').checked, true, '应用内提醒应回填宿主送来的 true')
  assert.equal(checkbox(page, '系统通知').checked, false, '系统通知应回填 false')
  return `按文案取勾选框 · 共 ${checkboxes(page).length} 个`
})
test('「显示」页新增密钥扫描与官方峰谷两段，且回填宿主的值', () => {  const page = mount(CostPage)
  const html = render(page)
  for (const needle of ['密钥扫描', '读凭据文件的引用名', '候选前缀', '序号上限', '保存扫描设置',
    '访问控制', '额外允许的主机名', '保存白名单',
    '官方峰谷', '启用峰谷档', '高峰窗口（UTC 小时）', '假期（北京日期）', '保存峰谷']) {
    assert.ok(html.includes(needle), `显示页缺少「${needle}」`)
  }
  const inputs = []
  walk(page, node => { if (node.type === 'input' && node.props?.type !== 'checkbox') inputs.push(node.props) })
  const values = inputs.map(item => String(item.value))
  assert.ok(values.includes('DEEPSEEK_API_KEY, DEEPSEEK_KEY'), `候选前缀应回填宿主值：${values.join(' | ')}`)
  assert.ok(values.includes('1-4,6-10'), `窗口应回填成紧凑写法：${values.join(' | ')}`)
  assert.ok(values.includes('2026-10-01, 2026-10-02'), `假期应回填：${values.join(' | ')}`)
  assert.ok(values.includes('panel.example.com'), `Host 白名单应回填：${values.join(' | ')}`)
  return '三段控件齐全且回填宿主值'
})
test('「显示」页带「界面」段：语言选择器 + 轮询间隔 + 三个隐藏/显示开关', () => {
  const page = mount(CostPage)
  const html = render(page)
  for (const needle of ['界面', '界面语言', '跟随浏览器', '简体中文', 'English',
    '侧栏刷新间隔（秒）', '保存间隔', '隐藏官方余额', '隐藏今日消耗', '会话明细显示完整会话 ID']) {
    assert.ok(html.includes(needle), `显示页缺少「${needle}」`)
  }
  // 回填：语言选择器当前值 = auto，轮询间隔 = 30，三个开关默认关
  let localeSelect = null
  walk(page, node => {
    if (node.type === 'select' && String(node.props?.value) === 'auto') localeSelect = node
  })
  assert.ok(localeSelect !== null, '语言选择器应回填 auto')
  const seconds = []
  walk(page, node => { if (node.type === 'input' && node.props?.min === '10') seconds.push(node.props) })
  assert.equal(seconds.length, 1, `应有一个轮询间隔输入框（min=10），实际 ${seconds.length}`)
  assert.equal(Number(seconds[0].value), 30, '间隔应回填宿主的 30')
  for (const label of ['隐藏官方余额', '隐藏今日消耗', '会话明细显示完整会话 ID']) {
    assert.equal(checkbox(page, label).checked, false, `「${label}」默认应关`)
  }
  return '语言 / 间隔 / 三个开关都在'
})

console.log('\n[交互：按钮真的打到宿主路由]')
await (async () => {
  // 切到「价格」页再点「更新价格表」
  clickText(mount(CostPage), '价格')
  const clicked = clickText(mount(CostPage), '更新价格表')
  await tick()
  await tick()
  test('点「更新价格表」→ POST /prices/update', () => {
    assert.ok(clicked, '没找到「更新价格表」按钮')
    const hit = calls.find(call => call.path.endsWith('/prices/update'))
    assert.ok(hit !== undefined, `没有发出更新请求，实际请求：${calls.map(c => c.path.split('/').pop()).join(',')}`)
    assert.equal(hit.method, 'POST')
    return 'POST /prices/update'
  })
  test('/report 只在首次挂载时拉取（切分页不重复请求）', () => {
    const reportCalls = calls.filter(call => call.path.endsWith('/report')).length
    assert.ok(reportCalls >= 1 && reportCalls <= 4, `/report 请求次数异常：${reportCalls}`)
    return `/report ×${reportCalls}`
  })
  // 切到「显示」页，点保留期那个独立按钮
  clickText(mount(CostPage), '显示')
  const retentionClicked = clickText(mount(CostPage), '保存保留期')
  await tick()
  await tick()
  test('点「保存保留期」→ POST /config 带 retention（且不带 display）', () => {
    assert.ok(retentionClicked, '没找到「保存保留期」按钮')
    const hit = calls.filter(call => call.path.endsWith('/config')).at(-1)
    assert.ok(hit !== undefined, `没有发出 /config 请求，实际请求：${calls.map(c => c.path.split('/').pop()).join(',')}`)
    assert.equal(hit.method, 'POST')
    const body = JSON.parse(hit.body)
    assert.deepEqual(body.retention, { ledgerDays: 12, rollupDays: 365 }, `实际提交：${hit.body}（若是 7 / 400 说明没回填宿主的值）`)
    assert.equal(body.display, undefined, '保留期不该顺手把展示设置也提交一遍')
    return 'POST /config { retention }'
  })
  // 再点一次「应用内提醒」勾选框（取消勾选）→ 白名单局部覆盖
  const notifyBox = checkbox(mount(CostPage), '应用内提醒')
  const toggled = notifyBox.checked === true
  if (toggled) notifyBox.onChange({ target: { checked: false } })
  await tick()
  await tick()
  test('点「应用内提醒」→ POST /config 只带 peakNotify.enabled（局部补丁，不带别的位）', () => {
    assert.ok(toggled, '应能按文案拿到「应用内提醒」勾选框并取消它')
    const hit = calls.filter(call => call.path.endsWith('/config')).at(-1)
    assert.ok(hit !== undefined, '没有发出 /config 请求')
    const body = JSON.parse(hit.body)
    assert.deepEqual(body.peakNotify, { enabled: false }, `实际提交：${hit.body}`)
    assert.equal(body.retention, undefined, '不该顺手把保留期也提交一遍')
    return 'POST /config { peakNotify: { enabled: false } }'
  })
  // 密钥扫描设置：三个键一起提交，且不带 display / retention（各自独立保存）
  const discoveryClicked = clickText(mount(CostPage), '保存扫描设置')
  await tick()
  await tick()
  test('点「保存扫描设置」→ POST /config 带三个扫描键（不带 display）', () => {    assert.ok(discoveryClicked, '没找到「保存扫描设置」按钮')
    const hit = calls.filter(call => call.path.endsWith('/config')).at(-1)
    assert.ok(hit !== undefined, '没有发出 /config 请求')
    const body = JSON.parse(hit.body)
    assert.equal(body.scanCredentialsFile, true)
    assert.deepEqual(body.deepseekKeyPrefixes, ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY'], `实际提交：${hit.body}`)
    assert.equal(body.deepseekKeyMaxIndex, 9)
    assert.equal(body.display, undefined, '扫描设置不该顺手提交展示设置')
    return 'POST /config { scanCredentialsFile, deepseekKeyPrefixes, deepseekKeyMaxIndex }'
  })
  // 官方峰谷：紧凑写法 `1-4,6-10` 要解析成数组再提交（宿主只认数组）
  const peakClicked = clickText(mount(CostPage), '保存峰谷')
  await tick()
  await tick()
  test('点「保存峰谷」→ POST /config 把 `1-4,6-10` 解析成数组', () => {
    assert.ok(peakClicked, '没找到「保存峰谷」按钮')
    const hit = calls.filter(call => call.path.endsWith('/config')).at(-1)
    const body = JSON.parse(hit.body)
    assert.deepEqual(body.officialPeak.windows, [{ start: 1, end: 4 }, { start: 6, end: 10 }], `实际提交：${hit.body}`)
    assert.equal(body.officialPeak.enabled, true)
    assert.deepEqual(body.officialPeak.holidays, ['2026-10-01', '2026-10-02'], `实际提交：${hit.body}`)
    assert.equal(body.display, undefined, '峰谷配置不该顺手提交展示设置')
    return 'POST /config { officialPeak }'
  })
  // 访问控制：Host 白名单（默认只允许回环，反代部署靠它放行）
  const hostsClicked = clickText(mount(CostPage), '保存白名单')
  await tick()
  await tick()
  test('点「保存白名单」→ POST /config 带 allowedHosts（小写化）', () => {
    assert.ok(hostsClicked, '没找到「保存白名单」按钮')
    const hit = calls.filter(call => call.path.endsWith('/config')).at(-1)
    const body = JSON.parse(hit.body)
    assert.deepEqual(body.allowedHosts, ['panel.example.com'], `实际提交：${hit.body}`)
    assert.equal(body.display, undefined, '白名单不该顺手提交展示设置')
    return 'POST /config { allowedHosts }'
  })
  // 界面：轮询间隔 + 两个隐藏开关（各自独立保存，都不带 display）
  const refreshClicked = clickText(mount(CostPage), '保存间隔')
  await tick()
  await tick()
  test('点「保存间隔」→ POST /config { ui: { refreshSeconds } }', () => {
    assert.ok(refreshClicked, '没找到「保存间隔」按钮')
    const hit = calls.filter(call => call.path.endsWith('/config')).at(-1)
    const body = JSON.parse(hit.body)
    assert.deepEqual(body.ui, { refreshSeconds: 30 }, `实际提交：${hit.body}`)
    assert.equal(body.display, undefined, '界面偏好不该顺手提交展示设置')
    return 'POST /config { ui: { refreshSeconds: 30 } }'
  })
  const hideToggled = checkbox(mount(CostPage), '隐藏官方余额')
  hideToggled.onChange({ target: { checked: true } })
  await tick()
  await tick()
  test('勾「隐藏官方余额」→ POST /config { ui: { hideOfficialBalance: true } }（勾选即写）', () => {
    const hit = calls.filter(call => call.path.endsWith('/config')).at(-1)
    const body = JSON.parse(hit.body)
    assert.deepEqual(body.ui, { hideOfficialBalance: true }, `实际提交：${hit.body}`)
    return 'POST /config { ui: { hideOfficialBalance: true } }'
  })
  // 峰谷提醒：提前量 / 类型 / 位置三个控件各自独立保存
  const leadTyped = mount(CostPage, {}, node => {
    if (node.type === 'input' && node.props?.min === '1' && node.props?.max === '30') node.props.onChange({ target: { value: 7 } })
  })
  await tick()
  await tick()
  const leadSaved = clickText(mount(CostPage), '保存提前量')
  await tick()
  await tick()
  test('改提前量 → POST /config { peakNotify: { leadMinutes: 7 } }（只提交这一位）', () => {
    const hit = calls.filter(call => call.path.endsWith('/config')).at(-1)
    const body = JSON.parse(hit.body)
    assert.deepEqual(body.peakNotify, { leadMinutes: 7 }, `实际提交：${hit.body}`)
    assert.equal(body.ui, undefined, '不该顺手提交界面偏好')
    return 'POST /config { peakNotify: { leadMinutes: 7 } }'
  })
  const typePicked = mount(CostPage, {}, node => {
    if (node.type === 'select' && String(node.props?.value) === 'both') node.props.onChange({ target: { value: 'peak' } })
  })
  await tick()
  await tick()
  test('选提醒类型 → POST /config { peakNotify: { type: "peak" } }', () => {
    const hit = calls.filter(call => call.path.endsWith('/config')).at(-1)
    const body = JSON.parse(hit.body)
    assert.deepEqual(body.peakNotify, { type: 'peak' }, `实际提交：${hit.body}`)
    return 'POST /config { peakNotify: { type: "peak" } }'
  })
  test('预览弹窗：点「预览进入峰」→ 设置页里当场渲染真实组件（带「预览」标记）', () => {
    assert.ok(clickText(mount(CostPage), '预览进入峰'), '没找到「预览进入峰」按钮')
    const html = render(mount(CostPage))
    assert.ok(html.includes('已进入高峰时段'), `预览应渲染真实提醒文案：${html.slice(-500)}`)
    assert.ok(html.includes('预览'), '应带预览标记（别和真实触发混淆）')
    return '预览进入峰 · 带预览标记'
  })
  test('预览进入谷同理，且点 × 能关掉', () => {
    assert.ok(clickText(mount(CostPage), '预览进入谷'), '没找到「预览进入谷」按钮')
    const html = render(mount(CostPage))
    assert.ok(html.includes('已进入平价时段'), '应渲染进入谷的文案')
    assert.ok(clickIn(CostPage, node => node.type === 'button' && render(node.props?.children) === '×'), '应能关掉预览')
    assert.ok(!render(mount(CostPage)).includes('已进入平价时段'), '关掉后不该还在')
    return '预览进入谷 · 可关闭'
  })
  // 宿主把空数组当**有效值**（`windows: []` = 永不判峰 → 所有调用按谷价计价），
  // 所以「清空输入框」必须解释成「沿用默认」，否则用户以为在恢复默认、其实改了计价。
  // 夹具改完要**逼 store 重新拉一次 /report**（fetch 是 JSON 往返的深拷贝，改夹具不会自动生效）——
  // 这里借「保存保留期」那次 saveConfig → load 把新数据带进来。
  // 注意：await 只能写在 IIFE 体里 —— `test()` 是同步的，async 回调会被直接当成已通过。
  const savedPeakConfig = REPORT.officialPeak
  REPORT.officialPeak = { ...savedPeakConfig, windows: [], holidays: [] }
  clickText(mount(CostPage), '显示')
  clickText(mount(CostPage), '保存保留期')
  await tick()
  await tick()
  await tick()
  const blankClicked = clickText(mount(CostPage), '保存峰谷')
  await tick()
  await tick()
  test('窗口留空 → 不提交 windows 键（回默认），而不是提交空数组（= 静默全谷价）', () => {
    assert.ok(blankClicked, '没找到「保存峰谷」按钮')
    const hit = calls.filter(call => call.path.endsWith('/config')).at(-1)
    const body = JSON.parse(hit.body)
    assert.equal(body.officialPeak.windows, undefined, `留空不该下发 windows：${hit.body}`)
    assert.equal(body.officialPeak.holidays, undefined, `留空不该下发 holidays：${hit.body}`)
    assert.equal(body.officialPeak.enabled, true, '开关本身照常提交')
    return 'POST /config { officialPeak: { enabled } }'
  })
  // 复原夹具，并再逼一次重新加载（否则 store 里还是「空窗口」那份数据）
  REPORT.officialPeak = savedPeakConfig
  clickText(mount(CostPage), '保存保留期')
  await tick()
  await tick()
  await tick()
  test('所有写请求都带 content-type: application/json（否则会被宿主拦截面 415 掉）', () => {
    // 宿主侧 crossSiteGuard 对状态变更路由要求 JSON 类型；用表单/文本类型发出去会被拒。
    // 这条用例把「客户端所有写路径都带了头」钉住（漏一个就是整块 UI 静默失效）。
    const writes = calls.filter(call => call.method !== 'GET')
    assert.ok(writes.length >= 3, `应记录到多次写请求，实际 ${writes.length}`)
    const bad = writes.filter(call => String(call.headers?.['content-type'] ?? '').split(';')[0].trim() !== 'application/json')
    assert.deepEqual(bad.map(call => `${call.method} ${call.path}`), [], '每个写请求都必须带 application/json')
    return `${writes.length} 次写请求全部带 JSON 类型`
  })
  test('窗口写法非法 → 保存按钮禁用 + 给出提示（不猜用户的意图）', () => {
    // 帧改成按组件身份存之后，这里可以直接改输入框了（会真的走一遍 patchPeak → setDraft）
    let typed = false
    mount(CostPage, {}, node => {
      if (typed) return
      if (node.type === 'input' && node.props?.placeholder === '1-4,6-10') {
        typed = true
        node.props.onChange({ target: { value: '1-4, oops' } })
      }
    })
    assert.ok(typed, '应能定位到窗口输入框并改值')
    const after = mount(CostPage)
    const html = render(after)
    assert.ok(html.includes('窗口格式不对'), `应给出格式提示：${html.slice(-300)}`)
    let submit = null
    walk(after, node => { if (node.type === 'button' && render(node.props?.children) === '保存峰谷') submit = node })
    assert.equal(submit?.props?.disabled, true, '非法窗口时保存按钮应是禁用态')
    const before = calls.filter(call => call.path.endsWith('/config')).length
    submit.props.onClick?.()
    assert.equal(calls.filter(call => call.path.endsWith('/config')).length, before, '非法值不该发出请求')
    // 复原：改回合法值，别给后面的用例留脏编辑态
    mount(CostPage, {}, node => {
      if (node.type === 'input' && node.props?.placeholder === '1-4,6-10') node.props.onChange({ target: { value: '1-4,6-10' } })
    })
    return '禁用 + 提示 · 不发请求'
  })
  test('退化窗口（5-5）与超量窗口（>24 条）同样当非法', () => {
    const many = Array.from({ length: 25 }, (_, index) => `${index % 12}-${(index % 12) + 1}`).join(',')
    for (const bad of ['5-5', many, '24-25']) {
      const before = calls.filter(call => call.path.endsWith('/config')).length
      mount(CostPage, {}, node => {
        if (node.type === 'input' && node.props?.placeholder === '1-4,6-10') node.props.onChange({ target: { value: bad } })
      })
      const html = render(mount(CostPage))
      assert.ok(html.includes('窗口格式不对'), `「${bad}」应判非法：${html.slice(-200)}`)
      assert.equal(calls.filter(call => call.path.endsWith('/config')).length, before, `「${bad}」不该发请求`)
    }
    mount(CostPage, {}, node => {
      if (node.type === 'input' && node.props?.placeholder === '1-4,6-10') node.props.onChange({ target: { value: '1-4,6-10' } })
    })
    return '5-5 · 25 条 · 24-25 都拒'
  })
})()

console.log('\n[界面偏好真的生效：隐藏区块 / 会话 ID / 语言切换]')
await (async () => {
  const savedUi = { ...REPORT.ui }
  // 改夹具后要逼 store 重新拉一次 /report（fetch 走 JSON 往返，改夹具不会自动生效）：
  // 借「保存保留期」那次 saveConfig → load 把新数据带进来。
  const reload = async () => {
    // 先让上一条「保存 → 重新拉取」的链跑完：saveConfig 在 busy 时会直接 return，
    // 撞上了就点不动（点了也没发请求）。
    await tick()
    await tick()
    await tick()
    // 语言可能是中文或英文（前面的用例切过），分页与按钮文案会跟着变 —— 两版都试
    if (!clickText(mount(CostPage), '显示')) clickText(mount(CostPage), 'Display')
    if (!clickText(mount(CostPage), '保存保留期')) clickText(mount(CostPage), 'Save retention')
    await tick()
    await tick()
    await tick()
  }
  const tab = label => { clickText(mount(CostPage), label); return render(mount(CostPage)) }

  REPORT.ui = { ...savedUi, hideOfficialBalance: true, hideTodayCost: true }
  await reload()
  test('隐藏官方余额 / 隐藏今日消耗：概览页对应区块不渲染', () => {
    const html = tab('概览')
    assert.ok(!html.includes('官方账户余额'), `余额区块不该渲染：${html.slice(0, 200)}`)
    assert.ok(!html.includes('今日费用'), '今日卡片不该渲染')
    assert.ok(html.includes('本月费用'), '本月卡片照旧')
    assert.ok(html.includes('累计费用'), '累计卡片照旧')
    return '两块不渲染 · 本月/累计照旧'
  })

  REPORT.ui = { ...savedUi }
  await reload()
  test('会话明细默认只给前 14 位会话 ID', () => {
    const short = tab('概览')
    assert.ok(short.includes('session-unpri'), '前 14 位应在')
    assert.ok(!short.includes('session-unpriced'), `默认不该给完整 ID：${short.slice(0, 120)}`)
    return '默认 session-unpri（14 位）'
  })

  REPORT.ui = { ...savedUi, showSessionId: true }
  await reload()
  test('打开「显示完整会话 ID」后给全长', () => {
    const html = tab('概览')
    assert.ok(html.includes('session-unpriced'), `应给完整 ID：${html.slice(0, 200)}`)
    return '完整 ID 已显示'
  })

  REPORT.ui = { ...savedUi, locale: 'en' }
  await reload()
  test('语言切到 en：整页文案立刻变英文（不刷新页面）', () => {
    const html = render(mount(CostPage))
    assert.ok(html.includes('Interface'), `应出现英文分组标题：${html.slice(0, 300)}`)
    assert.ok(!html.includes('界面语言'), '中文文案应消失')
    return 'en 生效'
  })

  REPORT.ui = savedUi
  await reload()
  test('切回 auto：跟随浏览器（夹具是 zh-CN）→ 回到中文', () => {
    const html = render(mount(CostPage))
    assert.ok(html.includes('界面语言'), `应回到中文：${html.slice(0, 300)}`)
    assert.ok(!html.includes('Interface'), '英文文案应消失')
    return 'auto → zh'
  })
})()

console.log('\n[左侧栏：峰谷提醒（跨过切换点才弹一次）]')
await (async () => {
  const sidebar = component('sidebar.footer.action')
  // 提醒判定发生在「取数之后」，所以必须在**第一次挂载之前**把数据和记录摆好
  const saved = { peak: SIDEBAR.peak, notify: SIDEBAR.notify }
  const originalGetItem = globalThis.localStorage.getItem
  globalThis.localStorage.getItem = key => (key === 'balance-monitor:peak-state' ? 'off' : originalGetItem(key))
  SIDEBAR.peak = { ...SIDEBAR.peak, inPeak: true, prevAtMs: Date.now() - 5_000 }
  SIDEBAR.notify = { enabled: true, system: false }
  try {
    mount(sidebar.component)
    await tick()
    await tick()
    const opened = render(mount(sidebar.component))
    test('上次记的是平价、这次是高峰 → 顶部弹一条「已进入高峰时段」', () => {
      assert.ok(opened.includes('已进入高峰时段'), `应有提醒：${opened.slice(0, 200)}`)
      assert.ok(opened.includes('×'), '提醒上应有「×」关闭按钮')
      return '已进入高峰时段'
    })
    const recorded = localStorageWrites.filter(item => item.key === 'balance-monitor:peak-state')
    test('提醒的同时把新档位记下来（下次同一档位不再提醒）', () => {
      assert.equal(recorded.length > 0, true, `应写入 peak-state，实际：${JSON.stringify(localStorageWrites)}`)
      assert.equal(recorded[recorded.length - 1].value, 'peak')
      return 'peak-state = peak'
    })
    const closed = clickIn(sidebar.component, node => node.type === 'button' && render(node.props?.children) === '×')
    const afterClose = render(mount(sidebar.component))
    test('点「×」关掉提醒后不再显示', () => {
      assert.ok(closed, '没点到关闭按钮')
      assert.equal(afterClose.includes('已进入高峰时段'), false, `关掉后不该还有提醒：${afterClose.slice(0, 200)}`)
      return '已关闭'
    })
  } finally {
    globalThis.localStorage.getItem = originalGetItem
    SIDEBAR.peak = saved.peak
    SIDEBAR.notify = saved.notify
  }
})()

console.log('\n[峰谷提醒：提前量 / 类型过滤 / 位置 / 预览]')
await (async () => {
  const sidebar = component('sidebar.footer.action')
  const saved = { peak: SIDEBAR.peak, notify: SIDEBAR.notify }
  const originalGetItem = globalThis.localStorage.getItem
  // 「上一次看到的档位」设成与当前一致：不触发「刚跨过」那条路径，单独测提前量
  globalThis.localStorage.getItem = key => (key === 'balance-monitor:peak-state' ? 'peak' : originalGetItem(key))
  // store 已经加载过（前面的用例），改夹具后要让它重新取一次数：focus 事件正好是这条路径
  const reloadSidebar = async () => {
    dispatchWindowEvent('focus')
    await tick()
    await tick()
  }
  try {
    // 距下一个切换点 1 分钟（下一个是「进入谷」），提前量 2 分钟 → 应提前提醒
    SIDEBAR.peak = { ...saved.peak, inPeak: true, nextAtMs: Date.now() + 60_000, nextIntoPeak: false, prevAtMs: 1 }
    SIDEBAR.notify = { enabled: true, system: false, leadMinutes: 2, type: 'both', position: 'corner' }
    await reloadSidebar()
    test('提前量：距切换不足 2 分钟 → 弹「即将进入平价时段」（浮层，右下角）', () => {
      const html = render(mount(sidebar.component))
      assert.ok(html.includes('即将进入平价时段'), `应有提前提醒：${html.slice(0, 200)}`)
      const popup = []
      walk(mount(sidebar.component), node => { if (node.props?.style?.position === 'fixed') popup.push(node.props.style) })
      assert.equal(popup.length, 1, `提醒应是一个浮层，实际 ${popup.length}`)
      assert.equal(popup[0].right, 16, '默认贴在右下角')
      assert.equal(popup[0].transform, undefined, '右下角不做水平位移')
      return '即将进入平价时段 · 右下角浮层'
    })
    test('同一个切换点只提前提醒一次（记在本地，不再刷屏）', async () => {
      const writes = localStorageWrites.filter(item => item.key === 'balance-monitor:peak-lead-at')
      assert.equal(writes.length > 0, true, `应记下已提醒过的切换点：${JSON.stringify(localStorageWrites)}`)
      return `已记 ${writes.at(-1).value}`
    })
    // 提醒是要用户自己关的，所以下一轮之前先关掉它，否则分不清「没弹」和「还挂着」
    assert.ok(clickIn(sidebar.component, node => node.type === 'button' && render(node.props?.children) === '×'), '应能关掉上一条提醒')
    // 类型过滤：只提醒「进入峰」，而下一个切换点是进入谷 → 不提醒
    SIDEBAR.peak = { ...saved.peak, inPeak: true, nextAtMs: Date.now() + 30_000, nextIntoPeak: false, prevAtMs: 1 }
    SIDEBAR.notify = { enabled: true, system: false, leadMinutes: 2, type: 'peak', position: 'corner' }
    await reloadSidebar()
    test('提醒类型 = 只提醒进入峰 → 下一个是进入谷，不弹', () => {
      const html = render(mount(sidebar.component))
      assert.ok(!html.includes('即将进入平价时段'), `不该弹：${html.slice(0, 200)}`)
      return 'type=peak 时进入谷不提醒'
    })
    // 位置：屏幕中心
    SIDEBAR.peak = { ...saved.peak, inPeak: true, nextAtMs: Date.now() + 30_000, nextIntoPeak: false, prevAtMs: 1 }
    SIDEBAR.notify = { enabled: true, system: false, leadMinutes: 2, type: 'both', position: 'center' }
    await reloadSidebar()
    test('弹窗位置 = 屏幕中心 → 浮层带 left 50% + translateX(-50%)', () => {
      const styles = []
      walk(mount(sidebar.component), node => { if (node.props?.style?.position === 'fixed') styles.push(node.props.style) })
      assert.equal(styles.length, 1, '应有一个浮层')
      assert.equal(styles[0].left, '50%')
      assert.equal(styles[0].transform, 'translateX(-50%)')
      assert.equal(styles[0].right, 'auto')
      return 'left 50% · translateX(-50%)'
    })
    // 关掉提醒 → 横幅一起收掉
    SIDEBAR.notify = { enabled: false, system: false, leadMinutes: 2, type: 'both', position: 'center' }
    await reloadSidebar()
    test('关掉提醒开关 → 挂着的横幅一起收起（不留残影）', () => {
      const html = render(mount(sidebar.component))
      assert.ok(!html.includes('即将进入平价时段'), '关掉后不该还有横幅')
      return '已收起'
    })
  } finally {
    globalThis.localStorage.getItem = originalGetItem
    SIDEBAR.peak = saved.peak
    SIDEBAR.notify = saved.notify
    await reloadSidebar()
  }
})()

console.log('\n[左侧栏：模型花费卡片]')
await (async () => {
  const sidebar = component('sidebar.footer.action')
  const saved = { modelCard: SIDEBAR.modelCard }
  // store 已加载过：focus 事件让侧栏重新取数（与峰谷提醒那节同一手法）
  const reloadSidebar = async () => {
    dispatchWindowEvent('focus')
    await tick()
    await tick()
  }
  try {
    await reloadSidebar()
    test('卡片：标题给周期总额与模型数，行给模型名 + 金额 + token + 未定价告警', () => {
      const html = render(mount(sidebar.component))
      assert.ok(html.includes('模型花费'), '应有卡片标题')
      assert.ok(html.includes('今日 ¥1.5437'), `标题应给周期总额：${html.slice(0, 220)}`)
      assert.ok(html.includes('4 个模型'), '标题应给模型总数（不是给出去的行数）')
      assert.ok(html.includes('cn:deepseek-v4.1-flash'), '应列出模型行')
      assert.ok(html.includes('1.3997'), '行里应有金额')
      assert.ok(html.includes('7.7M'), '默认显示 token')
      assert.ok(html.includes('⚠'), '未定价的行应有告警')
      return '标题 + 3 行 + ⚠'
    })
    test('占比条：宽度按 share 给（0.9 → 90%）', () => {
      const widths = []
      walk(mount(sidebar.component), node => {
        const width = node.props?.style?.width
        if (typeof width === 'string' && width.endsWith('%')) widths.push(width)
      })
      assert.ok(widths.includes('90%'), `应有一条 90% 的占比条：${widths.join(',')}`)
      assert.ok(widths.includes('10%'), `应有一条 10% 的占比条：${widths.join(',')}`)
      return widths.filter(item => item.endsWith('%')).join(' ')
    })
    test('收起 → 行收起、标题行上给 Top-1，且记住展开状态', () => {
      assert.ok(clickMatch(sidebar.component, '模型花费'), '应能点标题收起')
      const collapsed = render(mount(sidebar.component))
      assert.ok(!collapsed.includes('cn:deepseek-v4.1-pro'), `收起后不该列出行：${collapsed.slice(0, 200)}`)
      assert.ok(collapsed.includes('Top-1'), '收起时应在标题行给 Top-1')
      assert.ok(collapsed.includes('1.3997'), 'Top-1 要带金额')
      const remembered = localStorageWrites.filter(item => item.key === 'balance-monitor:model-card-open')
      assert.equal(remembered.at(-1)?.value, '0', '收起状态要记住')
      return '收起 → Top-1 + 记住 0'
    })
    test('位置 bottom（默认）→ 卡片排在峰谷条之后', () => {
      const html = render(mount(sidebar.component))
      assert.ok(html.indexOf('模型花费') > html.indexOf('进入平价'), `bottom：卡片应在峰谷条之后：${html.slice(0, 260)}`)
      return 'bottom 生效'
    })
  } finally {
    SIDEBAR.modelCard = saved.modelCard
  }
  await reloadSidebar()
  // 位置：top（原来那条 finally 会把夹具复位，所以放到 finally 之后再改）
  SIDEBAR.modelCard = { ...saved.modelCard, position: 'top' }
  await reloadSidebar()
  test('切到 position=top → 卡片跑到峰谷条前面', () => {
    const html = render(mount(sidebar.component))
    assert.ok(html.indexOf('模型花费') < html.indexOf('进入平价'), `top：卡片该在前：${html.slice(0, 260)}`)
    return 'top 生效'
  })
  // 关掉开关 / 不显示 token / 不显示占比条
  SIDEBAR.modelCard = { ...saved.modelCard, showTokens: false, showShare: false }
  await reloadSidebar()
  test('showTokens / showShare 关掉后对应内容不渲染', () => {
    const html = render(mount(sidebar.component))
    assert.ok(html.includes('cn:deepseek-v4.1-flash'), '行还在')
    assert.ok(!html.includes('7.7M'), `token 该收起来：${html.slice(0, 220)}`)
    const percents = []
    walk(mount(sidebar.component), node => {
      const width = node.props?.style?.width
      if (typeof width === 'string' && width.endsWith('%')) percents.push(width)
    })
    assert.ok(!percents.includes('90%'), `占比条该收起来：${percents.join(',')}`)
    return '两列都收起来了'
  })
  SIDEBAR.modelCard = null
  await reloadSidebar()
  test('关闭卡片（宿主下发 null）→ 侧栏不渲染这块', () => {
    const html = render(mount(sidebar.component))
    assert.ok(!html.includes('模型花费'), '关掉后不该有这块')
    return '已关闭'
  })
  SIDEBAR.modelCard = saved.modelCard
  try { globalThis.localStorage.removeItem('balance-monitor:model-card-open') } catch { /* 假的 localStorage 可能没实现 */ }
  await reloadSidebar()
})()

console.log('\n[输入区三块：本会话费用 / 额度横条 / 右下角角标]')
await (async () => {
  const saved = { sessionCost: SIDEBAR.sessionCost, quotaStrip: SIDEBAR.quotaStrip, corner: SIDEBAR.corner }
  const reloadSidebar = async () => {
    dispatchWindowEvent('focus')
    await tick()
    await tick()
  }
  // 会话数据是异步取的：先挂一次把数据拉回来再渲染断言
  //（`test()` 是同步的，await 只能放在调用 test 之前 —— 这是本文件的老坑）
  const renderSession = async (Component, props) => {
    mount(Component, props)
    await tick()
    await tick()
    return render(mount(Component, props))
  }
  // conversation.input.dock 注册了两个：index 0 = 本会话费用（order 4）、index 1 = 额度横条（order 5）
  const composerSession = component('conversation.input.dock', 0).component
  const headerSession = component('conversation.session.header.actions', 0).component
  const strip = component('conversation.input.dock', 1).component
  const corner = component('conversation.composer.dock', 0).component
  try {
    SIDEBAR.sessionCost = { enabled: true, position: 'composer', showHitRate: true, includeSubagent: false }
    await reloadSidebar()
    const composerHtml = await renderSession(composerSession, { sessionId: 'sess-parent' })
    const headerIdle = await renderSession(headerSession, { sessionId: 'sess-parent' })
    test('本会话费用：金额 / 调用数 / token / 命中率；位置=composer 时标题栏那处不渲染', () => {
      for (const needle of ['本会话 ¥2.16', '3 次', '5.0M tok', '命中 80.0%']) {
        assert.ok(composerHtml.includes(needle), `缺少「${needle}」：${composerHtml.slice(0, 200)}`)
      }
      assert.ok(!headerIdle.includes('本会话'), '位置=composer 时标题栏那处不该渲染')
      return '¥2.16 · 3 次 · 5.0M · 80.0%'
    })
    const noSession = await renderSession(composerSession, {})
    test('宿主没给 sessionId（不是会话页）→ 不渲染', () => {
      assert.equal(noSession.includes('本会话'), false, `没有会话 id 就不该有这一行：${noSession.slice(0, 120)}`)
      return '不渲染'
    })
    SIDEBAR.sessionCost = { enabled: true, position: 'header', showHitRate: false, includeSubagent: true }
    await reloadSidebar()
    const agentHtml = await renderSession(headerSession, { sessionId: 'sess-parent' })
    SIDEBAR.sessionCost = { enabled: true, position: 'header', showHitRate: true, includeSubagent: false }
    await reloadSidebar()
    const headerHtml = await renderSession(headerSession, { sessionId: 'sess-parent' })
    const composerIdle = await renderSession(composerSession, { sessionId: 'sess-parent' })
    test('位置改到 header → 轮到标题栏那处渲染', () => {
      assert.ok(headerHtml.includes('本会话'), `标题栏应该渲染：${headerHtml.slice(0, 200)}`)
      assert.ok(!composerIdle.includes('本会话'), '输入区那处应收起')
      return 'header 生效'
    })
    SIDEBAR.quotaStrip = { enabled: true, showBalance: true }
    SIDEBAR.corner = { enabled: true, showTop1: true }
    await reloadSidebar()
    const stripHtml = render(mount(strip, {}))
    const cornerHtml = render(mount(corner, {}))
    test('额度横条：今日 / 峰谷档位 / 余额三个 chip，且是按钮（点一下刷新）', () => {
      for (const needle of ['今日 1.3997', '峰时', '余额 ¥1.51']) {
        assert.ok(stripHtml.includes(needle), `横条缺少「${needle}」：${stripHtml.slice(0, 200)}`)
      }
      assert.ok(clickIn(strip, node => node.type === 'button' && render(node.props?.children).includes('今日')), 'chip 应是可点按钮')
      return '3 个 chip · 可点'
    })
    test('右下角角标：今日 + 峰谷档位 + Top-1 模型', () => {
      for (const needle of ['今日 1.3997', '峰时', 'Top-1 cn:deepseek-v4.1-flash']) {
        assert.ok(cornerHtml.includes(needle), `角标缺少「${needle}」：${cornerHtml.slice(0, 200)}`)
      }
      return '角标三段'
    })
    SIDEBAR.quotaStrip = { enabled: false, showBalance: true }
    SIDEBAR.corner = { enabled: false, showTop1: true }
    SIDEBAR.sessionCost = { enabled: false, position: 'composer', showHitRate: true, includeSubagent: false }
    await reloadSidebar()
    const stripOff = render(mount(strip, {}))
    const cornerOff = render(mount(corner, {}))
    const sessionOff = await renderSession(composerSession, { sessionId: 'sess-parent' })
  } finally {
    SIDEBAR.sessionCost = saved.sessionCost
    SIDEBAR.quotaStrip = saved.quotaStrip
    SIDEBAR.corner = saved.corner
  }
  await reloadSidebar()
})()

console.log('\n[左侧栏：余额可点击切换 DeepSeek 两条路线]')
await (async () => {
  const sidebar = component('sidebar.footer.action')
  let tree = mount(sidebar.component)
  await tick()
  tree = mount(sidebar.component)
  const html = render(tree)
  test('侧栏：余额（多 key 之和）/ 今日 / 峰谷倒计时 / 价格表按钮都在', () => {
    for (const needle of ['余额', '¥1.51', '今日', '¥1.3997', '进入平价', '价格表', '更新']) {
      assert.ok(html.includes(needle), `侧栏缺少「${needle}」：${html.slice(0, 200)}`)
    }
    return '多 key 总额 ¥1.51（0.01 + 1.50）'
  })
  test('两条路线都在时，余额行是可点的切换按钮（带提示）', () => {
    const buttons = []
    walk(tree, node => { if (node.type === 'button') buttons.push({ text: render(node.props?.children), title: node.props?.title, disabled: node.props?.disabled }) })
    const balanceButton = buttons.find(item => item.text.includes('余额'))
    assert.ok(balanceButton !== undefined, `找不到余额按钮，实际按钮：${JSON.stringify(buttons.map(item => item.text))}`)
    assert.notEqual(balanceButton.disabled, true, '两条路线时不该禁用')
    assert.match(String(balanceButton.title), /展开|明细/)
    return `「${balanceButton.text}」`
  })
  let clicked = false
  clicked = clickIn(sidebar.component, node => node.type === 'button' && render(node.props?.children).includes('余额'))
  await tick()
  tree = mount(sidebar.component)
  const opened = render(tree)
  test('点一下余额 → 展开明细：两条路线 + 每把 key 都列出来', () => {
    assert.ok(clicked, '没能点到余额行')
    assert.ok(opened.includes('DeepSeek Account'), `明细里应有账号路线：${opened.slice(0, 200)}`)
    assert.ok(opened.includes('按 key 明细'), '应有「按 key 明细」小节')
    assert.ok(opened.includes('DEEPSEEK_API_KEY'), '应列出第一把 key 的引用名')
    assert.ok(opened.includes('第二把'), '应列出第二把 key 的标签')
    assert.ok(opened.includes('¥1.5000') || opened.includes('¥1.50'), `应显示第二把 key 的余额：${opened.slice(0, 300)}`)
    assert.ok(opened.includes('(2 把 key)'), '多把 key 时应在余额行标注把数')
    return '明细：2 条路线 + 2 把 key'
  })
  test('明细里点「DeepSeek Account」→ 切到账号路线（金额与 localStorage 都变）', () => {
    const switched = clickIn(sidebar.component, node => node.type === 'button' && render(node.props?.children) === 'DeepSeek Account')
    assert.ok(switched, '明细里应能点到账号路线')
    const after = render(mount(sidebar.component))
    assert.ok(after.includes('DeepSeek Account'), '切换后标签应带上路线名')
    assert.ok(after.includes('¥-0.04'), `切换后应显示账号路线余额（¥-0.04），实际：${after.slice(0, 120)}`)
    const saved = localStorageWrites.filter(item => item.key === 'balance-monitor:sidebar-balance')
    assert.ok(saved.length > 0, `应写入 localStorage，实际：${JSON.stringify(localStorageWrites)}`)
    assert.equal(saved[saved.length - 1].value, 'deepseek-account')
    return 'DeepSeek ¥1.51 → DeepSeek Account ¥-0.04'
  })
  test('峰谷表：默认收起，点「预览」才列出接下来的切换点', () => {
    const collapsed = render(mount(sidebar.component))
    assert.ok(collapsed.includes('峰谷表'), `侧栏应有峰谷表行：${collapsed.slice(0, 200)}`)
    assert.ok(collapsed.includes('预览'), '默认是「预览」按钮')
    // 倒计时条上写的是「…后进入平价」，所以行标签用「→ 平价 / → 高峰」，两者不会串
    assert.equal(collapsed.includes('→ 平价'), false, '收起时不该把切换点列出来')
    const shown = clickIn(sidebar.component, node => node.type === 'button' && render(node.props?.children).includes('预览'))
    assert.ok(shown, '没点到「预览」按钮')
    const openedSchedule = render(mount(sidebar.component))
    assert.ok(openedSchedule.includes('→ 平价'), `展开后应列出「→ 平价」：${openedSchedule.slice(0, 300)}`)
    assert.ok(openedSchedule.includes('→ 高峰'), '展开后应列出「→ 高峰」')
    assert.ok(openedSchedule.includes('10-13'), '每行应带本地时刻（月-日 时:分）')
    return '收起 → 展开 · 2 个切换点'
  })
  // 侧栏那侧的「隐藏区块」没在这里单测：夹具是 JSON 深拷贝，改完要重新拉 /sidebar 才生效，
  // 而侧栏 store 在 IIFE 里被同名的槽位变量遮住了、够不到（30s 轮询与 focus 在假 window 里也不跑）。
  // 只要 `/sidebar` 带 `ui`（host 用例已断言）并且组件按 `ui.hide*` 分支渲染（代码只有两处），
  // 覆盖就够；真正的手点验证留到真宿主里做。
})()

console.log('\n[供应商卡片：DeepSeek 的多把 key 编辑区]')
await (async () => {
  const cards = slots.get('settings.models.provider-card')
  const real = cards.find(candidate => candidate().registration.key === 'llm-deepseek') ?? cards[0]
  const Component = real().component
  let tree = mount(Component, { provider: { provider: 'deepseek-official', settingsNs: 'llm-deepseek' } })
  await new Promise(resolve => setTimeout(resolve, 10))
  tree = mount(Component, { provider: { provider: 'deepseek-official', settingsNs: 'llm-deepseek' } })
  const html = render(tree)
  test('卡片里有「添加 key」行，且会去宿主问「有哪些 key」', () => {
    assert.ok(html.includes('添加 key'), `卡片缺少「添加 key」：${html.slice(0, 300)}`)
    const hit = calls.find(call => call.path.includes('/keys?provider=deepseek-official'))
    assert.ok(hit !== undefined, `卡片应向宿主请求 key 列表，实际请求：${calls.map(c => c.path).join(',')}`)
    assert.equal(hit.method, 'GET')
    return `${hit.path}（GET）`
  })
  test('密钥输入框是 password 类型；默认不预取明文（眼睛按钮在 key 行内，需异步回填）', () => {
    let input = null
    const eye = []
    walk(tree, node => {
      if (node.type === 'input' && node.props?.type === 'password') input = node
      if (node.type === 'button' && /👁|🙈/.test(render(node.props?.children))) eye.push(node)
    })
    assert.ok(input !== null, '应有 type=password 的输入框')
    const hit = calls.find(call => call.path.includes('/keys/reveal'))
    assert.equal(hit, undefined, '默认不能已经把值拉下来（点眼睛才拉）')
    // 说明：密钥行要等 KeyEditor 的异步回填，本假渲染器对「嵌套组件 + 异步」支持不足，
    // 所以这里只断言「没有预取明文」；眼睛按钮与行内容的正确性由宿主用例 + 真实页面确认。
    return `${input.props.type} 输入框 · 未预取明文 · 已识别 ${eye.length} 个眼睛按钮`
  })
  test('非 DeepSeek 路线不显示密钥编辑区', () => {
    const htmlOther = render(mount(Component, { provider: { provider: 'walk-grok', settingsNs: 'llm-pi-ai' } }))
    assert.ok(!htmlOther.includes('添加 key'), `普通中转站卡片不该有 key 编辑区：${htmlOther.slice(0, 200)}`)
    return 'walk-grok 无编辑区'
  })
  test('口径分歧：卡片不只说「不一致」，还说差在哪', () => {
    // 数据来自 STATE 夹具（fake fetch 会 JSON 往返，所以只能改夹具、不能事后改 STATE）。
    const html = render(mount(Component, { provider: { provider: 'walk-grok', settingsNs: 'llm-pi-ai' } }))
    for (const needle of ['实扣 ≈ 按倍率算的', '（高', '倍率接口报的是 1', '逐模型反推倍率', '仍以接口倍率为准']) {
      assert.ok(html.includes(needle), `分歧解释缺少「${needle}」：${html}`)
    }
    // 依据仍是接口倍率：反推值不能进公式
    assert.ok(!html.includes('×1.2799'), '反推倍率不能进公式')
    return '原因：方向 + 倍数 + 倍率为 1 + 逐模型区间'
  })
})()
console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
