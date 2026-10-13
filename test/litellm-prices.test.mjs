#!/usr/bin/env node
/**
 * 站方口径价目（LiteLLM 镜像）验证：解析 / 转换 / 抓取链 / 合并（fetch 全部打桩）。
 *
 *   node test/litellm-prices.test.mjs
 */
import assert from 'node:assert/strict'

import {
  PROVIDER_MAP,
  STATION_ATTRIBUTION,
  STATION_CATALOG,
  fetchStationPrices,
  mergeStationTable,
  parseStationPrices,
} from '../lib/litellm-prices.js'
import { DEFAULT_PRICE_TABLE } from '../lib/price-table.js'
import { STATION_PRICE_TABLE, STATION_PRICE_TABLE_META } from '../lib/price-table-station.js'
import { resolveTier } from '../lib/pricing.js'

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
const at = text => Date.parse(text)

/** 造一份 LiteLLM 形态的价目（真实字段名）。 */
function fixture(extra = {}) {
  const json = {
    'gpt-6-astra': {
      litellm_provider: 'openai', mode: 'chat',
      input_cost_per_token: 0.00001, output_cost_per_token: 0.00005,
      cache_read_input_token_cost: 0.000001, cache_creation_input_token_cost: 0.0000125,
      input_cost_per_token_above_272k_tokens: 0.00002, output_cost_per_token_above_272k_tokens: 0.000075,
    },
    'anthropic/claude-opus-5': {
      litellm_provider: 'anthropic', mode: 'chat',
      input_cost_per_token: 0.000005, output_cost_per_token: 0.000025, cache_read_input_token_cost: 0.0000005,
    },
    'bedrock/anthropic.claude-opus-5': {
      litellm_provider: 'bedrock', mode: 'chat',
      input_cost_per_token: 0.0000099, output_cost_per_token: 0.000099,
    },
    'azure/gpt-6-astra': {
      litellm_provider: 'azure', mode: 'chat',
      input_cost_per_token: 0.00002, output_cost_per_token: 0.0001,
    },
    'text-embedding-9': { litellm_provider: 'openai', mode: 'embedding', input_cost_per_token: 0.00000002 },
    'no-price-model': { litellm_provider: 'openai', mode: 'chat' },
    ...extra,
  }
  return json
}

console.log('\n[parseStationPrices：字段映射与过滤]')
test('per-token → per-1M；缓存读/写分开；缺缓存读时按未命中价', () => {
  const { models } = parseStationPrices(fixture(), { sourceUrl: 'x', checkedAt: '2026-10-13' })
  assert.deepEqual(
    { miss: models['gpt-6-astra'].cacheMiss, hit: models['gpt-6-astra'].cacheHit, write: models['gpt-6-astra'].cacheWrite, out: models['gpt-6-astra'].output },
    { miss: 10, hit: 1, write: 12.5, out: 50 },
  )
  assert.equal(models['claude-opus-5'].cacheMiss, 5)
  assert.equal(models['claude-opus-5'].cacheHit, 0.5, '渠道前缀被剥掉，按厂商自营条目收录')
})
test('长上下文档：*_above_272k_tokens 收成 longContext', () => {
  const { models, stats } = parseStationPrices(fixture())
  assert.deepEqual(models['gpt-6-astra'].longContext, {
    aboveInputTokens: 272000, cacheMiss: 20, cacheHit: 20, output: 75,
  })
  assert.equal(stats.withLongContext, 1)
})
test('只收自营厂商：渠道/路由器条目（bedrock / azure）跳过', () => {
  const { models, stats } = parseStationPrices(fixture())
  assert.equal(models['gpt-6-astra'] !== undefined, true)
  assert.equal(Object.values(models).some(entry => entry.litellmProvider === 'bedrock'), false)
  assert.equal(Object.values(models).some(entry => entry.litellmProvider === 'azure'), false)
  assert.ok(stats.skippedProvider >= 2)
})
test('非对话模式 / 没有价 / 结构异常都跳过并计数', () => {
  const { stats, models } = parseStationPrices({ ...fixture(), 'weird': null })
  assert.equal(models['text-embedding-9'], undefined)
  assert.equal(models['no-price-model'], undefined)
  assert.equal(stats.skippedMode, 1)
  assert.equal(stats.skippedCost, 1)
  assert.equal(stats.skippedShape, 1)
})
test('每条都带 source=station 与出处、核对日期', () => {
  const { models } = parseStationPrices(fixture(), { sourceUrl: 'https://example/litellm.json', checkedAt: '2026-10-13' })
  const entry = models['gpt-6-astra']
  assert.equal(entry.source, 'station')
  assert.equal(entry.currency, 'USD')
  assert.equal(entry.sourceUrl, 'https://example/litellm.json')
  assert.equal(entry.checkedAt, '2026-10-13')
  assert.equal(entry.vendor, 'openai')
})
test('脏输入不抛：null / 数组 / 字符串', () => {
  for (const bad of [null, [], 'nope', 42]) {
    const { models } = parseStationPrices(bad)
    assert.deepEqual(models, {})
  }
})

