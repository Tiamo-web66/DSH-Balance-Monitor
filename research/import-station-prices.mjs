#!/usr/bin/env node
/**
 * 生成「站方口径价目」默认快照（`lib/price-table-station.js`）。
 *
 *   node research/import-station-prices.mjs [--out lib/price-table-station.js]
 *
 * 数据来自 LiteLLM 的 `model_prices_and_context_window.json`（MIT）——**Sub2Api 自己就是用
 * 这张表算钱的**（它的仓库里有一份镜像副本，运行时优先下载最新版）。抓取链见
 * `lib/litellm-prices.js`：raw 直链 → sub2api price-mirror → GitHub API blobs → 仓库内副本。
 *
 * 生成本文件的目的是：**开箱就有站方口径的价目**，不必先点「更新价格表」。
 * 之后可以用插件里的更新按钮（或重跑本脚本）刷新。
 */
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { STATION_ATTRIBUTION, fetchStationPrices, parseStationPrices } from '../lib/litellm-prices.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 ? resolve(ROOT, args[outIndex + 1]) : join(ROOT, 'lib', 'price-table-station.js')

const fetched = await fetchStationPrices({})
if (fetched.ok !== true) {
  console.error('抓取失败：')
  for (const error of fetched.errors) console.error(`  - ${error}`)
  process.exit(1)
}

const json = JSON.parse(fetched.text)
const checkedAt = new Date().toISOString().slice(0, 10)
const { models, stats } = parseStationPrices(json, { sourceUrl: fetched.sourceUrl, checkedAt })
const ids = Object.keys(models)
if (ids.length < 50) {
  console.error(`只解析出 ${ids.length} 条，判为异常，已中止`)
  process.exit(1)
}

const lines = ids.sort().map(id => `    ${JSON.stringify(id)}: ${JSON.stringify(models[id])},`).join('\n')
const meta = {
  origin: STATION_ATTRIBUTION,
  sourceUrl: fetched.sourceUrl,
  sourceKind: fetched.kind,
  fetchedAt: new Date().toISOString(),
  fileEntries: Object.keys(json).length,
  accepted: stats.accepted,
  skippedProvider: stats.skippedProvider,
  skippedMode: stats.skippedMode,
  skippedCost: stats.skippedCost,
  withLongContext: stats.withLongContext ?? 0,
  byVendor: stats.byVendor,
  note: '站方口径价目（Sub2Api 用同一张表计费）；来源等级 source="station"；金额仍需 × 站方倍率',
}

const file = `/**
 * 站方口径价目快照（**自动生成，勿手改**）。
 *
 * 重新生成：node research/import-station-prices.mjs
 * 数据出处：${STATION_ATTRIBUTION}
 *
 * 为什么是这张表：Sub2Api 的真实计费（我们看到的 \`cost\` / \`actual_cost\`）就是用它算的
 * （见其 \`backend/internal/service/account_stats_pricing.go\` 的注释），所以
 * 「这张表 × 站方倍率」与站方账单同源。
 *
 * 来源等级是 \`station\`，**不是** \`official\`（厂商文档）：LiteLLM 目录包含厂商自营条目，
 * 但也混有渠道条目与推算值；本快照只收自营厂商（见 lib/litellm-prices.js 的 PROVIDER_MAP）。
 * 默认计价允许 \`official + station + manual\`，转售/聚合来源仍需显式放开。
 *
 * 只给 host 半身 import；客户端不加载。
 */
export const STATION_PRICE_TABLE_META = ${JSON.stringify(meta, null, 2)}

/** 模型 id → 价目条目。合并进价表时挂在 \`providers.station\` 目录下。 */
export const STATION_PRICE_TABLE = {
${lines}
}
`

writeFileSync(outPath, file, 'utf8')
console.log(`已生成 ${outPath}`)
console.log(`  来源 ${fetched.sourceUrl}（${fetched.kind}）`)
console.log(`  文件 ${meta.fileEntries} 条 → 收录 ${meta.accepted} 条（跳过 非自营 ${meta.skippedProvider} / 非对话 ${meta.skippedMode} / 无价 ${meta.skippedCost}）`)
console.log(`  长上下文档 ${meta.withLongContext} 条 · 厂商分布 ${JSON.stringify(meta.byVendor)}`)
console.log(`  文件大小 ${(Buffer.byteLength(file) / 1024).toFixed(1)} KB`)
