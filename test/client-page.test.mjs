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
    /**
     * **hook 数量必须跨渲染稳定**。真 React 见数量变化会抛
     * `Rendered more hooks than during the previous render`，而这份假渲染器按游标存 hook、
     * 多出来的 slot 会被静默新建 —— 于是「首帧 `data === null` 早退、数据回来多跑一个 hook」
     * 这类真 P0（侧栏整块消失）用例全绿也抓不到。这里显式挡一下。
     */
    const used = frame.cursor
    frame.cursor = savedCursor
    if (frame.hookCount === undefined) frame.hookCount = used
    else if (frame.hookCount !== used) {
      throw new Error(
        `hook 数量变了：${frame.hookCount} → ${used}`
        + '（真 React 会抛 "Rendered more hooks than during the previous render"；'
        + '把 hook 提到 early return 之前，或把早退改成条件渲染）',
      )
    }
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
  /**
   * effect：**带 deps 时按 deps 变化重跑**（与 React 一致），不带 deps 的当「只跑一次」。
   *
   * 后半句是刻意的简化：真 React 里 `useEffect(fn)` 每次渲染都跑，但这份假渲染器没有
   * 提交阶段，每次渲染都跑一遍会跟 setState 形成死循环。组件里凡是需要「跟着某个值变」的
   * 都写了 deps，所以这条简化不影响覆盖，而它换来的是：**能测「同一个组件在两种配置下各渲染一次」**
   * （之前做不到，T3 有两条用例因此写不出来）。
   */
  useEffect(effect, deps) {
    const frame = currentFrame
    if (frame === null) return
    const cursor = frame.cursor++
    const previous = frame.effects[cursor]
    if (previous !== undefined) {
      if (deps === undefined) return
      // 浅比较 deps：长度与逐项都相同才算同一个依赖
      if (Array.isArray(previous.deps) && previous.deps.length === deps.length
        && previous.deps.every((item, index) => item === deps[index])) return
      if (typeof previous.cleanup === 'function') previous.cleanup()
    }
    const cleanup = effect()
    frame.effects[cursor] = { deps: Array.isArray(deps) ? [...deps] : undefined, cleanup: typeof cleanup === 'function' ? cleanup : null }
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
  providers: [{ provider: 'deepseek-official', displayName: 'DeepSeek', calls: 0, unpriced: 0, usd: 0, amount: 0, tokens: 0, hitRate: null, models: [] }, { provider: 'walk-grok', displayName: 'Grok 中转', calls: 160, unpriced: 1, usd: 0.1944, amount: 1.3997, tokens: 65_466_000, hitRate: 0.986, models: [{ model: 'cn:deepseek-v4.1-flash', usd: 0.1944 }, { model: 'cn:deepseek-v4.1-pro', usd: 0.02 }] }],
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
      { key: 'walk-grok:cn:deepseek-v4.1-flash', provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', calls: 160, unpriced: 0, usd: 0.1944, amount: 1.3997, tokens: 7_654_321, hitRate: 0.986, share: 0.9 },
      { key: 'walk-grok:cn:deepseek-v4.1-pro', provider: 'walk-grok', model: 'cn:deepseek-v4.1-pro', calls: 20, unpriced: 2, usd: 0.02, amount: 0.144, tokens: 1_000_000, hitRate: 0.5, share: 0.1 },
      { key: 'nanshan:grok-4', provider: 'nanshan', model: 'grok-4', calls: 5, unpriced: 0, usd: 0, amount: 0, tokens: 1000, hitRate: null, share: null },
    ],
    total: { usd: 0.2144, amount: 1.5437, calls: 185, unpriced: 2 },
  },
  // 输入区三块（T3）：宿主总是送补齐默认值的形状
  sessionCost: { enabled: false, position: 'composer', showHitRate: true, includeSubagent: false },
  quotaStrip: { enabled: false, showBalance: true },
  corner: { enabled: false, showTop1: false },
  // 预算进度（横条那格）：宿主按 budgetProgress 算好，占比 0.3982 → 39.8%
  budget: { enabled: true, amount: 1000, currency: 'CNY', period: 'month', usedUsd: 55.3, usedAmount: 398.2, ratio: 0.3982 },
  basisIds: ['p1-03cb848a'],
}
/**
 * 模型花费卡片的原始夹具。
 * 「输入区三块」那节为了验「卡片关着时角标还显示 Top-1」把 `SIDEBAR.modelCard` 设成了 `null`，
 * 复位时用的是它自己那份 `saved`（里面**没有** modelCard 这一位）→ 之后它就一直是 `undefined`。
 * 后面的用例还要用这份卡片，所以在定义处先留一份原样的。
 */
const MODEL_CARD_FIXTURE = SIDEBAR.modelCard
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
    // 账号路线：和真宿主一样**没有** `apiKeyEnv` / `hasKey`（它用登录 token，不吃 key）
    { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', deepseekRoute: 'account', type: 'other', status: 'idle', image: { editable: false } },
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
/**
 * 定时器记录：用来验证「不该起定时器的地方没起」——
 * 宿主会把这些槽位全挂上，隐藏那一处如果也轮询，就是白打一倍请求。
 * 只记录，不改变行为（返回的还是真 id，`clearInterval` 照常生效）。
 */
const intervals = []
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = (fn, ms) => {
  const id = realSetInterval(fn, ms)
  intervals.push({ ms, id, cleared: false })
  return id
}
globalThis.clearInterval = id => {
  const hit = intervals.find(item => item.id === id)
  if (hit !== undefined) hit.cleared = true
  return realClearInterval(id)
}
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
/**
 * `/session` 的响应闸门：命中 `match` 的请求先挂在这个 promise 上再回。
 * 默认 `null` = 不干预（不影响别的用例）；T3 的「换会话」用例用它造出
 * 「A 的响应还在飞、用户已经切到 B」这个时序。
 */
let sessionGate = null
/**
 * `/history/clear` 的响应覆盖：默认走夹具里那份「落盘成功」（`writeFailed: []`）。
 * 用例要验「落盘失败要如实提示」时把它设成带 `writeFailed` 的那份。
 */
let historyClearOverride = null
/** `sessionId` → 专用夹具（没登记的走通用 `sessionFixture`）。 */
const sessionOverrides = new Map()
/**
 * `/keys` 的响应覆盖：默认走 `KEYS`（两把 key）。
 * 用例要验「宿主按供应商过滤后一把都没剩」时把它设成 `keys: []` 的那份。
 */
let keysOverride = null
/**
 * `/keys/balances` 的响应覆盖。默认两把 key 各有一笔官方余额（第二把已用尽），
 * 用来锁住「密钥行右侧显示余额」。
 */
let keysBalanceOverride = null
/** 旧宿主没有 `/keys/balances`（404 not found）时，客户端应改打 `/balance/refresh`。 */
let keysBalanceMissing = false
/** `/balance/refresh` 的响应覆盖。默认仍是报表夹具里的那份余额。 */
let keysBalanceRefreshOverride = null
const DEFAULT_KEY_BALANCES = {
  keys: [
    { ref: 'DEEPSEEK_API_KEY', amount: 20.69, currency: 'CNY', isAvailable: true },
    { ref: 'DEEPSEEK_API_KEY_2', amount: -0.34, currency: 'CNY', isAvailable: false },
  ],
}
/** `/session` 的响应体：登记过的 id 用专用夹具，其余走通用夹具。 */
function sessionFixtureOf(path) {
  const id = /sessionId=([^&]*)/.exec(path)?.[1] ?? ''
  return sessionOverrides.get(id) ?? sessionFixture(path.includes('includeSubagent=1'))
}
globalThis.fetch = async (url, init) => {
  const path = String(url)
  calls.push({ path, method: init?.method ?? 'GET', body: init?.body ?? null, headers: init?.headers ?? null })
  if (sessionGate !== null && sessionGate.match.test(path)) await sessionGate.promise
  const json = path.endsWith('/state') ? { ok: true, state: STATE }
    : path.includes('/keys/balances')
      ? (keysBalanceMissing ? { ok: false, error: 'not found' } : { ok: true, data: keysBalanceOverride ?? DEFAULT_KEY_BALANCES })
    : path.includes('/keys/reveal') ? { ok: true, data: { value: 'sk-copy-me' } }
    : path.includes('/keys') ? { ok: true, data: keysOverride ?? KEYS }
    : path.includes('/history/import') ? { ok: true, data: { available: false, reason: '会话日志是分帧 zstd 存储，实测只解得出会话头一行', sessionsRoot: 'C:\\Users\\X\\.dsh\\sessions', projects: 7, sessionFiles: 23, zstd: true } }
    : path.includes('/history/clear') ? { ok: true, data: historyClearOverride ?? { ledgerDays: 12, records: 3456, rollupDays: 400, rollupUsd: 145.6, writeFailed: [] } }
    : path.includes('/session?') ? { ok: true, data: sessionFixtureOf(path) }
    : path.endsWith('/report') ? { ok: true, data: REPORT }
    : path.endsWith('/sidebar') ? { ok: true, data: SIDEBAR }
      : path.endsWith('/prices/update') ? { ok: true, data: { meta: { ...REPORT.prices.meta, accepted: 320 } } }
        : path.endsWith('/config') ? { ok: true, data: { display: REPORT.display, budget: REPORT.budget, priceSources: REPORT.prices.sources, basisId: 'p1-new0000' } }
          : path.endsWith('/balance/refresh') ? { ok: true, data: keysBalanceRefreshOverride ?? { balance: REPORT.balance } }
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
const slotsApi = {
  inject(name, register) { slots.set(name, (slots.get(name) ?? []).concat([register])) },
  register(registration, component) { return { registration, component } },
}
/** 快照 store 的替身：只提供 getSnapshot / subscribe，够读、不广播。 */
function fakeSnapshotStore(snapshot) {
  return { getSnapshot: () => snapshot, subscribe() { return () => {} } }
}
/**
 * 服务查询的替身。**只提供 `get`**，故意不提供 `ctx.xxx` / `ctx.inject` ——
 * 线上那两样在客户端插件的白名单代理里都会抛：
 *   · `ctx.sessions`（未声明 inject）→ "service not declared by your plugin"
 *   · `ctx.inject(...)`（不在 CTX_VERBS 里）→ 读属性即抛，apply 中断
 * 所以用例把 ctx 收窄成「只有 get」，谁再写回去就会当场炸。
 */
const requestedServices = []
const railServices = {
  sessions: { list: fakeSnapshotStore({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }) },
  workspaces: { list: fakeSnapshotStore({ items: [], archivedSessionIds: [] }) },
  uiSession: { sessionStatus: fakeSnapshotStore(new Map()) },
  uiWorkspace: { openSession() {} },
}
const ctx = {
  slots: slotsApi,
  effect(fn, label) { effects.push({ fn, label }) },
  get(name) { requestedServices.push(name); return railServices[name] },
}
/**
 * `apply` 里会往 `document.head` 注入一份「侧栏底部独占一行」的样式。
 * 这个用例只截获那一次注入，随后把 `document` 删掉 —— 后面的渲染用例
 * 仍是纯 React 树，不依赖 DOM，也避免半截 DOM 替身把别的分支带坏。
 */
const injectedStyles = []
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  writable: true,
  value: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild(tag) { injectedStyles.push(tag) } },
  },
})
try {
  entry.factory(requireStub).apply(ctx)
} finally {
  delete globalThis.document
}

/**
 * `/session` 的响应夹具：`includeSubagent` 打开时多出「子代理」那一档、合计跟着变大。
 * 形状与宿主 `summarizeSession()` 一致：**金额是展示币种的数字**（`toDisplay()` 的返回值，
 * 币种符号由客户端 `formatAmount()` 补），`cost` 为 `null` = 这一档全未定价；
 * token 是 5 桶 + total。
 */
