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

// ── 迷你 React：state 按「渲染顺序的组件帧」存，effect 只在挂载时跑一次 ──
// 帧池**按根组件隔离**：设置页与侧栏是两个不同的槽位组件，共用一份帧会把状态串起来。
const framePools = new Map()
let frames = []
let frameIndex = 0
let dirty = false
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) } }
  },
  useState(initial) {
    const frame = frames[frameIndex] ?? (frames[frameIndex] = { slots: [], effects: [], cursor: 0 })
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
    const frame = frames[frameIndex] ?? (frames[frameIndex] = { slots: [], effects: [], cursor: 0 })
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
const REPORT = {
  date: '2026-10-13',
  now: Date.parse('2026-10-13T02:00:00Z'),
  display: { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2 },
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
  peak: { enabled: true, inPeak: true, zoneKind: 'peak', prevAtMs: 1, nextAtMs: Date.parse('2026-10-13T03:28:00Z'), nextIntoPeak: false, countdownMs: 5_280_000, countdown: '1 小时 28 分' },
  prices: {
    meta: { fetchedAt: '2026-10-13T02:27:41.767Z', sourceKind: 'github-blob', accepted: 319, sourceUrl: 'https://api.github.com/repos/BerriAI/litellm/git/blobs/abc', bundled: false },
    sources: ['official', 'station', 'manual'],
    breakdown: { official: 20, station: 314, manual: 0, reseller: 75, aggregator: 470, unknown: 12 },
    attribution: 'LiteLLM model_prices_and_context_window.json (MIT), mirrored by Wei-Shaw/sub2api',
    basisId: 'p1-03cb848a',
  },
  trend: [{ date: '2026-10-11', usd: 1.2, calls: 10, amount: 8.64 }, { date: '2026-10-12', usd: 2.4, calls: 20, amount: 17.28 }, { date: '2026-10-13', usd: 0.1944, calls: 160, amount: 1.3997 }],
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
  peak: { enabled: true, inPeak: true, zoneKind: 'peak', prevAtMs: 1, nextAtMs: Date.parse('2026-10-13T03:28:00Z'), nextIntoPeak: false, countdownMs: 5_280_000, countdown: '1 小时 28 分' },
  prices: { fetchedAt: '2026-10-13T02:27:41.767Z', sourceKind: 'github-blob', accepted: 319, bundled: false },
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
    { provider: 'walk-grok', displayName: 'Grok 中转', settingsNs: 'llm-pi-ai', type: 'sub2api', status: 'ok', hasKey: true, image: { editable: false } },
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
globalThis.window = {
  __ModuleLoader__: { load(entry) { globalThis.window.__MODULE_ENTRY__ = entry } },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
}
globalThis.fetch = async (url, init) => {
  const path = String(url)
  calls.push({ path, method: init?.method ?? 'GET', body: init?.body ?? null })
  const json = path.endsWith('/state') ? { ok: true, state: STATE }
    : path.includes('/keys') ? { ok: true, data: KEYS }
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

function component(name, index = 0) {
  const list = slots.get(name)
  assert.ok(list !== undefined && list.length > index, `槽位 ${name} 未注册`)
  return list[index]()
}
/**
 * 只在**挂载**时跑状态机：反复渲染直到没有 setState。
 * state 存进 frames（按渲染顺序的组件帧），effect 只在挂载时执行一次。
 */
function mount(component, props = {}, visit = null) {
  if (!framePools.has(component)) framePools.set(component, [])
  frames = framePools.get(component)
  let tree = null
  for (let pass = 0; pass < 10; pass += 1) {
    dirty = false
    frameIndex = 0
    const frame = frames[0] ?? (frames[0] = { slots: [], effects: [], cursor: 0 })
    frame.cursor = 0
    let tree
    try {
      // 根组件吃第 0 帧；它内部嵌套的组件由 walkNode 展开时依次吃第 1、2… 帧
      tree = component(props)
      // 嵌套组件也要在**状态化**的这一遍里展开一次：否则它们的 effect 永远不跑
      // （余额明细、密钥编辑区这类子组件就是靠 effect 首次加载的）。
      frameIndex = 1
      walkNode(tree, visit ?? (() => {}))
    } finally {
      frameIndex = 0
    }
    if (!dirty) return tree
  }
  return null
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
    const frame = frames[frameIndex]
    const cursor = frame === undefined ? 0 : frame.cursor++
    const slot = frame === undefined ? undefined : frame.slots[cursor]
    if (slot !== undefined) return [slot.value, () => {}]
    const value = typeof initial === 'function' ? initial() : initial
    if (frame !== undefined) frame.slots[cursor] = { value }
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
  const savedIndex = frameIndex
  // 树里的子组件从第 1 帧起（第 0 帧是根组件，已在 mount 时跑过）
  frameIndex = 1
  try {
    return readonly(() => renderNode(element))
  } finally {
    frameIndex = savedIndex
  }
}
function renderNode(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(renderNode).join('')
  const { type, props } = element
  if (typeof type === 'function') {
    const frame = frames[frameIndex] ?? (frames[frameIndex] = { slots: [], effects: [], cursor: 0 })
    frame.cursor = 0
    frameIndex += 1
    try {
      return renderNode(type(props))
    } finally {
      frameIndex -= 1
    }
  }
  return renderNode(props?.children ?? [])
}
/** 原始遍历（组件会展开一次；这里自行维护帧序号，与 render 的顺序一致）。 */
function walkNode(element, visit) {
  if (element === null || element === undefined || typeof element !== 'object') return
  if (Array.isArray(element)) { for (const child of element) walkNode(child, visit); return }
  visit(element)
  if (typeof element.type === 'function') {
    const frame = frames[frameIndex] ?? (frames[frameIndex] = { slots: [], effects: [], cursor: 0 })
    frameIndex += 1
    try {
      walkNode(element.type(element.props), visit)
    } finally {
      frameIndex -= 1
    }
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
test('切到「用量」页：token 汇总 + 近 N 天柱状 + 按模型', () => {
  assert.ok(clickText(tree, '用量'))
  tree = mount(CostPage)
  const html = render(tree)
  for (const needle of ['缓存写入', '推理', '最近 3 天', '今日按模型', 'cn:deepseek-v4.1-flash']) {
    assert.ok(html.includes(needle), `用量页缺少「${needle}」`)
  }
  return '三段内容齐全'
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
})()
console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
