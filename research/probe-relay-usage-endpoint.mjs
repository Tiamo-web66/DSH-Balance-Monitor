#!/usr/bin/env node
/**
 * 实测：中转站的 `/v1/usage` 是否能用 sk- key 读到「余额 + 消耗 + 倍率」。
 *
 * 背景：控制台接口 `/api/v1/groups/rates`（分组倍率）用 sk- key 读是 401 INVALID_TOKEN，
 * 只有登录态能读。但同一个网关在模型面上另开了一个 key 可读的账单接口 `/v1/usage`。
 *
 * `/v1/usage` 的响应里同时给了两列金额：
 *   cost         —— 按上游官方价算出来的原价
 *   actual_cost  —— 实际扣费
 * 于是有效倍率 = actual_cost / cost，**不需要我方维护官方价格表**即可得出。
 *
 * 只读，每个站点 1 次请求。
 * 用法：node research/probe-relay-usage-endpoint.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

const refs = {}
{
  const text = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8')
  const block = /^refs:\s*$([\s\S]*?)(?=^\S|\Z)/m.exec(text)
  for (const line of block?.[1].split(/\r?\n/) ?? []) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(\S+)\s*$/.exec(line)
    if (m) refs[m[1]] = m[2]
  }
}

// 目标 = 「模型面根」(而不是控制台根)。网关家族不同，账单接口不一定都在 /v1/usage。
const TARGETS = [
  { id: 'walk-grok', base: 'https://walkcoding.top', keyEnv: 'WALK_GROK_API_KEY' },
  { id: 'walk-gpt', base: 'https://st.walkcoding.top', keyEnv: 'WALK_GPT_API_KEY' },
  { id: 'nanshanyougui', base: 'https://nanshanyougui.xyz', keyEnv: 'NANSHANYOUGUI_CLAUDE_API_KEY' },
  { id: 'jiuhaoche', base: 'https://nexus.itssx.com/api/grok45', keyEnv: 'JIUHAOCHE_API_KEY' },
  { id: 'wbfd', base: 'http://114.66.62.99:7863', keyEnv: 'WBFD_API_KEY' },
  { id: 'pojia-gpt', base: 'https://tokencore.dev', keyEnv: 'POJIA_GPT_API_KEY' },
]

async function get(url, key) {
  const headers = { accept: 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, ctype: res.headers.get('content-type'), json, head: json ? undefined : text.slice(0, 160) }
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)

const report = { at: new Date().toISOString(), targets: [] }

for (const t of TARGETS) {
  const key = refs[t.keyEnv]
  const rec = { id: t.id, url: `${t.base}/v1/usage`, keyPresent: Boolean(key) }
  const r = await get(`${t.base}/v1/usage`, key)
  rec.status = r.status
  rec.ctype = r.ctype
  if (!r.json) { rec.head = r.head; report.targets.push(rec); console.log(`[${t.id}] /v1/usage HTTP ${r.status} ${r.head ?? ''}`); continue }

  const j = r.json
  const days = Array.isArray(j.daily_usage) ? j.daily_usage : []
  const sum = k => days.reduce((a, d) => a + num(d[k]), 0)
  rec.summary = {
    topLevelKeys: Object.keys(j),
    balance: j.balance ?? j.data?.balance,
    currencyHint: typeof j.balance === 'string' && /^[$¥]/.test(j.balance) ? j.balance[0] : '未标注',
    days: days.length,
    daySampleKeys: days[0] ? Object.keys(days[0]) : [],
    firstDay: days[0]?.date,
    lastDay: days.at(-1)?.date,
    totalRequests: sum('requests'),
    totalInputTokens: sum('input_tokens'),
    totalOutputTokens: sum('output_tokens'),
    totalCacheReadTokens: sum('cache_read_tokens'),
    sumCost: Number(sum('cost').toFixed(6)),
    sumActualCost: Number(sum('actual_cost').toFixed(6)),
  }
  rec.impliedRatio = rec.summary.sumCost > 0 ? Number((rec.summary.sumActualCost / rec.summary.sumCost).toFixed(4)) : null
  rec.sampleDay = days[0] ?? null
  report.targets.push(rec)

  console.log(`[${t.id}] HTTP ${r.status}  balance=${rec.summary.balance}  days=${rec.summary.days}`)
  if (rec.impliedRatio !== null) {
    console.log(`         Σcost=${rec.summary.sumCost}  Σactual_cost=${rec.summary.sumActualCost}  隐含倍率(实付/原价)=${rec.impliedRatio}`)
  }
}

mkdirSync(join(here, 'out'), { recursive: true })
writeFileSync(join(here, 'out', 'relay-usage-endpoint.json'), JSON.stringify(report, null, 2))
console.log(`\n-> ${join(here, 'out', 'relay-usage-endpoint.json')}`)
