#!/usr/bin/env node
/**
 * 实验：用「调用前后 used_quota 增量」反推中转站的实际计费倍率。
 *
 * 原理：
 *   中转站的计费 = tokens × 上游单价 × 倍率(group_ratio × model_ratio)
 *   而 one-api / new-api 口径把金额存成整数 quota（默认 1 USD = 500000 quota）。
 *   所以只要能读到 used_quota，就能在没有控制台、没有 /api/pricing 的情况下，
 *   用「发一次已知请求、量两次 used_quota」把实际倍率测出来。
 *
 * 本脚本只做 4 次只读/极小额请求，不写任何状态。
 *
 * 用法：node research/measure-relay-quota-delta.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

function loadCredentialRefs() {
  const text = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8')
  const refs = {}
  const block = /^refs:\s*$([\s\S]*?)(?=^\S|\Z)/m.exec(text)
  if (!block) return refs
  for (const line of block[1].split(/\r?\n/)) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(\S+)\s*$/.exec(line)
    if (m) refs[m[1]] = m[2]
  }
  return refs
}

const CONFIG = {
  id: 'jiuhaoche',
  // 控制台/账号面挂在 /api/grok45 下，模型面在 /api/grok45/v1。
  accountUrl: 'https://nexus.itssx.com/api/grok45/api/user/self',
  chatUrl: 'https://nexus.itssx.com/api/grok45/v1/chat/completions',
  keyEnv: 'JIUHAOCHE_API_KEY',
  model: process.env.PROBE_MODEL ?? 'claude-haiku-4-5',
  maxTokens: Number(process.env.PROBE_MAX_TOKENS ?? 300),
}

const QUOTA_PER_USD = 500_000 // one-api / new-api 默认口径，未验证；见报告「待验证项」

const refs = loadCredentialRefs()
const key = refs[CONFIG.keyEnv]
if (!key) { console.error(`missing ${CONFIG.keyEnv}`); process.exit(1) }

const auth = { authorization: `Bearer ${key}` }

async function readSelf(headers) {
  const res = await fetch(CONFIG.accountUrl, { headers, signal: AbortSignal.timeout(15000) })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* keep raw */ }
  return { status: res.status, body, raw: text.slice(0, 300) }
}

/** 只读探测：该端点是否真的需要鉴权。 */
const noAuth = await readSelf({ accept: 'application/json' })
console.log(`[no-auth ] /api/user/self -> HTTP ${noAuth.status} ${noAuth.body ? JSON.stringify({ ...noAuth.body, data: noAuth.body?.data && { ...noAuth.body.data, username: '<redacted>' } }) : noAuth.raw}`)

const before = await readSelf({ accept: 'application/json', ...auth })
const usedBefore = before.body?.data?.used_quota
if (typeof usedBefore !== 'number') {
  console.log(`[before  ] used_quota 读不到，实验终止：${before.raw}`)
  process.exit(2)
}
console.log(`[before  ] quota=${before.body.data.quota} used_quota=${usedBefore} request_count=${before.body.data.request_count} group=${before.body.data.group}`)

const payload = {
  model: CONFIG.model,
  messages: [{ role: 'user', content: '请从 1 数到 150，用空格分隔，只输出数字。' }],
  max_tokens: CONFIG.maxTokens,
  stream: false,
}
const started = Date.now()
const chatRes = await fetch(CONFIG.chatUrl, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(120000),
})
const chatText = await chatRes.text()
console.log(`[chat    ] HTTP ${chatRes.status} in ${Date.now() - started}ms bytes=${chatText.length}`)
let chat = null
try { chat = JSON.parse(chatText) } catch { /* ignore */ }
if (chat?.usage) console.log(`[usage   ] ${JSON.stringify(chat.usage)}`)
else console.log(`[usage   ] (无) head=${chatText.slice(0, 200)}`)

// 账本写入有延迟，稍等再读。
await new Promise(r => setTimeout(r, 1500))
const after = await readSelf({ accept: 'application/json', ...auth })
const usedAfter = after.body?.data?.used_quota
console.log(`[after   ] used_quota=${usedAfter} request_count=${after.body?.data?.request_count}`)

if (typeof usedAfter === 'number') {
  const delta = usedAfter - usedBefore
  console.log(`\n[delta   ] used_quota +${delta}  (= ${(delta / QUOTA_PER_USD).toFixed(6)} USD @${QUOTA_PER_USD} quota/USD)`)
  const u = chat?.usage
  if (u) {
    const inTok = u.prompt_tokens ?? u.prompt_cache_miss_tokens ?? null
    const outTok = u.completion_tokens ?? null
    console.log(`[formula ] 有效倍率(以 USD 计) = (Δused_quota / ${QUOTA_PER_USD}) / (上游单价 × tokens)`)
    console.log(`           本次 tokens: input=${inTok} output=${outTok}`)
    console.log('           把上游单价(每 1M tokens)填进去即可得到该 relay+model 的实际倍率。')
  }
}