console.log('\n[fetchStationPrices：抓取链]')
function stubRoutes(routes) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    const handler = routes[String(url)]
    if (handler === undefined) return new Response('nope', { status: 404 })
    return handler()
  }
  return { fetchImpl, calls }
}
/** 造一份达到结构守卫下限（≥100 条）的 JSON 文本。 */
function bulkJson(count = 120) {
  const json = fixture()
  for (let index = 0; index < count; index += 1) {
    json[`filler-${index}`] = { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 }
  }
  return JSON.stringify(json)
}
const RAW_LITELLM = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const API_CONTENTS = 'https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json'
const API_BLOB = 'https://api.github.com/repos/BerriAI/litellm/git/blobs/sha123'

await testAsync('优先 raw 直链', async () => {
  const { fetchImpl, calls } = stubRoutes({ [RAW_LITELLM]: () => new Response(bulkJson(), { status: 200 }) })
  const result = await fetchStationPrices({ fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.sourceUrl, RAW_LITELLM)
  assert.equal(result.kind, 'raw')
  assert.equal(calls.length, 1)
})

await testAsync('raw 被墙 → 走 GitHub API contents→blobs（大文件不内联）', async () => {
  const base64 = Buffer.from(bulkJson(), 'utf8').toString('base64')
  const { fetchImpl, calls } = stubRoutes({
    [API_CONTENTS]: () => new Response(JSON.stringify({ sha: 'sha123', size: 999999, encoding: 'none', content: '' }), { status: 200 }),
    [API_BLOB]: () => new Response(JSON.stringify({ encoding: 'base64', content: base64 }), { status: 200 }),
  })
  const result = await fetchStationPrices({ fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'github-blob')
  assert.deepEqual(calls, [RAW_LITELLM, 'https://raw.githubusercontent.com/Wei-Shaw/sub2api/price-mirror/model_prices_and_context_window.json', API_CONTENTS, API_BLOB])
})

await testAsync('contents 内联 base64 也能吃（小文件）', async () => {
  const base64 = Buffer.from(bulkJson(), 'utf8').toString('base64')
  const { fetchImpl } = stubRoutes({
    'https://api.github.com/repos/Wei-Shaw/sub2api/contents/backend/resources/model-pricing/model_prices_and_context_window.json':
      () => new Response(JSON.stringify({ encoding: 'base64', content: base64 }), { status: 200 }),
  })
  const result = await fetchStationPrices({ fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'github-contents')
})

await testAsync('全部失败：如实返回每条链路的原因', async () => {
  const { fetchImpl } = stubRoutes({})
  const result = await fetchStationPrices({ fetchImpl })
  assert.equal(result.ok, false)
  assert.ok(result.errors.length >= 4, `应有 4 条链路的原因，实际 ${result.errors.length}`)
  return result.errors[0].slice(0, 60)
})

await testAsync('结构守卫：条数太少（错误页）判失败', async () => {
  const { fetchImpl } = stubRoutes({ [RAW_LITELLM]: () => new Response(JSON.stringify({ a: 1 }), { status: 200 }) })
  const result = await fetchStationPrices({ fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.errors[0], /只有 1 条/)
})

console.log('\n[mergeStationTable：合并位置]')
test('挂在 providers.station 下，且不改动原表对象', () => {
  const merged = mergeStationTable(DEFAULT_PRICE_TABLE, { 'gpt-6-astra': { cacheMiss: 1, cacheHit: 0.1, output: 2, source: 'station' } })
  assert.equal(merged.providers[STATION_CATALOG]['gpt-6-astra'].cacheMiss, 1)
  assert.equal(DEFAULT_PRICE_TABLE.providers[STATION_CATALOG], undefined, '不该污染原表')
})
test('空站方数据时原样返回（不添加空目录）', () => {
  assert.equal(mergeStationTable(DEFAULT_PRICE_TABLE, {}), DEFAULT_PRICE_TABLE)
})

console.log('\n[随包快照：默认就有站方口径价]')
test('快照来自 LiteLLM 上游，条数与来源都记在元数据里', () => {
  assert.ok(Object.keys(STATION_PRICE_TABLE).length >= 200, `条数 ${Object.keys(STATION_PRICE_TABLE).length}`)
  assert.equal(STATION_PRICE_TABLE_META.origin, STATION_ATTRIBUTION)
  assert.match(STATION_PRICE_TABLE_META.sourceUrl, /litellm/)
  assert.match(STATION_PRICE_TABLE_META.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
})
test('常用站点模型都能在快照里命中；没官方价的走站方口径', () => {
  const merged = mergeStationTable(DEFAULT_PRICE_TABLE, STATION_PRICE_TABLE)
  const found = []
  let stationCount = 0
  for (const model of ['gpt-5.6-sol', 'gpt-6-astra', 'claude-opus-4-6', 'grok-4.6', 'glm-5.2', 'gemini-3.7-flash']) {
    const resolved = resolveTier({ model, atMs: at('2026-09-15T01:30:00Z'), priceTable: merged })
    assert.equal(resolved.priced, true, `${model} 应有价`)
    assert.ok(['official', 'station'].includes(resolved.priceSource.source), `${model} 的来源等级 ${resolved.priceSource.source}`)
    if (resolved.priceSource.source === 'station') stationCount += 1
    found.push(`${model}→${resolved.priceSource.source}`)
  }
  assert.ok(stationCount >= 4, `至少 4 个走站方口径，实际 ${stationCount}`)
  // 官方来源条目（厂商文档域）优先：gpt-6-astra 在默认表里有一条 official
  const astra = resolveTier({ model: 'gpt-6-astra', atMs: at('2026-09-15T01:30:00Z'), priceTable: merged })
  assert.equal(astra.priceSource.source, 'official')
  return found.join(' ')
})
test('DeepSeek 主表（official）优先于站方口径：两者都有时取官方', () => {
  const merged = mergeStationTable(DEFAULT_PRICE_TABLE, { 'deepseek-v4.1-flash': { cacheMiss: 99, cacheHit: 9, output: 99, source: 'station' } })
  const resolved = resolveTier({ model: 'deepseek-v4.1-flash', atMs: at('2026-09-15T01:30:00Z'), priceTable: merged })
  assert.equal(resolved.priceSource.source, 'official')
  assert.notEqual(resolved.tier.cacheMiss, 99)
  return 'official 胜出'
})
test('长上下文档在计价时生效（station 条目的 longContext）', () => {
  const merged = mergeStationTable(DEFAULT_PRICE_TABLE, {
    'long-ctx-model': {
      cacheMiss: 2, cacheHit: 0.2, output: 10,
      longContext: { aboveInputTokens: 1000, cacheMiss: 4, output: 15 },
      source: 'station',
    },
  })
  const resolved = resolveTier({ model: 'long-ctx-model', atMs: at('2026-09-15T01:30:00Z'), priceTable: merged })
  assert.equal(resolved.tier.cacheMiss, 2, '基础档')
  assert.equal(resolved.tier.longContext.aboveInputTokens, 1000)
  assert.equal(resolved.tier.longContext.cacheHit, 4, '命中价缺省 = 未命中价（补齐规则）')
  assert.equal(resolved.tier.longContext.output, 15)
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
