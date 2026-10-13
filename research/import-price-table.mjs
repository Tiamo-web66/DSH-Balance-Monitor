#!/usr/bin/env node
/**
 * 把 dsh-cost-meter 的价目快照导入成本插件的默认价表（离线、可复跑）。
 *
 *   node research/import-price-table.mjs [<ledger.json 或 prices.json 路径>] [--out lib/price-table.js]
 *
 * 为什么用「快照文件」而不是运行时依赖：本插件零 `@deepseek-ai/*` 依赖、也不许依赖
 * 别人的包（profile 下的 junction 全是断链），所以只能把数据**拷进本仓库**，并保留
 * 来源与核对日期，供人工复核。
 *
 * 授权：dsh-cost-meter 是 MIT（其 package.json `"license": "MIT"`），数据可复用，
 * 生成的文件头会写明出处与源数据哈希。
 *
 * 二次加工（都在本脚本里，不改单价数字）：
 *   1. `prices.models`（DeepSeek 主表）原样带入，含 `offPeak`/`peak`/`rateHistory`；
 *   2. `legacyBase` 只补进 DeepSeek 四个模型（他的 `LEGACY_BASE_PRICES` 是代码常量，
 *      账本里只在 `default.legacyBase` 留了一份；仅用于历史回填，正常入账永不触发）；
 *   3. `prices.providers`（17 家厂商目录）原样带入；`openrouter` 目录按 `vendor/model`
 *      结构保留，供尾名匹配；
 *   4. `aliases` 只加「同一模型的两个命名体系」这类确定映射，其余交给规范化匹配。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 ? resolve(ROOT, args[outIndex + 1]) : join(ROOT, 'lib', 'price-table.js')
const sourcePath = resolve(args.find(arg => !arg.startsWith('--') && arg !== args[outIndex + 1])
  ?? join(homedir(), '.dsh', 'storages', 'cost-meter', 'ledger.json'))

/** 峰谷时代之前的基础价（他的 `LEGACY_BASE_PRICES`，USD/1M tokens）。 */
const LEGACY_BASE_USD = {
  'deepseek-v4-flash': { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
  'deepseek-v4-pro': { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
  'deepseek-chat': { cacheHit: 0.07, cacheMiss: 0.27, output: 1.1 },
  'deepseek-reasoner': { cacheHit: 0.14, cacheMiss: 0.55, output: 2.19 },
}

/** 确定存在的别名（同一模型的两个命名体系），避免靠模糊匹配猜。 */
const ALIASES = {
  // 他的 anthropic 目录用连字符（claude-opus-4-6），pi-ai 侧常见点号写法
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-opus-4.7': 'claude-opus-4-7',
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-opus-4.5': 'claude-opus-4-5',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-sonnet-4.5': 'claude-sonnet-4-5',
  'claude-haiku-4.5': 'claude-haiku-4-5',
  // 站点模型 id 与厂商目录 id 不同名
  'kimi-k3-1': 'kimi-k3',
  'kimi-k2.7': 'kimi-k2.7-code',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
}

/**
 * **来源分级**：只有厂商自己的文档域算「官方价」，其余一律降级。
 *
 * 为什么必须做这件事：他的 15 家「厂商目录」里 65% 的 `sourceUrl` 指向
 * `opencode.ai`（OpenCode Zen，转售/订阅产品），OpenRouter 那 470 条更是转售+变体。
 * 这些数字**不能当官方价**（转售价含加价/促销，档位也不同），
 * 所以按规则：默认只用 `official` 计价，其余只在显式放开时才参与。
 */
const OFFICIAL_DOMAINS = new Set([
  // 各厂商官方文档 / 控制台
  'api-docs.deepseek.com', 'platform.deepseek.com', 'api.deepseek.com',
  'developers.openai.com', 'platform.openai.com', 'openai.com',
  'docs.anthropic.com', 'anthropic.com', 'console.anthropic.com',
  'ai.google.dev', 'cloud.google.com', 'developers.googleblog.com',
  'docs.x.ai', 'x.ai',
  'platform.moonshot.cn', 'platform.moonshot.ai', 'platform.moonshot.com',
  'open.bigmodel.cn', 'bigmodel.cn', 'docs.bigmodel.cn',
  'www.minimaxi.com', 'www.minimax.io', 'www.minimax.cn',
  'help.aliyun.com', 'www.alibabacloud.com', 'dashscope.aliyuncs.com',
  'cloud.tencent.com', 'console.cloud.tencent.com', 'cloud.tencent.com.cn',
  'mimo.mi.com', 'dev.mi.com', 'platform.xiaomimimo.com',
  'www.upstage.ai', 'ai.meta.com', 'www.llama.com',
  'cloud.meituan.com', 'developer.nvidia.com', 'docs.mistral.ai', 'mistral.ai',
  'docs.stepfun.com', 'platform.stepfun.com', 'platform.qianwenai.com',
  'api.commandcode.ai', 'open.volcengineapi.com',
])
const RESELLER_DOMAINS = new Set(['opencode.ai', 'www.opencode.ai'])
const AGGREGATOR_DOMAINS = new Set(['openrouter.ai', 'www.openrouter.ai'])

/** @returns {'official' | 'reseller' | 'aggregator' | 'unknown'} */
function classifySource(sourceUrl) {
  if (typeof sourceUrl !== 'string' || sourceUrl.length === 0) return 'unknown'
  let host
  try {
    host = new URL(sourceUrl).host.toLowerCase()
  } catch {
    return 'unknown'
  }
  if (OFFICIAL_DOMAINS.has(host)) return 'official'
  if (RESELLER_DOMAINS.has(host)) return 'reseller'
  if (AGGREGATOR_DOMAINS.has(host)) return 'aggregator'
  return 'unknown'
}

function readPrices(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (raw?.config?.prices) return { prices: raw.config.prices, payload: raw.config.prices }
  if (raw?.prices) return { prices: raw.prices, payload: raw.prices }
  if (raw?.providers && raw?.models) return { prices: raw, payload: raw }
  throw new Error(`无法从 ${path} 找到价格表（期望 ledger.json 的 config.prices 或 pricing 数据文件）`)
}

const { prices, payload } = readPrices(sourcePath)
const currency = typeof prices.currency === 'string' && prices.currency.length > 0 ? prices.currency : 'USD'

const deepseek = {}
for (const [id, entry] of Object.entries(prices.models ?? {})) {
  deepseek[id] = {
    ...entry,
    // DeepSeek 主表来自官方定价页抓取 → 天然是官方价
    source: 'official',
    ...(LEGACY_BASE_USD[id] === undefined ? {} : { legacyBase: LEGACY_BASE_USD[id] }),
  }
}
if (deepseek['deepseek-v4-flash']?.legacyBase === undefined && prices.default?.legacyBase !== undefined) {
  deepseek['deepseek-v4-flash'].legacyBase = prices.default.legacyBase
}

const providers = {}
const sourceBreakdown = { official: 0, reseller: 0, aggregator: 0, unknown: 0 }
const sourceByVendor = {}
for (const [vendor, table] of Object.entries(prices.providers ?? {})) {
  if (table === null || typeof table !== 'object') continue
  const models = table.models ?? table
  if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
  const stamped = {}
  const perVendor = { official: 0, reseller: 0, aggregator: 0, unknown: 0 }
  for (const [id, entry] of Object.entries(models)) {
    const source = classifySource(entry?.sourceUrl)
    stamped[id] = { ...entry, source }
    perVendor[source] += 1
    sourceBreakdown[source] += 1
  }
  providers[vendor] = stamped
  sourceByVendor[vendor] = perVendor
}
sourceBreakdown.official += Object.keys(deepseek).length

const sourceHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
const priceBoundaries = [...new Set(Object.values(deepseek)
  .flatMap(entry => (entry.rateHistory ?? []).map(period => period.before))
  .filter(value => typeof value === 'string'))].sort()

const entries = (map, indent) => Object.entries(map)
  .map(([key, value]) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  .join('\n')

const file = `/**
 * 默认价目表（**自动生成，勿手改**）—— 数据来源：dsh-cost-meter（MIT）的价目快照。
 *
 * 重新生成：node research/import-price-table.mjs [<他的 ledger.json 路径>]
 *
 * 用法与边界：
 *   - 这是「厂商官方挂牌价」，用于 \`官方价 × 站方倍率\` 里的官方价部分；
 *     中转站的折扣/加价由站方倍率表达，**不要**往这张表里塞站点价格。
 *   - **每条都带来源等级 \`source\`**：\`official\`（厂商自有文档域，来自
 *     research/import-price-table.mjs 的 OFFICIAL_DOMAINS 白名单）/
 *     \`reseller\`（opencode.ai 这类转售商挂牌价）/ \`aggregator\`（openrouter.ai）/
 *     \`unknown\`（无 sourceUrl 或域名不在名单里）。
 *   - **默认只按 \`official\` + \`manual\` 计价**：\`lib/pricing.js\` 的
 *     \`DEFAULT_PRICE_SOURCES\`。转售/聚合来源不会参与计算，除非在 state.json 的
 *     \`priceSources\` 里显式放开——因为转售价含加价/促销、档位也不同，不能当官方价。
 *   - 它是**默认值**：state.json 的 \`priceTable\` 可整段覆盖，\`aliases\` 可增量补充。
 *   - 依据变更**不重算历史**（见 lib/pricing.js 文末）：改这张表只影响之后的调用。
 *   - 未命中就是未定价（\`priced: false\`）→ 界面显示 \`—\`，不是 0。
 *   - **只给 host 半身 import**：客户端不要加载这个文件（100 KB 级，且金额一律由宿主算好再送）。
 */
export const PRICE_TABLE_META = ${JSON.stringify({
  origin: 'dsh-cost-meter price snapshot (MIT)',
  generatedFrom: sourcePath,
  sourceHash,
  currency,
  modelCount: Object.keys(deepseek).length,
  vendorCount: Object.keys(providers).length,
  deepseekPriceBoundaries: priceBoundaries,
  sourceBreakdown,
  sourceByVendor,
  note: '厂商官方挂牌价（USD/1M tokens）；每条带 source 等级，默认只用 official；转售/聚合来源需显式放开才参与计价',
}, null, 2)}

export const DEFAULT_PRICE_TABLE = {
  currency: ${JSON.stringify(currency)},
  models: {
${entries(deepseek, '    ')}
  },
  providers: {
${Object.entries(providers).map(([vendor, models]) => `    ${JSON.stringify(vendor)}: {\n${entries(models, '      ')}\n    },`).join('\n')}
  },
  aliases: ${JSON.stringify(ALIASES, null, 2).replace(/\n/g, '\n  ')},
}
`

writeFileSync(outPath, file, 'utf8')
console.log(`已生成 ${outPath}`)
console.log(`  来源 ${sourcePath}`)
console.log(`  哈希 ${sourceHash} · 币种 ${currency} · DeepSeek ${Object.keys(deepseek).length} 个 · 厂商目录 ${Object.keys(providers).length} 家`)
console.log(`  文件大小 ${(Buffer.byteLength(file) / 1024).toFixed(1)} KB`)