function sessionFixture(includeSubagent) {
  const self = {
    calls: 3, priced: 3, unpriced: 0, usd: 0.3, amount: 2.16, cost: 2.16,
    tokens: { input: 1_000_000, output: 0, cacheRead: 4_000_000, cacheWrite: 0, reasoning: 0, total: 5_000_000 },
    hitRate: 0.8,
    models: [{ key: 'walk-grok:cn:deepseek-v4.1-flash', provider: 'walk-grok', model: 'cn:deepseek-v4.1-flash', calls: 3, usd: 0.3, amount: 2.16 }],
  }
  const zero = {
    calls: 0, priced: 0, unpriced: 0, usd: 0, amount: 0, cost: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    hitRate: null, models: [],
  }
  const children = includeSubagent
    ? {
        ...self,
        calls: 2, usd: 0.2, amount: 1.44, cost: 1.44,
        tokens: { ...self.tokens, input: 500_000, total: 2_500_000 },
        models: [{ key: 'walk-grok:cn:deepseek-v4.1-pro', provider: 'walk-grok', model: 'cn:deepseek-v4.1-pro', calls: 2, usd: 0.2, amount: 1.44 }],
      }
    : zero
  const total = includeSubagent
    ? { ...self, calls: 5, usd: 0.5, amount: 3.6, cost: 3.6, tokens: { ...self.tokens, input: 1_500_000, total: 7_500_000 } }
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

test('文件栏路径右侧：复制按钮把当前目录写入剪贴板', () => {
  const regs = slots.get('sidebar.right.tab.files.actions') ?? []
  assert.equal(regs.length, 1, '应注册到文件栏操作插槽')
  const { registration, component } = regs[0]()
  assert.equal(registration.id, 'balance-monitor:copy-directory')
  assert.equal(registration.order, 20)
  const target = 'E:\\项目\\DSH-Balance-Monitor'
  let written = null
  const saved = globalThis.navigator
  globalThis.navigator = {
    language: 'zh-CN',
    clipboard: { writeText(text) { written = text; return Promise.resolve() } },
  }
  try {
    let button = null
    mount(component, { absolutePath: target }, node => {
      if (node?.props?.['data-files-copy-path'] === true) button = node
    })
    assert.ok(button !== null, '找不到复制按钮')
    assert.equal(button.props['aria-label'], '复制目录路径')
    button.props.onClick()
    assert.equal(written, target)
    return target
  } finally {
    globalThis.navigator = saved
  }
})

test('文件预览头部：复制按钮把当前文件路径写入剪贴板', () => {
  const regs = slots.get('sidebar.right.tab.document.actions') ?? []
  assert.equal(regs.length, 1, '应注册到文件预览操作插槽')
  const { registration, component } = regs[0]()
  assert.equal(registration.id, 'balance-monitor:copy-file-path')
  assert.equal(registration.order, 20)
  const target = 'E:\\项目\\DSH-Balance-Monitor\\.gitattributes'
  let written = null
  const saved = globalThis.navigator
  globalThis.navigator = {
    language: 'zh-CN',
    clipboard: { writeText(text) { written = text; return Promise.resolve() } },
  }
  try {
    let button = null
    mount(component, { absolutePath: target }, node => {
      if (node?.props?.['data-document-copy-path'] === true) button = node
    })
    assert.ok(button !== null, '找不到复制按钮')
    assert.equal(button.props['aria-label'], '复制文件路径')
    button.props.onClick()
    assert.equal(written, target)
    return target
  } finally {
    globalThis.navigator = saved
  }
})

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
test('切到「用量」页：token 汇总 + 27 列热力图 + 按模型统计入口', () => {
  assert.ok(clickText(tree, '用量'))
  tree = mount(CostPage)
  const html = render(tree)
  // 周数 = 渲染出来的列数：夹具首日 2026-04-15 是周三（weekday=3），182 天要补 3 格 →
  // ceil((3 + 182) / 7) = 27 列。按 `ceil(182 / 7) = 26` 写就少一列（用例在「热力图摘要」那节钉住）。
  for (const needle of ['缓存写入', '推理', '最近 3 天', 'Token 用量统计', '近 27 周', '按模型统计', 'cn:deepseek-v4.1-flash']) {
    assert.ok(html.includes(needle), `用量页缺少「${needle}」`)
  }
  return '四段内容齐全'
})
test('按模型统计：默认展开，可折叠，双档 + 四种排行真的按指标重排', () => {
  assert.ok(render(mount(CostPage)).includes('按模型统计'), '入口应在')
  assert.ok(render(mount(CostPage)).includes('排行依据'), '默认应展开（隐藏入口等于没有）')
  // 按钮是开关：折叠 → 内容收起 → 再展开
  assert.ok(clickMatch(CostPage, '按模型统计'), '应能折叠')
  assert.ok(!render(mount(CostPage)).includes('排行依据'), '折叠后内容应收起')
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
test('「显示」页带「界面」段：语言选择器 + 轮询间隔 + 四个隐藏/显示开关', () => {
  const page = mount(CostPage)
  const html = render(page)
  for (const needle of ['界面', '界面语言', '跟随浏览器', '简体中文', 'English',
    '侧栏刷新间隔（秒）', '保存间隔', '隐藏官方余额', '隐藏今日消耗', '会话明细显示完整会话 ID',
    '侧栏显示峰谷表 / 价格表']) {
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
  for (const label of ['隐藏官方余额', '隐藏今日消耗', '会话明细显示完整会话 ID', '侧栏显示峰谷表 / 价格表']) {
    assert.equal(checkbox(page, label).checked, false, `「${label}」默认应关`)
  }
  return '语言 / 间隔 / 四个开关都在'
})
test('「显示」页带「峰谷表」只读表：侧栏那行默认不显示，这里要看得到', () => {
  const page = mount(CostPage)
  const html = render(page)
  assert.ok(html.includes('峰谷表'), `显示页缺少峰谷表：${html.slice(-400)}`)
  assert.ok(html.includes('→ 平价'), `应列出「→ 平价」：${html.slice(-400)}`)
  assert.ok(html.includes('→ 高峰'), '应列出「→ 高峰」')
  assert.ok(html.includes('10-13'), '每行要带本地时刻（月-日 时:分）')
  assert.ok(html.includes('接下来 6 个档位切换点'), '表下面要说清这是哪来的数据')
  return '2 个切换点（本地时刻 + 方向）'
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
      // 行里的金额要带币种符号（宿主给数字 1.3997，符号得客户端补）。
      // 必须连上模型名断言：单独找 `¥1.3997` 会被侧栏「今日」行满足，测不到卡片行。
      assert.ok(html.includes('cn:deepseek-v4.1-flash¥1.3997'), '行里应有带币种符号的金额')
      assert.ok(!html.includes('cn:deepseek-v4.1-flash1.3997'), '金额不能裸着显示')
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
      assert.ok(collapsed.includes('cn:deepseek-v4.1-flash ¥1.3997'), 'Top-1 要带金额（含币种符号）')
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
  /** 同上，但把异常收成字符串返回 —— 「不抛错」这种断言才写得出来（否则会炸掉整个文件）。 */
  const renderSafely = async (Component, props) => {
    try { return await renderSession(Component, props) }
    catch (error) { return `__THROW__${String(error?.message ?? error)}` }
  }
  // conversation.input.dock 注册了两个：index 0 = 本会话费用（order 4）、index 1 = 额度横条（order 5）
  // dock 位置挂在 conversation.input.left（工具行空位），不跟宿主底栏抢行
  // conversation.composer.dock 只剩右下角角标
  const composerSession = component('conversation.input.dock', 0).component
  const headerSession = component('conversation.session.header.actions', 0).component
  const strip = component('conversation.input.dock', 1).component
  const cornerDock = component('conversation.input.left', 0).component
  const corner = component('conversation.composer.dock', 0).component
  /**
   * 收集「按宿主 dock 列宽」的那层样式：判据是 `maxWidth` 里带宿主的
   * `--dsh-composer-card-max-width`（只有输入区附近那几条会有；标题栏那处不该有）。
   */
  const dockColumns = (Component, props) => {
    const out = []
    walk(mount(Component, props), node => {
      const style = node.props?.style
      if (typeof style?.maxWidth === 'string' && style.maxWidth.includes('--dsh-composer-card-max-width')) out.push(style)
    })
    return out
  }
  try {
    SIDEBAR.sessionCost = { enabled: true, position: 'dock', showHitRate: true, includeSubagent: false }
    await reloadSidebar()
    const dockHtml = await renderSession(cornerDock, { sessionId: 'sess-parent' })
    const dockIdle = await renderSession(cornerDock, {})
    test('位置=dock（输入框下方）→ 那一行该渲染；宿主没给 sessionId 就不渲染', () => {
      for (const needle of ['本会话 ¥2.1600', '3 次', '5.0M tok', '命中 80.0%']) {
        assert.ok(dockHtml.includes(needle), `缺少「${needle}」：${dockHtml.slice(0, 200)}`)
      }
      assert.equal(dockIdle.includes('本会话'), false, '没有会话 id 就不该有这一行')
      return '¥2.1600 · 3 次 · 5.0M · 80.0%'
    })
    // dock 位置在输入栏工具行的空位里，最多占这行的 46%（跟着卡片宽走），
    // 不能再写接近 100% 的宽度去盖住「+ / 权限 / 模型」或把底栏的百分比顶走。
    test('输入栏中间那条：最多占半行，窄了省略，不抢宿主控件', () => {
      const rows = []
      walk(mount(cornerDock, { sessionId: 'sess-parent' }), node => {
        const style = node.props?.style
        if (style?.textOverflow === 'ellipsis' && style?.flex === '0 1 auto') rows.push(style)
      })
      assert.equal(rows.length, 1, `应有且只有一行按比例分宽：${rows.length}`)
      assert.equal(rows[0].minWidth, 0, '窄屏要允许收缩')
      assert.ok(String(rows[0].maxWidth).includes('46cqw'), `宽度要跟容器走，不能写死像素：${rows[0].maxWidth}`)
      assert.equal(rows[0].whiteSpace, 'nowrap')
      assert.equal(rows[0].width, undefined, '不能再写死 calc(100% - …)')
      return '46cqw · 窄屏省略 · 底栏留给宿主'
    })
    SIDEBAR.sessionCost = { enabled: true, position: 'composer', showHitRate: true, includeSubagent: false }
    await reloadSidebar()
    const composerHtml = await renderSession(composerSession, { sessionId: 'sess-parent' })
    const headerIdle = await renderSession(headerSession, { sessionId: 'sess-parent' })
    const dockIdleAgain = await renderSession(cornerDock, { sessionId: 'sess-parent' })
    test('本会话费用：金额 / 调用数 / token / 命中率；位置=composer 时另两处不渲染', () => {
      for (const needle of ['本会话 ¥2.1600', '3 次', '5.0M tok', '命中 80.0%']) {
        assert.ok(composerHtml.includes(needle), `缺少「${needle}」：${composerHtml.slice(0, 200)}`)
      }
      assert.ok(!headerIdle.includes('本会话'), '位置=composer 时标题栏那处不该渲染')
      assert.ok(!dockIdleAgain.includes('本会话'), '位置=composer 时输入框下方那处不该渲染')
      return '¥2.1600 · 3 次 · 5.0M · 80.0%'
    })
    test('本会话费用那行按宿主的 dock 列宽居中（不再贴会话面板左边）', () => {
      const rows = dockColumns(composerSession, { sessionId: 'sess-parent' })
      assert.equal(rows.length, 1, `应有且只有一行吃 dock 列宽：${rows.length}`)
      const style = rows[0]
      assert.equal(style.margin, '0 auto', '要靠 margin auto 才能居中')
      assert.ok(String(style.width).startsWith('calc(100% -'), `宽度要减掉两侧留白：${style.width}`)
      assert.ok(String(style.width).includes('--dsh-composer-side-clearance'), `侧边留白要跟宿主一致：${style.width}`)
      assert.ok(String(style.padding).includes('--dsh-composer-dock-inset'), `横向内缩要跟宿主 dock 一致：${style.padding}`)
      return 'margin auto + 宿主 --dsh-composer-* 变量'
    })
    const noSession = await renderSession(composerSession, {})
    test('宿主没给 sessionId（不是会话页）→ 不渲染', () => {
      assert.equal(noSession.includes('本会话'), false, `没有会话 id 就不该有这一行：${noSession.slice(0, 120)}`)
      return '不渲染'
    })
    SIDEBAR.sessionCost = { enabled: true, position: 'header', showHitRate: false, includeSubagent: true }
    await reloadSidebar()
    const agentHtml = await renderSession(headerSession, { sessionId: 'sess-parent' })
    test('勾「包含子代理」→ 走 total 那一档，且关掉命中率后不再显示', () => {
      assert.ok(agentHtml.includes('本会话 ¥3.6000'), `含子代理应给合计：${agentHtml.slice(0, 220)}`)
      assert.ok(agentHtml.includes('5 次'), '合计调用数 5')
      assert.ok(!agentHtml.includes('命中'), '关掉命中率后不该有它')
      return '含子代理 → ¥3.6000 · 5 次'
    })
    SIDEBAR.sessionCost = { enabled: true, position: 'header', showHitRate: true, includeSubagent: false }
    await reloadSidebar()
    const headerHtml = await renderSession(headerSession, { sessionId: 'sess-parent' })
    const composerIdle = await renderSession(composerSession, { sessionId: 'sess-parent' })
    test('位置改到 header → 轮到标题栏那处渲染', () => {
      assert.ok(headerHtml.includes('本会话'), `标题栏应该渲染：${headerHtml.slice(0, 200)}`)
      assert.ok(!composerIdle.includes('本会话'), '输入区那处应收起')
      return 'header 生效'
    })
    // 宿主会把两个槽位都挂上：没被选中的那一处不该跟着取数，也不该起自己的轮询定时器
    //（15s 一次、每次 force 真发请求）；只数请求抓不到它 —— store 有 TTL 缓存会吃掉重复请求，
    // 所以这里数**定时器**。数的是**累计起过多少个**，不是「当前未清理的」那个：
    // 后者不单调 —— 配置一变 effect 会清掉旧的、起个新的，未清理数就会**变小**，
    // 于是「挂载隐藏实例后数量不变」只要测量窗口跨过一次配置变更就假失败
    //（实测单独跑绿、在 npm 门槛里 3/3 抖，就是环境差）。
    const timersBefore = intervals.filter(item => item.ms === 15_000).length
    const idleBefore = calls.filter(call => call.path.includes('/session?')).length
    await renderSession(composerSession, { sessionId: 'sess-parent' })
    const idleAfter = calls.filter(call => call.path.includes('/session?')).length
    const timersAfter = intervals.filter(item => item.ms === 15_000).length
    test('没被选中的那处不发请求、也不起 15 秒轮询定时器', () => {
      assert.equal(idleAfter, idleBefore, `隐藏那处不该取数：${idleBefore} → ${idleAfter}`)
      assert.equal(timersAfter, timersBefore, `隐藏那处不该起定时器：${timersBefore} → ${timersAfter}`)
      return `隐藏处 0 请求 · 0 新定时器（累计起过 ${intervals.filter(item => item.ms === 15_000).length} 个 15s 定时器）`
    })
    // 这条**必须留在上面那条之后**：挂一次 header 那处会（重新）起一个 15 秒定时器，
    // 排在前面会把「隐藏处不该起定时器」那条用例的 before/after 计数搞乱（实测 1 → 0）。
    test('位置=header 时不吃输入区那套列宽（标题栏那行不许被压窄）', () => {
      const rows = dockColumns(headerSession, { sessionId: 'sess-parent' })
      assert.equal(rows.length, 0, `标题栏那处不该带 dock 列宽：${JSON.stringify(rows)}`)
      return '标题栏不吃 dock 列宽'
    })
    SIDEBAR.quotaStrip = { enabled: true, showBalance: true }
    SIDEBAR.corner = { enabled: true, showTop1: true }
    await reloadSidebar()
    const stripHtml = render(mount(strip, {}))
    const cornerHtml = render(mount(corner, {}))
    test('额度横条：今日 / 峰谷档位 / 余额三个 chip，且是按钮（点一下刷新）', () => {
      for (const needle of ['预算 39.8%', '今日 ¥1.3997', '峰时', '余额 ¥1.51']) {
        assert.ok(stripHtml.includes(needle), `横条缺少「${needle}」：${stripHtml.slice(0, 200)}`)
      }
      // 今日那格的金额要带币种符号（宿主给的是数字 1.3997，符号得客户端补）
      assert.ok(!stripHtml.includes('今日 1.3997'), `金额不能裸着显示：${stripHtml.slice(0, 200)}`)
      assert.ok(clickIn(strip, node => node.type === 'button' && render(node.props?.children).includes('今日')), 'chip 应是可点按钮')
      return '3 个 chip · 可点 · 带币种符号'
    })
    test('额度横条挂在同一条 dock 上：也按列宽居中', () => {
      const rows = dockColumns(strip, {})
      assert.equal(rows.length, 1, `横条那一行也该吃 dock 列宽：${rows.length}`)
      return '横条同一套列宽'
    })
    test('右下角角标：今日 + 峰谷档位 + Top-1 模型（按金额取最大那个）', () => {
      for (const needle of ['今日 ¥1.3997', '峰时', 'Top-1 cn:deepseek-v4.1-flash']) {
        assert.ok(cornerHtml.includes(needle), `角标缺少「${needle}」：${cornerHtml.slice(0, 200)}`)
      }
      assert.ok(!cornerHtml.includes('今日 1.3997'), `金额不能裸着显示：${cornerHtml.slice(0, 200)}`)
      assert.ok(!cornerHtml.includes('cn:deepseek-v4.1-pro'), `Top-1 应是金额最大的那个：${cornerHtml.slice(0, 200)}`)
      return '角标三段 · 带币种符号'
    })
    // 原来 Top-1 是从「模型花费卡片」的数据里取的 —— 那块卡片关着时开关就形同虚设（点了没反应）。
    // 现在改成用侧栏自带的今日按模型明细算，这条用例把这个解耦锁住。
    SIDEBAR.modelCard = null
    await reloadSidebar()
    const cornerNoCard = render(mount(corner, {}))
    test('模型花费卡片关着时，角标的 Top-1 照样显示（不耦合那块配置）', () => {
      assert.ok(cornerNoCard.includes('Top-1 cn:deepseek-v4.1-flash'), `不该依赖模型卡片开关：${cornerNoCard.slice(0, 200)}`)
      return '独立于卡片开关'
    })
    SIDEBAR.modelCard = saved.modelCard
    await reloadSidebar()
    SIDEBAR.quotaStrip = { enabled: false, showBalance: true }
    SIDEBAR.corner = { enabled: false, showTop1: true }
    SIDEBAR.sessionCost = { enabled: false, position: 'composer', showHitRate: true, includeSubagent: false }
    await reloadSidebar()
    const stripOff = render(mount(strip, {}))
    const cornerOff = render(mount(corner, {}))
    const sessionOff = await renderSession(composerSession, { sessionId: 'sess-parent' })
    // 「三块关掉都不渲染」这条**仍然测不了**：侧栏 store 的 data 是宿主下发的快照，
    // 组件读到的是上一次取数的那份（focus 重取在这个渲染器里对已挂载实例不生效），
    // 于是断言拿到的还是旧档。开关语义由 host 用例覆盖（三个块的局部补丁 / 非法保持 / 全默认不留条），
    // 这里不写假绿断言。
    void sessionOff
    void stripOff
    void cornerOff

    // ────────── 换会话：A 的请求还在飞时切到 B（P0：会话串数据）──────────
    // 造时序：`sessionGate` 把 sess-A 的响应挂住，sess-B 的立刻回。
    // 断言要点两条：B 渲染的是**自己的**数（不是 A 的），且切到 B 后确实为 B 发过请求。
    SIDEBAR.sessionCost = { enabled: true, position: 'composer', showHitRate: true, includeSubagent: false }
    let releaseA = () => {}
    const gateA = new Promise(resolve => { releaseA = resolve })
    /** 一档会话数据：金额取能一眼区分的数字（A=7 次 ¥9.8765 / B=2 次 ¥1.2345）。 */
    const sessionNodeOf = (callsCount, amount, tokensTotal) => ({
      calls: callsCount, priced: callsCount, unpriced: 0, usd: amount / 7.2, amount, cost: amount,
      tokens: { input: tokensTotal, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: tokensTotal },
      hitRate: 0.5, models: [],
    })
    const sessionCaseOf = (sessionId, self) => ({
      sessionId, date: '2026-10-13', includeSubagent: false, subagentSupported: true,
      self, children: self, total: self, firstAtMs: 1, lastAtMs: 2,
    })
    sessionOverrides.set('sess-A', sessionCaseOf('sess-A', sessionNodeOf(7, 9.8765, 9_000_000)))
    sessionOverrides.set('sess-B', sessionCaseOf('sess-B', sessionNodeOf(2, 1.2345, 2_000_000)))
    sessionGate = { match: /sessionId=sess-A/, promise: gateA }
    await reloadSidebar()
    // A 发出去了但响应还挂着 → 这一帧没有数据可画（不许拿别的档顶替）
    const htmlA = await renderSession(composerSession, { sessionId: 'sess-A' })
    const htmlB = await renderSession(composerSession, { sessionId: 'sess-B' })
    const askedB = calls.filter(call => call.path.includes('sessionId=sess-B')).length
    // 放行 A 的迟到响应：它已经不属于当前档，**不许**覆盖 B
    releaseA()
    await tick()
    await tick()
    sessionGate = null
    const htmlBLate = render(mount(composerSession, { sessionId: 'sess-B' }))
    test('换会话：A 在飞时切到 B，B 画的是 B 的钱（不是 A 的），且为 B 发了请求', () => {
      assert.ok(htmlB.includes('本会话 ¥1.2345'), `B 应显示自己的金额：${htmlB.slice(0, 200)}`)
      assert.ok(htmlB.includes('2 次'), `B 应显示自己的调用数：${htmlB.slice(0, 200)}`)
      assert.ok(!htmlB.includes('9.8765'), `不许把 A 的金额画到 B 身上：${htmlB.slice(0, 200)}`)
      assert.ok(askedB >= 1, `切到 B 后必须为 B 发请求，实际 ${askedB} 次`)
      // A 响应还没回来的那一帧：没有数据就什么都不显示，不许拿别的档（或 0）顶上
      assert.ok(!htmlA.includes('9.8765') && !htmlA.includes('1.2345'), `A 未回来时不该有金额：${htmlA.slice(0, 120)}`)
      return `B 独立取数（sess-B 请求 ${askedB} 次）`
    })
    test('A 的迟到响应不落到 B 上（换 key 后响应先校验 key）', () => {
      assert.ok(htmlBLate.includes('本会话 ¥1.2345'), `B 应保持自己的数：${htmlBLate.slice(0, 200)}`)
      assert.ok(!htmlBLate.includes('9.8765'), `A 的迟到响应不许覆盖 B：${htmlBLate.slice(0, 200)}`)
      return '迟到响应已丢弃'
    })

    // ────────── 未定价 ≠ 0 + 老宿主缺字段（P1）──────────
    // 宿主对「这一档全未定价」给 `amount: 0` / `cost: null`（界面该显示 —，不是 ¥0）
    sessionOverrides.set('sess-unpriced', sessionCaseOf('sess-unpriced', {
      calls: 2, priced: 0, unpriced: 2, usd: 0, amount: 0, cost: null,
      tokens: { input: 4_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 4_000 },
      hitRate: null, models: [],
    }))
    // 形状漂移：老宿主没有 `total.tokens`
    const noTokensNode = { calls: 1, priced: 1, unpriced: 0, usd: 0.2, amount: 1.5, cost: 1.5, hitRate: 0.5, models: [] }
    sessionOverrides.set('sess-notokens', sessionCaseOf('sess-notokens', noTokensNode))
    const unpricedHtml = await renderSession(composerSession, { sessionId: 'sess-unpriced' })
    const noTokensHtml = await renderSafely(composerSession, { sessionId: 'sess-notokens' })
    test('全部未定价的会话显示 —（不是 ¥0）', () => {
      assert.ok(unpricedHtml.includes('本会话 —'), `全未定价应为 —：${unpricedHtml.slice(0, 200)}`)
      assert.ok(!unpricedHtml.includes('¥0'), `不许画成 ¥0：${unpricedHtml.slice(0, 200)}`)
      assert.ok(unpricedHtml.includes('2 笔未定价'), `未定价条数照旧要报：${unpricedHtml.slice(0, 200)}`)
      return '— 而非 ¥0（与设置页会话表同判据）'
    })
    test('宿主没给 total.tokens（形状漂移）→ 不抛错', () => {
      assert.ok(!noTokensHtml.startsWith('__THROW__'), `缺 tokens 不该抛：${noTokensHtml.slice(0, 200)}`)
      assert.ok(noTokensHtml.includes('本会话 ¥1.5000'), `其余部分照常渲染：${noTokensHtml.slice(0, 200)}`)
      return 'undefined tokens 也渲染得出来'
    })
    // 缺 token 数（宿主没给这一档）和「真的用了 0 个 token」是两回事：
    // 前者画 —（与 formatAmount 同判据），后者才是 0 —— 别把缺值静默补成 0。
    sessionOverrides.set('sess-zerotok', sessionCaseOf('sess-zerotok', {
      calls: 1, priced: 1, unpriced: 0, usd: 0.2, amount: 1.5, cost: 1.5,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
      hitRate: 0.5, models: [],
    }))
    const zeroTokensHtml = await renderSafely(composerSession, { sessionId: 'sess-zerotok' })
    test('token 缺值画 —、真 0 画 0（两回事）', () => {
      assert.ok(noTokensHtml.includes('— tok'), `缺 tokens 应给 —：${noTokensHtml.slice(0, 200)}`)
      assert.ok(!noTokensHtml.includes('0 tok'), `缺值不许画成 0：${noTokensHtml.slice(0, 200)}`)
      assert.ok(zeroTokensHtml.includes('0 tok'), `真 0 仍画 0：${zeroTokensHtml.slice(0, 200)}`)
      return '缺值 — · 真 0 → 0'
    })
  } finally {
    // 闸门一定要放掉：留着会让后面任何一次 /session 请求挂住（用例失败时也一样）
    sessionGate = null
    SIDEBAR.sessionCost = saved.sessionCost
    SIDEBAR.quotaStrip = saved.quotaStrip
    SIDEBAR.corner = saved.corner
  }
  await reloadSidebar()
})()

console.log('\n[历史数据：导入探测 / 清除（两步确认）]')
await (async () => {
  assert.ok(clickText(mount(CostPage), '用量'), '应能切到用量页')
  const tabHtml = render(mount(CostPage))
  test('用量页底部有「历史数据」：说明入账即冻结，两个按钮都在', () => {
    for (const needle of ['历史数据', '入账时就冻结', '导入安装前历史', '清除全部历史', '不可恢复']) {
      assert.ok(tabHtml.includes(needle), `缺少「${needle}」：${tabHtml.slice(-260)}`)
    }
    return '说明 + 两个按钮'
  })
  assert.ok(clickText(mount(CostPage), '清除全部历史'), '应有「清除全部历史」按钮')
  const confirmingHtml = render(mount(CostPage))
  test('点「清除全部历史」→ 只是进入确认态（一个请求都不发）', () => {
    assert.ok(confirmingHtml.includes('再点一次确认清空'), `应出现确认按钮：${confirmingHtml.slice(-200)}`)
    assert.equal(calls.filter(call => call.path.includes('/history/clear')).length, 0, '确认前不该发请求')
    return '未发请求'
  })
  assert.ok(clickText(mount(CostPage), '再点一次确认清空'), '应能点到确认按钮')
  await tick()
  await tick()
  await tick()
  const clearedHtml = render(mount(CostPage))
  test('再点一次 → POST /history/clear 带确认串，并回显清了多少', () => {
    const hit = calls.filter(call => call.path.includes('/history/clear')).at(-1)
    assert.ok(hit !== undefined, '应该发了清空请求')
    assert.deepEqual(JSON.parse(hit.body), { confirm: 'clear-all-history' }, `实际：${hit.body}`)
    assert.ok(clearedHtml.includes('已清空：明细 12 天 / 3456 条'), `应回显清空结果：${clearedHtml.slice(-260)}`)
    assert.ok(!clearedHtml.includes('再点一次确认清空'), '清完要退出确认态')
    return 'POST { confirm: clear-all-history } · 回显'
  })
  assert.ok(clickText(mount(CostPage), '导入安装前历史'), '应有导入按钮')
  await tick()
  await tick()
  await tick()
  const probedHtml = render(mount(CostPage))
  test('点「导入安装前历史」→ 显示扫描结果与真实原因（不假装导入）', () => {
    assert.ok(probedHtml.includes('扫描结果'), `应显示探测结果：${probedHtml.slice(-260)}`)
    assert.ok(probedHtml.includes('7 个项目 / 23 份会话日志'), '要把扫到多少说清楚')
    assert.ok(probedHtml.includes('分帧 zstd'), '要把真实原因说出来')
    assert.ok(!probedHtml.includes('已导入'), '不该假装导入成功')
    return '原因说清楚 · 不假装'
  })
  // 落盘失败：宿主返回的 `writeFailed` 不能丢 —— 内存清了但磁盘没写下去，
  // 下次启动历史会「回来」，只说「已清空」就是把假象当结果。
  historyClearOverride = {
    ledgerDays: 2, records: 10, rollupDays: 3, rollupUsd: 1.2,
    writeFailed: ['ledger.json: EACCES（拒绝访问）', 'days.json: EPERM'],
  }
  assert.ok(clickText(mount(CostPage), '清除全部历史'), '应有「清除全部历史」按钮')
  assert.ok(clickText(mount(CostPage), '再点一次确认清空'), '应能点到确认按钮')
  await tick()
  await tick()
  await tick()
  const writeFailedHtml = render(mount(CostPage))
  test('落盘失败 → 如实提示「内存已清，落盘失败：…」，不假装已清空', () => {
    assert.ok(writeFailedHtml.includes('落盘失败'), `应报落盘失败：${writeFailedHtml.slice(-260)}`)
    assert.ok(writeFailedHtml.includes('EACCES'), `失败原因要带出来：${writeFailedHtml.slice(-260)}`)
    assert.ok(!writeFailedHtml.includes('已清空：明细'), `不许只说「已清空」：${writeFailedHtml.slice(-260)}`)
    return '内存已清 · 落盘失败：原因已报'
  })
  historyClearOverride = null
})()

console.log('\n[左侧栏：余额可点击切换 DeepSeek 两条路线]')
await (async () => {
  const sidebar = component('sidebar.footer.action')
  /** store 已经加载过：改夹具后要让它重新取一次数（focus 正好是这条路径）。 */
  const reloadSidebar = async () => {
    dispatchWindowEvent('focus')
    await tick()
    await tick()
  }
  let tree = mount(sidebar.component)
  await tick()
  tree = mount(sidebar.component)
  const html = render(tree)
  test('侧栏：余额（多 key 之和）/ 今日 / 峰谷倒计时都在；峰谷表与价格表两行默认不显示', () => {
    for (const needle of ['余额', '¥1.51', '今日', '¥1.3997', '进入平价']) {
      assert.ok(html.includes(needle), `侧栏缺少「${needle}」：${html.slice(0, 200)}`)
    }
    // 这两个是**去改配置的入口**（不是用量），默认不占侧栏那点位置：
    // 同一件事在设置页「余额与费用」里都有（价格页更新价目、显示页看峰谷表）。
    for (const needle of ['峰谷表', '价格表']) {
      assert.ok(!html.includes(needle), `默认不该渲染「${needle}」：${html.slice(0, 200)}`)
    }
    return '余额/今日/峰谷条在 · 两个操作行默认收起'
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
    assert.equal(opened.includes('把 key'), false, '余额行不再显示 (N 把 key) / 使用中；明细里才展开')
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
  // 两个操作行默认不显示（上面那条断言过了）；要让它们回到侧栏，就打开「显示 → 界面」那位开关
  SIDEBAR.ui = { sidebarTools: true }
  await reloadSidebar()
  test('打开「侧栏显示峰谷表 / 价格表」→ 峰谷表默认收起，点「预览」才列出接下来的切换点', () => {
    const collapsed = render(mount(sidebar.component))
    assert.ok(collapsed.includes('峰谷表'), `侧栏应有峰谷表行：${collapsed.slice(0, 200)}`)
    assert.ok(collapsed.includes('预览'), '默认是「预览」按钮')
    assert.ok(collapsed.includes('价格表'), '同一个开关也把价格表那行带出来')
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
  // 侧栏那枚「更新」按钮只在这个开关打开时才存在 —— 打了宿主就得报结果（与设置页价格页同一个路由）
  const priceClicked = clickIn(sidebar.component, node => node.type === 'button' && render(node.props?.children) === '更新')
  await tick()
  await tick()
  const afterUpdate = render(mount(sidebar.component))
  test('同一开关下的「更新」照旧打宿主，结果行也照旧报出来', () => {
    assert.ok(priceClicked, '应能点到侧栏价格表那枚「更新」按钮')
    assert.ok(calls.some(call => call.path.endsWith('/prices/update')), '应发出 /prices/update')
    assert.ok(afterUpdate.includes('价目已更新'), `更新结果要如实报：${afterUpdate.slice(-300)}`)
    return '侧栏更新 → 结果行'
  })
  SIDEBAR.ui = undefined
  await reloadSidebar()
  test('关掉这个开关 → 两行一起收起（不留残影）', () => {
    const cleaned = render(mount(sidebar.component))
    assert.ok(!cleaned.includes('峰谷表'), `关掉后不该还有峰谷表行：${cleaned.slice(0, 200)}`)
    assert.ok(!cleaned.includes('价格表'), '关掉后不该还有价格表行')
    return '已收起'
  })
  // 旧聚合把「每一把都可用」收成路线级 isAvailable=false。总额有钱时不该再写「余额不足」。
  const savedOfficial = {
    amount: SIDEBAR_BALANCE_FIRST.amount,
    isAvailable: SIDEBAR_BALANCE_FIRST.isAvailable,
    keys: SIDEBAR_BALANCE_FIRST.keys,
  }
  SIDEBAR_BALANCE_FIRST.amount = 20.35
  SIDEBAR_BALANCE_FIRST.isAvailable = false
  SIDEBAR_BALANCE_FIRST.keys = [
    { ref: 'DEEPSEEK_API_KEY', label: 'API KEY 2', amount: 20.69, currency: 'CNY', isAvailable: true, granted: 0, toppedUp: 20.69, source: 'api-key' },
    { ref: 'DEEPSEEK_API_KEY_7', label: 'API KEY 7', amount: -0.34, currency: 'CNY', isAvailable: false, granted: 0, toppedUp: -0.34, source: 'api-key' },
  ]
  await reloadSidebar()
  const pickedOfficial = clickIn(sidebar.component, node => node.type === 'button' && render(node.props?.children) === 'DeepSeek')
  const mixedTree = mount(sidebar.component)
  test('部分 key 余额不足：总额行不写「余额不足」，只标在那一把上', () => {
    assert.ok(pickedOfficial, '明细里应能点回 DeepSeek')
    const header = []
    const dry = []
    const healthy = []
    walk(mixedTree, node => {
      if (node.props?.key === 'balance') header.push(render(node.props?.children))
      if (node.props?.key === 'DEEPSEEK_API_KEY_7') dry.push(render(node.props?.children))
      if (node.props?.key === 'DEEPSEEK_API_KEY') healthy.push(render(node.props?.children))
    })
    assert.ok(header.some(text => text.includes('¥20.35')), `总额应是两把之和：${header.join(' | ')}`)
    assert.ok(header.every(text => !text.includes('余额不足')), `总额行不该写余额不足：${header.join(' | ')}`)
    assert.ok(dry.some(text => text.includes('余额不足') && text.includes('¥-0.34')), `负余额那把要单独标：${dry.join(' | ')}`)
    assert.ok(healthy.every(text => !text.includes('余额不足')), `有余额的 key 不该标不足：${healthy.join(' | ')}`)
    return '总额 ¥20.35 · 仅 API KEY 7 余额不足'
  })
  SIDEBAR_BALANCE_FIRST.amount = -0.54
  SIDEBAR_BALANCE_FIRST.isAvailable = false
  SIDEBAR_BALANCE_FIRST.keys = [
    { ref: 'DEEPSEEK_API_KEY', label: 'API KEY 7', amount: -0.34, currency: 'CNY', isAvailable: false },
    { ref: 'DEEPSEEK_API_KEY_7', label: 'API KEY 8', amount: -0.2, currency: 'CNY', isAvailable: false },
  ]
  await reloadSidebar()
  const allDryTree = mount(sidebar.component)
  test('查到金额的 key 全都不可用：总额行才写「余额不足」', () => {
    const header = []
    walk(allDryTree, node => {
      if (node.props?.key === 'balance') header.push(render(node.props?.children))
    })
    assert.ok(header.some(text => text.includes('余额不足')), `全都不足时总额行要标出来：${header.join(' | ')}`)
    assert.ok(header.some(text => text.includes('¥-0.54')), `总额应是负的：${header.join(' | ')}`)
    return '总额 ¥-0.54 · 余额不足'
  })
  SIDEBAR_BALANCE_FIRST.amount = savedOfficial.amount
  SIDEBAR_BALANCE_FIRST.isAvailable = savedOfficial.isAvailable
  SIDEBAR_BALANCE_FIRST.keys = savedOfficial.keys
  await reloadSidebar()
  // 侧栏那侧的「隐藏区块」没在这里单测：夹具是 JSON 深拷贝，改完要重新拉 /sidebar 才生效。
  // 只要 `/sidebar` 带 `ui`（host 用例已断言）并且组件按 `ui.hide*` 分支渲染，覆盖就够；
  // 真正的手点验证留到真宿主里做。
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
  await tick()
  await tick()
  const iconTree = mount(Component, { provider: { provider: 'deepseek-official', settingsNs: 'llm-deepseek' } })
  const eyeButtons = []
  const copyButtons = []
  walk(iconTree, node => {
    if (node.type !== 'button') return
    const label = node.props?.['aria-label']
    if (label === '显示密钥' || label === '隐藏密钥') eyeButtons.push(node)
    if (label === '复制 key') copyButtons.push(node)
  })
  const buttonHasSvg = button => {
    let svg = false
    walk(button, node => { if (node.type === 'svg') svg = true })
    return svg
  }
  let written = null
  if (copyButtons.length > 0) {
    const savedNavigator = globalThis.navigator
    globalThis.navigator = { language: 'zh-CN', clipboard: { writeText(text) { written = text; return Promise.resolve() } } }
    try {
      copyButtons[0].props.onClick()
      await new Promise(resolve => setTimeout(resolve, 10))
    } finally {
      globalThis.navigator = savedNavigator
    }
  }
  test('密钥行：眼睛是 SVG 小图标；复制按钮走 reveal + clipboard，且不自动揭码', () => {
    assert.ok(eyeButtons.length > 0, '密钥行应有眼睛按钮')
    assert.ok(eyeButtons.every(buttonHasSvg), '眼睛应是 SVG，不是猴子 emoji')
    assert.ok(copyButtons.length > 0, '密钥行应有复制按钮')
    assert.ok(copyButtons.every(buttonHasSvg), '复制按钮应是图标')
    assert.equal(written, 'sk-copy-me', '复制按钮应把 /keys/reveal 的值写进剪贴板')
    assert.ok(render(iconTree).includes('••••••••'), '复制后仍保持打码（不自动揭开）')
    return `${eyeButtons.length} 个眼睛 · ${copyButtons.length} 个复制按钮`
  })
  test('非 DeepSeek 路线不显示密钥编辑区', () => {
    const htmlOther = render(mount(Component, { provider: { provider: 'walk-grok', settingsNs: 'llm-pi-ai' } }))
    assert.ok(!htmlOther.includes('添加 key'), `普通中转站卡片不该有 key 编辑区：${htmlOther.slice(0, 200)}`)
    return 'walk-grok 无编辑区'
  })
  test('账号路线（登录 token）不显示密钥编辑区', () => {
    // 账号路线的 `apiKeyEnv` 是 undefined → 候选名一个都推不出来：`/keys` 恒回空列表、
    // `nextRef` 是 null（填了值点「保存 key」只会拿到 400「没有可用的引用名」）。
    // 之前只判 `deepseekRoute !== undefined`，于是账号卡片上挂着一个死掉的输入框。
    const before = calls.length
    const htmlAccount = render(mount(Component, { provider: { provider: 'deepseek-account', settingsNs: 'llm-deepseek-account' } }))
    assert.ok(!htmlAccount.includes('添加 key'), `账号路线不该有 key 编辑区：${htmlAccount.slice(0, 200)}`)
    const hit = calls.slice(before).find(call => call.path.includes('/keys?provider=deepseek-account'))
    assert.equal(hit, undefined, '账号路线连 /keys 都不该请求（它没有 key 可管）')
    return '账号路线无编辑区、无 /keys 请求'
  })
  test('官方路线不出「供应商类型」那一格', () => {
    // 两条 DeepSeek 路线都是宿主固定的官方端点：余额走官方接口（账号 token / api.deepseek.com），
    // 探测链（`refreshOne` 的 sub2api 分支）对它们只会 404 或「未找到 API Key」。
    // 所以卡片上不出现类型下拉，也不出现那句「非 Sub2Api 供应商不查询额度」。
    for (const provider of [
      { provider: 'deepseek-official', settingsNs: 'llm-deepseek' },
      { provider: 'deepseek-account', settingsNs: 'llm-deepseek-account' },
    ]) {
      const treeOfficial = mount(Component, { provider })
      const html = render(treeOfficial)
      // 不能用「html 里有没有『供应商类型』这四个字」判：那句替代说明里也带着这个词
      // （「官方路线：没有供应商类型…」）。按节点判：卡片里不该有任何一个 `select`。
      const selects = []
      walk(treeOfficial, node => { if (node.type === 'select') selects.push(node) })
      assert.equal(selects.length, 0, `${provider.provider} 不该有类型下拉：${selects.length} 个 select`)
      assert.ok(!html.includes('Sub2Api'), `${provider.provider} 不该出现 Sub2Api（下拉项 + 那句说明都该收掉）：${html.slice(0, 300)}`)
      assert.ok(html.includes('官方路线：没有供应商类型，余额按官方接口查。'), `${provider.provider} 该说明官方路线的口径：${html.slice(0, 300)}`)
    }
    return 'official + account 两张卡都没有类型控件，只有一行口径说明'
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

  // ── 密钥区布局：不溢出、不叠字（截图里那条 + 「保存 key」被卡片右边缘切掉）──
  const dsProps = { provider: { provider: 'deepseek-official', settingsNs: 'llm-deepseek' } }
  /**
   * 把卡片树里「带样式」的节点连**父节点**一起摘出来。
   * 检查「值和状态文案是不是挤在同一行」必须看父节点（`walk` 只给节点自己）。
   */
  const nodesWithParent = element => {
    const pairs = []
    const parents = new Map()
    walk(element, node => {
      for (const child of [].concat(node.props?.children ?? [])) {
        if (child !== null && typeof child === 'object') parents.set(child, node)
      }
      pairs.push({ node, parent: parents.get(node), text: render(node.props?.children) })
    })
    return pairs
  }
  /** 「同一行」的容器：inline-flex，或 row 方向的 flex。 */
  const isRowContainer = style => style?.display === 'inline-flex'
    || (style?.display === 'flex' && style?.flexDirection !== 'column')

  let listTree = mount(Component, dsProps)
  await tick()
  listTree = mount(Component, dsProps)
  const pairs = nodesWithParent(listTree)

  test('密钥行：状态文案「主 key（宿主正在用）」另起一行，不再和值挤在同一行叠字', () => {
    // 只认「状态文案」那几个确切文本的节点（上层容器也含这些字，但它们不是文案本身）
    const stateTexts = ['主 key（宿主正在用）', '已配置', '未配置']
    const stateNodes = pairs.filter(item => stateTexts.includes(item.text))
    assert.equal(stateNodes.length, 2, `两把 key 各该有一句状态文案，实际 ${JSON.stringify(stateNodes.map(i => i.text))}`)
    for (const item of stateNodes) {
      assert.equal(isRowContainer(item.parent?.props?.style), false,
        `状态文案仍和值挤在同一行（父节点 ${JSON.stringify(item.parent?.props?.style)}）—— 窄宽度下就是截图里的叠字`)
      // 自己也要能收能断：不然长文案在窄卡片里溢出
      assert.equal(item.node.props.style.minWidth, 0, '状态文案要能缩到 0')
      assert.equal(item.node.props.style.overflowWrap, 'anywhere', '状态文案要能断行')
    }
    const code = pairs.find(item => item.node.type === 'code')
    assert.ok(code !== undefined, '找不到打码的密钥值节点')
    assert.ok(/••••/.test(code.text), `值节点应是打码值：${JSON.stringify(code.text)}`)
    assert.equal(/主 key|已配置/.test(code.parent.text), false,
      `值所在那一行不该再写状态文案：${JSON.stringify(code.parent.text)}`)
    return `${stateNodes.length} 处状态文案各自独立一行`
  })
  test('密钥值：省略号收尾 + minWidth 0（长 key 撑不破卡片）', () => {
    const code = pairs.find(item => item.node.type === 'code')
    const style = code.node.props.style
    assert.equal(style.textOverflow, 'ellipsis')
    assert.equal(style.minWidth, 0)
    assert.equal(style.whiteSpace, 'nowrap')
    assert.equal(style.maxWidth, '100%')
    return `code { minWidth: 0 · textOverflow: ellipsis · maxWidth: 100% }`
  })
  test('「保存 key」按钮不被切：所在行可换行、输入框不写死宽度且能缩到 0', () => {
    const save = pairs.find(item => item.node.type === 'button' && item.text === '保存 key')
    assert.ok(save !== undefined, `找不到「保存 key」按钮：${pairs.map(i => i.text).filter(Boolean).slice(0, 20).join(' | ')}`)
    const rowStyle = save.parent?.props?.style
    assert.equal(rowStyle?.display, 'flex', `按钮应在一个 flex 行里：${JSON.stringify(rowStyle)}`)
    assert.equal(rowStyle?.flexWrap, 'wrap', '窄宽度下按钮要能换行，而不是被卡片右边缘切掉')
    assert.equal(rowStyle?.minWidth, 0, '这一行要能缩到 0')
    const input = pairs.find(item => item.node.type === 'input' && item.node.props?.type === 'password')
    const inputStyle = input.node.props.style
    assert.equal(inputStyle.minWidth, 0, '输入框要能缩到 0（否则把按钮挤出卡片）')
    assert.equal(typeof inputStyle.width, 'string', `不该写死数字宽度：${JSON.stringify(inputStyle.width)}`)
    assert.equal(inputStyle.flex, '1 1 160px', `输入框应随卡片伸缩：${JSON.stringify(inputStyle.flex)}`)
    return `输入框 flex ${inputStyle.flex} · 行 flexWrap wrap`
  })
  test('两列布局用 minmax(0, 1fr)：右列不再是 min-content（整块不再顶出卡片）', () => {
    const grids = pairs.filter(item => item.node.props?.style?.gridTemplateColumns !== undefined)
    assert.ok(grids.length > 0, '找不到两列网格')
    for (const item of grids) {
      assert.equal(item.node.props.style.gridTemplateColumns, 'auto minmax(0, 1fr)')
    }
    return `grid-template-columns: ${grids[0].node.props.style.gridTemplateColumns}`
  })
  test('密钥行右侧显示余额，用尽的 key 用警示色；有「查询余额」按钮', () => {
    // 打开卡片就会查一次。假渲染器每次挂载都会重跑 effect，截到的是「读取中…」而不是空闲文案。
    const query = pairs.find(item => item.node.type === 'button' && (item.text === '查询余额' || item.text === '读取中…'))
    assert.ok(query !== undefined, `找不到「查询余额」：${pairs.map(i => i.text).filter(Boolean).slice(0, 24).join(' | ')}`)
    const amounts = pairs.filter(item => item.text === '¥20.69' || item.text === '¥-0.34')
    assert.equal(amounts.length, 2, `两把 key 各该有余额，实际 ${JSON.stringify(amounts.map(i => i.text))}`)
    const fresh = amounts.find(item => item.text === '¥20.69')
    const dry = amounts.find(item => item.text === '¥-0.34')
    assert.equal(fresh.node.props.style.marginLeft, 'auto', '余额要贴在行的右侧')
    assert.equal(dry.node.props.style.marginLeft, 'auto')
    assert.match(String(dry.node.props.style.color), /label-error|#d33/, '用尽的 key 余额要用警示色')
    const code = pairs.find(item => item.node.type === 'code')
    assert.equal(code.parent, fresh.parent, '余额和打码值在同一行，才落在截图里右侧那块空位')
    assert.equal(/主 key|已配置/.test(fresh.parent.text), false, '余额不该把状态文案拽回值那一行')
    return `¥20.69 · ¥-0.34 · 查询余额`
  })
  // 旧宿主进程没有 `/keys/balances`，点查询不能停在红字 not found。
  keysBalanceMissing = true
  keysBalanceRefreshOverride = {
    balances: [{
      provider: 'deepseek-official',
      keys: [
        { ref: 'DEEPSEEK_API_KEY', amount: 9.5, currency: 'CNY', isAvailable: true },
        { ref: 'DEEPSEEK_API_KEY_2', amount: 1.25, currency: 'CNY', isAvailable: true },
      ],
    }],
  }
  const beforeFallback = calls.length
  mount(Component, dsProps)
  await tick()
  const fallbackTree = mount(Component, dsProps)
  const fallbackHtml = render(fallbackTree)
  test('旧宿主没有 /keys/balances：改打余额刷新，右侧仍显示金额', () => {
    const hitBalances = calls.slice(beforeFallback).some(call => call.path.includes('/keys/balances'))
    const hitRefresh = calls.slice(beforeFallback).some(call => call.path.endsWith('/balance/refresh') && call.method === 'POST')
    assert.equal(hitBalances, true, '应先打新路由')
    assert.equal(hitRefresh, true, '404 后应退回 /balance/refresh')
    assert.ok(fallbackHtml.includes('¥9.50'), `刷新回来的金额要画出来：${fallbackHtml.slice(0, 400)}`)
    assert.ok(fallbackHtml.includes('¥1.25'), '第二把 key 的金额也要在')
    assert.equal(fallbackHtml.includes('not found'), false, '退回成功时不该留下 not found')
    return '404 → /balance/refresh · ¥9.50'
  })
  keysBalanceMissing = false
  keysBalanceRefreshOverride = null
  // 宿主按供应商过滤后一把都没剩（用户还没配）：界面要明确说清，且**不本地补一份候选名**
  keysOverride = { provider: 'deepseek-official', primaryRef: 'DEEPSEEK_API_KEY', nextRef: 'DEEPSEEK_KEY', scanned: 0, keys: [] }
  mount(Component, dsProps)
  await tick()
  const emptyTree = mount(Component, dsProps)
  const emptyHtml = render(emptyTree)
  const emptyPairs = nodesWithParent(emptyTree)
  test('一把 key 都没有：卡片明确说清，且候选名只用宿主给的那一个', () => {
    assert.ok(emptyHtml.includes('这个供应商还没有可用的密钥引用'),
      `空列表必须说清（别让人以为界面坏了）：${emptyHtml.slice(0, 400)}`)
    const note = emptyPairs.find(item => item.node.props?.style?.gridColumn === '1 / -1')
    assert.ok(note !== undefined, `空列表说明应整行铺满（gridColumn 1/-1）：${emptyPairs.map(i => i.text).filter(Boolean).slice(0, 12).join(' | ')}`)
    assert.ok(note.text.includes('这个供应商还没有可用的密钥引用'), `整行说明得是那句话：${JSON.stringify(note.text)}`)
    assert.equal(note.node.props.style.overflowWrap, 'anywhere', '窄卡片里要能断行')
    const input = emptyPairs.find(item => item.node.type === 'input' && item.node.props?.type === 'password')
    assert.equal(input.node.props.placeholder, 'DEEPSEEK_KEY', 'placeholder 用宿主给的 nextRef')
    assert.equal(emptyHtml.includes('DEEPSEEK_API_KEY_2'), false, '本地不许再补一份全局候选名清单')
    return '说清 · 整行说明 · 候选名只认宿主的 nextRef'
  })
  keysOverride = null
})()
/**
 * 逼设置页 store 重新拉一次 `/report`：宿主夹具改完之后必须走这一步
 * （fetch 是 JSON 往返，改夹具不会自动生效）。分页标签按语言不同，两版都试。
 */
const reloadReportPage = async () => {
  await tick()
  await tick()
  await tick()
  const clicked = clickText(mount(CostPage), '刷新') || clickText(mount(CostPage), 'Refresh')
  assert.ok(clicked, '找不到「刷新 / Refresh」按钮')
  await tick()
  await tick()
  await tick()
}
/** 切到某个分页并取回渲染结果（点不动就报出来，别让用例静默跳过）。 */
const openCostTab = (zhLabel, enLabel, marker) => {
  const clicked = clickText(mount(CostPage), zhLabel) || clickText(mount(CostPage), enLabel)
  const html = render(mount(CostPage))
  return { clicked, html, markerVisible: html.includes(marker) }
}

// ────────── 显示页文案：新控件的 33 个键必须在 `S` 表里（早先整批写进了 `S2`）──────────
console.log('\n[显示页文案：新控件的标题 / 说明 / 勾选框文案（S 表）]')
await (async () => {
  const savedUi = { ...REPORT.ui }
  const openDisplay = () => {
    const clicked = clickText(mount(CostPage), '显示') || clickText(mount(CostPage), 'Display')
    const page = mount(CostPage)
    return { clicked, page, html: render(page), texts: checkboxes(page).map(item => item.text) }
  }
  try {
    await reloadReportPage()
    const zh = openDisplay()
    // 切英文：同一批控件的英文文案也得挪过去（只挪 zh 那份 = 英文页照旧空白）
    REPORT.ui = { ...savedUi, locale: 'en' }
    await reloadReportPage()
    // 分页键没变（还是 display），语言切完不用再点一次分页
    const enPage = mount(CostPage)
    const en = { html: render(enPage), texts: checkboxes(enPage).map(item => item.text) }

    test('显示页：四个新分组标题 + 四段说明都渲染出来了', () => {
      assert.ok(zh.clicked, '点不到「显示」分页')
      for (const needle of ['模型花费卡片', '本会话费用', '额度横条', '右下角角标']) {
        assert.ok(zh.html.includes(needle), `显示页缺少分组「${needle}」：${zh.html.slice(-400)}`)
      }
      for (const needle of ['「近 90 天」读日汇总', '每 15 秒刷新一次', '峰谷档位与倒计时', '可选 Top-1 模型',
        '接下来 6 个档位切换点']) {
        assert.ok(zh.html.includes(needle), `显示页缺少说明「${needle}」：${zh.html.slice(-400)}`)
      }
      return '4 个标题 + 4 段说明'
    })
    test('显示页：12 个勾选框都有文案（空串 = 文案键还留在 S2 里）', () => {
      const labels = ['显示模型花费卡片', '默认展开', '记住展开状态', '显示 Token', '显示费用占比条',
        '显示本会话费用', '显示缓存命中率', '包含子代理', '显示输入框上方的额度横条', '横条里也显示余额',
        '显示右下角角标', '角标里带 Top-1 模型']
      const empty = zh.texts.filter(text => text.trim().length === 0)
      assert.deepEqual(empty, [], `有 ${empty.length} 个勾选框没有文案（文案键还在 S2 那张表里）`)
      for (const label of labels) {
        assert.ok(zh.texts.includes(label), `缺少勾选框「${label}」，实际：${zh.texts.join(' / ')}`)
      }
      return `${zh.texts.length} 个勾选框 · 12 个新控件都有文案`
    })
    test('切到英文：同一批控件的英文文案也在（两份表都要挪）', () => {
      for (const needle of ['Model cost card', 'This session', 'Quota strip', 'Corner badge']) {
        assert.ok(en.html.includes(needle), `英文页缺少分组「${needle}」：${en.html.slice(-400)}`)
      }
      const labels = ['Show the model cost card', 'Expanded by default', 'Remember expanded state',
        'Show tokens', 'Show cost share bars', 'Show this-session cost', 'Show cache hit rate',
        'Include subagents', 'Show the strip above the input', 'Also show the balance in the strip',
        'Show the corner badge', 'Include the Top-1 model',
        'Show peak schedule & price table in the sidebar']
      const empty = en.texts.filter(text => text.trim().length === 0)
      assert.deepEqual(empty, [], `英文页有 ${empty.length} 个勾选框没有文案`)
      for (const label of labels) {
        assert.ok(en.texts.includes(label), `英文页缺少勾选框「${label}」，实际：${en.texts.join(' / ')}`)
      }
      assert.ok(en.html.includes('Peak schedule'), `英文页缺少峰谷表：${en.html.slice(-400)}`)
      return `${en.texts.length} 个勾选框 · 英文文案齐全`
    })
    // 峰谷关掉时 `/report` 的 `peak` 是 null：那张表要明说原因，不是留一张空表
    const savedPeak = REPORT.peak
    REPORT.peak = null
    REPORT.ui = savedUi   // 上面刚切过英文，空态文案按中文那版断言
    await reloadReportPage()
    const noPeakHtml = render(mount(CostPage))
    REPORT.peak = savedPeak
    await reloadReportPage()
    test('峰谷关着（peak 为 null）→ 那张表写「峰谷没有开启」，不装作没有切换点', () => {
      assert.ok(noPeakHtml.includes('峰谷没有开启'), `空态要有说明：${noPeakHtml.slice(-400)}`)
      return '空态有说明'
    })
  } finally {
    REPORT.ui = savedUi
    await reloadReportPage()
  }
})()

// ────────── 热力图摘要：读 heat 自己的数 / 周数 = 列数 / 空数据不渲染 ──────────
console.log('\n[用量页热力图摘要：读 heat 自己的数、周数 = 列数、空数据不渲染]')
await (async () => {
  const savedHeat = REPORT.heatmap
  /** 与客户端同一个写法（测试侧独立算一遍，别从实现里借） */
  const tokensText = value => (value < 1e3
    ? String(Math.round(value))
    : value < 1e6 ? `${(value / 1e3).toFixed(1)}K` : `${(value / 1e6).toFixed(1)}M`)
  const heatTokens = savedHeat.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0)
  const heatCalls = savedHeat.reduce((sum, row) => sum + (Number(row.calls) || 0), 0)
  const allTokens = REPORT.totals.all.tokens.total
  const firstWeekday = new Date(Date.parse(`${savedHeat[0].date}T00:00:00Z`)).getUTCDay()
  const columns = Math.ceil((firstWeekday + savedHeat.length) / 7)
  const openUsage = () => openCostTab('用量', 'Usage', 'Token 用量统计')
  try {
    await reloadReportPage()
    test('摘要给的是 heat 这一档的合计（不是 totals.all 的全历史量）', () => {
      const { clicked, html, markerVisible } = openUsage()
      assert.ok(clicked && markerVisible, `点不到「用量」分页：${html.slice(0, 200)}`)
      assert.ok(allTokens > heatTokens * 10, '夹具前提：全历史明显大于热力图这 182 天')
      assert.ok(html.includes(`${tokensText(heatTokens)} tokens · ${heatCalls} 次调用`),
        `摘要应是 heat 的合计（${tokensText(heatTokens)} / ${heatCalls}）：${html.slice(-400)}`)
      assert.ok(!html.includes(`${tokensText(allTokens)} tokens`),
        `不许把 totals.all 的量挂到「近 N 周」下面：${html.slice(-400)}`)
      assert.ok(!html.includes(`${REPORT.totals.all.calls} 次调用`), '调用次数同理，要给 heat 的合计')
      return `${tokensText(heatTokens)} tokens · ${heatCalls} 次调用`
    })
    test('周数 = 渲染出来的列数（首日周三补 3 格 → 27 列，不是 ceil(182/7)=26）', () => {
      const { html } = openUsage()
      assert.equal(firstWeekday, 3, '夹具前提：热力图首日是周三（否则测不到差一列）')
      assert.equal(columns, 27, '夹具前提：补位后是 27 列')
      assert.ok(html.includes(`近 ${columns} 周`), `周数该等于列数 ${columns}：${html.slice(-400)}`)
      assert.ok(!html.includes('近 26 周'), '`ceil(len / 7)` 会少算首日补位那一列')
      return `近 ${columns} 周 = 列数`
    })
    test('token 真 0 仍画 0（用量页「缓存写入」就是 0；缺值才画 —）', () => {
      const { html } = openUsage()
      assert.ok(html.includes('缓存写入 0'), `真 0 该画 0：${html.slice(0, 300)}`)
      return '缓存写入 0'
    })
    // 空 heatmap（老宿主没给这一档）：摘要整段不渲染
    REPORT.heatmap = []
    await reloadReportPage()
    test('老宿主没给 heatmap（空数组）→ 摘要不渲染（别编「近 1 周 0 tokens」）', () => {
      const { html, markerVisible } = openUsage()
      assert.ok(markerVisible, `热力图那块还在：${html.slice(-400)}`)
      assert.ok(!/近 \d+ 周/.test(html), `空数据不该有摘要：${html.slice(-400)}`)
      return '标题在 · 摘要不渲染'
    })
  } finally {
    REPORT.heatmap = savedHeat
    await reloadReportPage()
  }
})()

// ────────── 侧栏：隐藏今日消耗的边界 / 角标只藏金额 / 横条倒计时自算 ──────────
console.log('\n[侧栏：隐藏今日消耗的边界 / 角标只藏金额 / 横条倒计时自算]')
await (async () => {
  const sidebar = component('sidebar.footer.action')
  const strip = component('conversation.input.dock', 1).component
  const corner = component('conversation.composer.dock', 0).component
  const saved = {
    // 注意：不能用 `SIDEBAR.modelCard` —— 前面那节把它复位成了 `undefined`（见 MODEL_CARD_FIXTURE 注释）
    modelCard: MODEL_CARD_FIXTURE, ui: SIDEBAR.ui, corner: SIDEBAR.corner,
    quotaStrip: SIDEBAR.quotaStrip, peak: SIDEBAR.peak,
  }
  const reloadSidebar = async () => {
    dispatchWindowEvent('focus')
    await tick()
    await tick()
  }
  try {
    SIDEBAR.ui = { hideTodayCost: true }
    SIDEBAR.modelCard = { ...saved.modelCard, enabled: true, period: 'today', position: 'bottom' }
    await reloadSidebar()
    const todayHtml = render(mount(sidebar.component))
    SIDEBAR.modelCard = { ...saved.modelCard, enabled: true, period: 'days90', position: 'bottom' }
    await reloadSidebar()
    const days90Html = render(mount(sidebar.component))
    test('隐藏今日消耗：今日金额行 + 「今日」周期的模型花费卡片整块收起', () => {
      assert.ok(!todayHtml.includes('今日 ¥1.3997'), `今日金额行不该渲染：${todayHtml.slice(0, 260)}`)
      assert.ok(!todayHtml.includes('模型花费'), '周期=今日的卡片要整块收起（标题与每行都是今日金额）')
      return '今日行 + 卡片都不渲染'
    })
    test('说明里写明的「统计不受影响」得算数：次数 / token / 命中率照旧', () => {
      for (const needle of ['160 次', '65.5M tok', '命中 98.6%']) {
        assert.ok(todayHtml.includes(needle), `统计不该跟着藏：缺少「${needle}」：${todayHtml.slice(0, 260)}`)
      }
      return '160 次 · 65.5M tok · 命中 98.6%'
    })
    test('周期改成「近 90 天」→ 卡片照常显示（藏的是今日金额，不是历史花费）', () => {
      assert.ok(days90Html.includes('模型花费'), `近 90 天的卡片该照常显示：${days90Html.slice(0, 260)}`)
      assert.ok(days90Html.includes('近 90 天 ¥1.5437'), `标题应给周期与金额：${days90Html.slice(0, 260)}`)
      return '近 90 天照旧'
    })

    SIDEBAR.corner = { enabled: true, showTop1: true }
    await reloadSidebar()
    const cornerHtml = render(mount(corner, {}))
    test('角标：只藏「今日金额」那一段，峰谷档位与 Top-1 照显', () => {
      assert.ok(!cornerHtml.includes('今日'), `金额那一段该藏：${cornerHtml}`)
      assert.ok(cornerHtml.includes('峰时'), '档位不该跟着藏（藏了就等于不知道自己在峰段）')
      assert.ok(cornerHtml.includes('Top-1 cn:deepseek-v4.1-flash'), `Top-1 照显：${cornerHtml}`)
      return '峰时 · Top-1（无金额）'
    })

    SIDEBAR.ui = {}
    SIDEBAR.quotaStrip = { enabled: true, showBalance: true }
    // 宿主按 Accept-Language（英文）预格式化的串 + 本地时钟自算：客户端不该用前者
    SIDEBAR.peak = {
      ...saved.peak,
      inPeak: true,
      nextAtMs: Date.now() + 2 * 3600_000 + 5 * 60_000 + 30_000,
      countdown: '2 hours 5 min',
      countdownMs: 7_530_000,
    }
    await reloadSidebar()
    const stripHtml = render(mount(strip, {}))
    test('横条倒计时自己算（不跟着宿主预格式化的串换语言）', () => {
      assert.ok(!stripHtml.includes('2 hours 5 min'), `不该直接用宿主串：${stripHtml}`)
      assert.ok(stripHtml.includes('2 小时 5 分'), `应按 ui.locale 自算：${stripHtml}`)
      return '2 小时 5 分（宿主串是英文也不跟）'
    })
  } finally {
    SIDEBAR.modelCard = saved.modelCard
    SIDEBAR.ui = saved.ui
    SIDEBAR.corner = saved.corner
    SIDEBAR.quotaStrip = saved.quotaStrip
    SIDEBAR.peak = saved.peak
  }
  await reloadSidebar()
})()

console.log('\n[左侧栏：WorkBuddy 积分型 —— 今日那一行换单位，且不污染金额]')
await (async () => {
  const sidebar = component('sidebar.footer.action')
  const saved = { credits: SIDEBAR.credits, providers: SIDEBAR.providers }
  try {
    SIDEBAR.providers = [
      ...SIDEBAR.providers.filter(item => item.provider !== 'wbfd'),
      { provider: 'wbfd', displayName: 'wbfd', calls: 517, priced: 0, unpriced: 517, usd: 0, amount: 1.3997, tokens: 76_708_000, hitRate: 0.984 },
    ]
    SIDEBAR.credits = [{
      provider: 'wbfd', displayName: 'wbfd', status: 'ok', period: 'today',
      ownCredits: 137.42, ownCalls: 517, ownUnknown: 2, truncated: false,
      siteCredits: 849.14, siteTokens: 900_000_000, siteHitRate: 99.1,
      filter: { userAgent: 'deepseek-harness' },
    }]
    dispatchWindowEvent('focus')
    await tick()
    await tick()
    /**
     * 供应商选择是**组件内 state**，而本测试台架的 effect 只在挂载时跑一次，
     * 所以不能靠 localStorage 让后面的挂载再选一次 —— 直接在活实例上触发 select 的
     * onChange（`clickIn` 的手法），否则渲染出来永远停在「全部」。
     */
    let picked = false
    mount(sidebar.component, {}, node => {
      if (picked || node.type !== 'select') return
      node.props?.onChange?.({ target: { value: 'wbfd' } })
      picked = true
    })
    const html = render(mount(sidebar.component))
    test('诊断：这次渲染确实切到了 wbfd', () => {
      assert.equal(picked, true, '没找到侧栏的供应商 select')
      assert.ok(html.includes('wbfd'), `未落在 wbfd：${html.slice(0, 200)}`)
    })
    test('今日那一行换成「积分」，且带上自身口径的数值', () => {
      assert.ok(html.includes('137.42 积分'), `应有积分：${html.slice(0, 300)}`)
      return '137.42 积分'
    })
    test('金额被替换掉，不是两行并列（积分不是钱，不能同时给一个 ¥ 数）', () => {
      assert.equal(html.includes('今日¥1.3997'), false, `今日行不该再是金额：${html.slice(0, 300)}`)
    })
    test('站方全量只作对照、单独标注', () => {
      assert.ok(html.includes('站方全量 849.14'), `应有站方对照：${html.slice(0, 300)}`)
      return '站方全量 849.14'
    })
    test('过滤条件与「无积分记录」都写在旁注里（用户要能看见口径与缺口）', () => {
      assert.ok(html.includes('deepseek-harness'), `应显示过滤条件：${html.slice(0, 300)}`)
      assert.ok(html.includes('2 笔无积分记录'), `应显示缺 credit 的条数：${html.slice(0, 300)}`)
      return '按 deepseek-harness 过滤 · 2 笔无积分记录'
    })
    test('未标记 truncated 时不出现「可能漏数」的告警（不无中生有）', () => {
      assert.equal(html.includes('可能漏数'), false)
    })
  } finally {
    SIDEBAR.credits = saved.credits
    SIDEBAR.providers = saved.providers
  }
})()

console.log('\n[侧栏：底部块独占一行（兼容其他 footer 插件）]')
await (async () => {
  const sidebar = component('sidebar.footer.action')
  test('余额块根节点自己占满一行（flex-basis / width 100% + border-box）', () => {
    let root = null
    walk(mount(sidebar.component), node => {
      if (node.props?.['data-balance-monitor'] === 'sidebar') root = node
    })
    assert.ok(root !== null, '应渲染余额块根节点')
    assert.equal(root.props.style.flexBasis, '100%', 'flex-basis 应是 100%（独占一行）')
    assert.equal(root.props.style.width, '100%', '宽度应是 100%')
    assert.equal(root.props.style.boxSizing, 'border-box', '左右 padding 不能把整行撑出侧栏')
    return 'flex-basis 100% · border-box'
  })
  test('注入样式给宿主 footer 打开 flex-wrap（:has 从数据标记反选父容器）', () => {
    const tag = injectedStyles.find(item => item?.dataset?.pluginCss === 'dsh-balance-monitor/sidebar-footer.css')
    assert.ok(tag !== undefined, `应注入侧栏底部样式，实际：${JSON.stringify(injectedStyles.map(item => item?.dataset))}`)
    assert.match(tag.textContent, /:has\(>\s*\[data-slot="sidebar\.footer\.action"\]/)
    assert.match(tag.textContent, /:has\(>\s*\[data-balance-monitor="sidebar"\]\)/)
    assert.match(tag.textContent, /flex-wrap:\s*wrap/)
    return 'footer 可换行 · 余额块落到下一行'
  })
  test('折叠侧栏 / 移动端 56px 抽屉（wide=false）整块不渲染，展开后恢复', () => {
    const hiddenTree = mount(sidebar.component, { wide: false })
    assert.equal(render(hiddenTree), '', '窄栏不该渲染余额块')
    let root = null
    walk(mount(sidebar.component, { wide: true }), node => {
      if (node.props?.['data-balance-monitor'] === 'sidebar') root = node
    })
    assert.ok(root !== null, '宽栏应渲染余额块')
    return 'wide=false 隐藏 · wide=true 显示'
  })
})()

console.log('\n[侧栏：进行中 / 待查看轨道的注册链]')
await (async () => {
  test('footer 里两块：余额条（order 10）+ 轨道控制器（order 80，渲染 null）', () => {
    const regs = slots.get('sidebar.footer.action') ?? []
    assert.equal(regs.length, 2, `应有 2 个注册，实际 ${regs.length}`)
    const rail = regs[1]().registration
    assert.equal(rail.id, 'balance-monitor:running-rail')
    assert.equal(rail.order, 80)
    return '2 块 · 轨道 order 80'
  })
  test('窄侧栏徽章也一起注册', () => {
    const regs = slots.get('sidebar.toggle.badge') ?? []
    assert.equal(regs.length, 1, `应注册 sidebar.toggle.badge，实际 ${regs.length}`)
    return '1 个'
  })
  test('控制器用 ctx.get 取四个服务（不碰 ctx.xxx / ctx.inject）', () => {
    const html = render(mount(component('sidebar.footer.action', 1).component))
    for (const name of ['sessions', 'workspaces', 'uiWorkspace', 'uiSession']) {
      assert.ok(requestedServices.includes(name), `应查询 ${name}，实际：${JSON.stringify([...new Set(requestedServices)])}`)
    }
    assert.equal(html.includes('进行中'), false, `空态不该出现轨道：${html.slice(0, 200)}`)
    return new Set(requestedServices).size + ' 个服务'
  })
  test('服务拿不到时也不能把 apply 炸掉（ctx 只有 get 且全返回 undefined）', () => {
    const bare = {
      slots: slotsApi,
      effect() {},
      get() { return undefined },
    }
    assert.doesNotThrow(() => entry.factory(requireStub).apply(bare), 'apply 不该抛')
    return 'apply 未抛'
  })
})()

console.log('\n[侧栏：进行中 / 待查看两段真的渲染]')
await (async () => {
  /**
   * 轨道控制器返回 null，真正的 DOM 由 effect 直接插到工作区列表上方。
   * 这里搭一个只够轨道用的 DOM：树 / 滚动区 / 侧栏根，加上 style 与
   * MutationObserver 替身；不引 jsdom，也不碰真实宿主。
   */
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName
      this.children = []
      this.parentElement = null
      this.attributes = {}
      this.dataset = {}
      this.className = ''
      this.textContent = ''
      this.id = ''
      this.title = ''
      this.type = ''
      this.role = null
      this.listeners = new Map()
    }
    get nextElementSibling() {
      if (this.parentElement === null) return null
      const index = this.parentElement.children.indexOf(this)
      return this.parentElement.children[index + 1] ?? null
    }
    get previousElementSibling() {
      if (this.parentElement === null) return null
      const index = this.parentElement.children.indexOf(this)
      return index <= 0 ? null : this.parentElement.children[index - 1]
    }
    appendChild(child) {
      if (child.parentElement !== null) child.remove()
      this.children.push(child)
      child.parentElement = this
      return child
    }
    append(...nodes) { for (const node of nodes) this.appendChild(node) }
    insertBefore(child, reference) {
      if (child.parentElement !== null) child.remove()
      const index = this.children.indexOf(reference)
      this.children.splice(index < 0 ? this.children.length : index, 0, child)
      child.parentElement = this
      return child
    }
    replaceChildren(...nodes) {
      for (const child of [...this.children]) child.remove()
      for (const node of nodes) this.appendChild(node)
    }
    remove() {
      if (this.parentElement === null) return
      const index = this.parentElement.children.indexOf(this)
      if (index >= 0) this.parentElement.children.splice(index, 1)
      this.parentElement = null
    }
    setAttribute(name, value) {
      const text = String(value)
      this.attributes[name] = text
      if (name === 'id') this.id = text
      if (name === 'class') this.className = text
      if (name === 'role') this.role = text
    }
    getAttribute(name) {
      if (name === 'id') return this.id || null
      if (name === 'class') return this.className || null
      if (name === 'role') return this.role
      return this.attributes[name] ?? null
    }
    addEventListener(name, handler) {
      const list = this.listeners.get(name) ?? []
      list.push(handler)
      this.listeners.set(name, list)
    }
    click() {
      for (const handler of this.listeners.get('click') ?? []) {
        handler({ preventDefault() {}, stopPropagation() {} })
      }
    }
    findDescendant(predicate) {
      for (const child of this.children) {
        if (predicate(child)) return child
        const nested = child.findDescendant(predicate)
        if (nested !== null) return nested
      }
      return null
    }
    querySelector(selector) {
      if (selector === '[data-row-key]') {
        return this.findDescendant(element => element.attributes['data-row-key'] !== undefined)
      }
      if (selector === 'input') return this.findDescendant(element => element.tagName === 'input')
      return null
    }
    querySelectorAll() { return [] }
    closest(selector) {
      let node = this
      while (node !== null) {
        if (selector === '[role="tree"]' && node.role === 'tree') return node
        node = node.parentElement
      }
      return null
    }
    getBoundingClientRect() {
      return { width: 320, height: 600, top: 0, left: 0, right: 320, bottom: 600 }
    }
  }

  const allNodes = []
  const panel = new FakeElement('div')
  const listArea = new FakeElement('div')
  const placeholder = new FakeElement('div')
  const tree = new FakeElement('div')
  const treeRow = new FakeElement('div')
  tree.setAttribute('role', 'tree')
  treeRow.setAttribute('data-row-key', 'workspace:ws-1')
  treeRow.setAttribute('aria-expanded', 'false')
  panel.appendChild(placeholder)
  panel.appendChild(listArea)
  listArea.appendChild(tree)
  tree.appendChild(treeRow)
  let workspaceExpanded = 0
  treeRow.addEventListener('click', () => { workspaceExpanded += 1 })

  const head = new FakeElement('head')
  const body = new FakeElement('body')
  allNodes.push(panel, listArea, placeholder, tree, treeRow, head, body)
  const styleTagOf = selector => {
    const match = /data-plugin-css="([^"]+)"/.exec(selector)
    if (match === null) return null
    return head.children.find(tag => tag.dataset.pluginCss === match[1]) ?? null
  }
  const documentNode = {
    head,
    body,
    createElement(tagName) {
      const element = new FakeElement(tagName)
      allNodes.push(element)
      return element
    },
    // 浏览器 getElementById 只认还在文档树里的节点；这里用 parentElement 近似
    // （host 被 remove 后 parent 为 null，不能再被查到）。
    getElementById(id) { return allNodes.find(element => element.id === id && element.parentElement !== null) ?? null },
    querySelector(selector) {
      if (selector.includes('data-row-key')) return treeRow
      if (selector.includes('listArea')) return listArea
      if (selector.startsWith('style[')) return styleTagOf(selector)
      return null
    },
    querySelectorAll() { return [] },
  }

  const storage = new Map()
  const writes = []
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: documentNode })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, String(value)); writes.push({ key, value: String(value) }) },
      removeItem: key => storage.delete(key),
    },
  })
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.requestAnimationFrame = handler => { handler(); return 1 }
  globalThis.cancelAnimationFrame = () => {}

  railServices.sessions.list = fakeSnapshotStore({
    ids: ['run-1', 'done-1'],
    byId: {
      'run-1': { id: 'run-1', title: 'Running task', running: true, updatedAt: 3, retainedBy: {} },
      'done-1': { id: 'done-1', title: 'Done task', running: false, updatedAt: 2, retainedBy: {} },
    },
    phase: 'ready',
    projectionsBySession: {},
  })
  railServices.workspaces.list = fakeSnapshotStore({
    items: [{ workspaceId: 'ws-1', title: 'Alpha', path: 'D:/alpha', sessionIds: ['run-1', 'done-1'] }],
    archivedSessionIds: [],
  })
  railServices.uiSession.sessionStatus = fakeSnapshotStore(new Map([
    ['run-1', { running: true }],
    ['done-1', { running: false, completionUnread: true }],
  ]))
  const opened = []
  railServices.uiWorkspace.openSession = id => { opened.push(id) }

  mount(component('sidebar.footer.action', 1).component)
  const host = documentNode.getElementById('dsh-bm-rr-host')

  test('两段顺序：进行中在上，待查看在下，host 插在滚动区前', () => {
    assert.ok(host !== null, '轨道 host 应被插入')
    assert.equal(host.children.length, 2)
    assert.equal(host.children[0].children[0].children[1].textContent, '进行中')
    assert.equal(host.children[1].children[0].children[1].textContent, '待查看')
    assert.equal(host.nextElementSibling, listArea)
    return '进行中 / 待查看'
  })
  test('待查看行用绿点 + 标题 + 工作区，aria-label 带「已完成，待查看」', () => {
    const section = host.children[1]
    const row = section.children[1]
    assert.equal(row.children[0].className, 'dsh-bm-rr-done')
    assert.equal(row.children[1].textContent, 'Done task')
    assert.equal(row.children[2].textContent, 'Alpha')
    assert.equal(row.getAttribute('aria-label'), 'Done task · Alpha · 已完成，待查看')
    const style = head.children.find(tag => tag.dataset.pluginCss?.includes('running-rail.css'))
    assert.ok(style !== undefined)
    assert.ok(style.textContent.includes('.dsh-bm-rr-done'))
    return '绿点 + 标题 + Alpha'
  })
  test('两段各自折叠：折叠待查看不影响进行中，折叠状态写不同 key', () => {
    host.children[1].children[0].click()
    assert.equal(host.children[1].children[0].getAttribute('aria-expanded'), 'false')
    assert.equal(host.children[1].children.length, 1, '折叠后只留标题行')
    assert.equal(host.children[1].children[0].children[4].children.length, 1, '折叠标题显示绿点')
    assert.equal(host.children[0].children[0].getAttribute('aria-expanded'), 'true', '进行中不受影响')
    assert.ok(writes.some(item => item.key === 'balance-monitor:completed-rail-collapsed' && item.value === '1'))

    host.children[0].children[0].click()
    assert.equal(host.children[0].children[0].getAttribute('aria-expanded'), 'false')
    assert.ok(writes.some(item => item.key === 'balance-monitor:running-rail-collapsed' && item.value === '1'))

    host.children[1].children[0].click()
    assert.equal(host.children[1].children[0].getAttribute('aria-expanded'), 'true')
    assert.equal(host.children[1].children.length, 2, '展开后恢复行')
    return '两把 key · 互不影响'
  })
  test('点待查看行打开会话，并顺手展开所属工作区', () => {
    host.children[1].children[1].click()
    assert.deepEqual(opened, ['done-1'])
    assert.equal(workspaceExpanded, 1)
    return 'openSession + 展开工作区'
  })
  test('折叠侧栏（wide=false）撤掉轨道，展开后恢复', () => {
    mount(component('sidebar.footer.action', 1).component, { wide: false })
    assert.equal(documentNode.getElementById('dsh-bm-rr-host'), null, '窄栏不该留轨道 host')
    mount(component('sidebar.footer.action', 1).component, { wide: true })
    assert.ok(documentNode.getElementById('dsh-bm-rr-host') !== null, '宽栏应恢复轨道')
    return 'wide=false 隐藏 · wide=true 恢复'
  })
  test('窄栏徽章合并进行中 + 待查看，标题分开写', () => {
    let badge = null
    walk(mount(component('sidebar.toggle.badge').component), node => {
      if (typeof node.props?.className === 'string' && node.props.className.includes('dsh-bm-rr-toggle')) badge = node
    })
    assert.ok(badge !== null, '应渲染窄栏徽章')
    assert.equal(render(badge), '2')
    assert.equal(badge.props.title, '1 个进行中 · 1 个待查看')
    assert.match(badge.props.className, /dsh-bm-rr-toggle/)
    assert.doesNotMatch(badge.props.className, /is-done|is-warn/)
    return '合计 2 · 标题分开'
  })
})()

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
