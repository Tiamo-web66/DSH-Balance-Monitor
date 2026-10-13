#!/usr/bin/env node
/**
 * 中转站能力探测 harness（只读、低配额、串行）。
 *
 * 目的：判断「一把 sk- key」在一家中转站上到底能拿到哪些数据 ——
 *   余额 / 消耗额度 / 倍率(group_ratio) / 模型报价(model_ratio, model_price)。
 *
 * 只打这几条公开且被 New-API / one-api 生态客户端广泛使用的只读路径：
 *   GET /v1/models                       (带 key，验证 key 是否可用 + 模型清单)
 *   GET /api/status                      (公开站点配置)
 *   GET /api/pricing                     (公开模型报价/倍率)
 *   GET /api/ratio_config                (公开比率表)
 *   GET /dashboard/billing/subscription  (带 key，OpenAI 兼容账单口径)
 *   GET /api/user/self                   (带 key，控制台口径；通常要求 access token)
 *
 * 不做的：路径爆破、并发压测、写操作。每个目标串行 ≤6 请求，间隔 delayMs。
 *
 * 用法：
 *   node research/probe-relay-capabilities.mjs            # 用内置目标表
 *   node research/probe-relay-capabilities.mjs --only walk-grok
 *   node research/probe-relay-capabilities.mjs --targets '[{"id":"x","base":"https://x/v1","keyEnv":"X_API_KEY"}]'
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 读取 DSH 凭据库 refs 段（不打印、不回显任何密钥）。 */
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

/**
 * 内置目标表：来自 profiles/desktop/cordis.patch.yml 的 llm-pi-ai providers。
 * 显式排除 https://api.zxcbug.com/ —— 本工作区约定禁止对该站点发起任何探测。
 */
const BUILTIN_TARGETS = [
  { id: 'jiuhaoche', base: 'https://nexus.itssx.com/api/grok45', keyEnv: 'JIUHAOCHE_API_KEY' },
  { id: 'walk-grok', base: 'https://walkcoding.top/v1', keyEnv: 'WALK_GROK_API_KEY' },
  { id: 'walk-gpt', base: 'https://st.walkcoding.top/v1', keyEnv: 'WALK_GPT_API_KEY' },
  { id: 'nanshanyougui-claude', base: 'https://nanshanyougui.xyz', keyEnv: 'NANSHANYOUGUI_CLAUDE_API_KEY' },
  { id: 'pojia-gpt', base: 'https://tokencore.dev/v1', keyEnv: 'POJIA_GPT_API_KEY' },
  { id: 'wbfd', base: 'http://114.66.62.99:7863/v1', keyEnv: 'WBFD_API_KEY' },
]

const BLOCKED_HOSTS = new Set(['api.zxcbug.com'])

const PATHS_ON_BASE = [
  { path: '/v1/models', auth: true, label: 'models' },
]
const PATHS_ON_ORIGIN = [
  { path: '/api/status', auth: false, label: 'status' },
  { path: '/api/pricing', auth: false, label: 'pricing' },
  { path: '/api/ratio_config', auth: false, label: 'ratio_config' },
  { path: '/dashboard/billing/subscription', auth: true, label: 'billing_subscription' },
  { path: '/dashboard/billing/usage', auth: true, label: 'billing_usage' },
  { path: '/api/user/self', auth: true, label: 'user_self' },
]
const PATHS = [...PATHS_ON_BASE, ...PATHS_ON_ORIGIN]

function args() {
  const out = { only: null, targets: null, delayMs: 250 }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--only') out.only = a[++i]
    else if (a[i] === '--targets') out.targets = JSON.parse(a[++i])
    else if (a[i] === '--delay') out.delayMs = Number(a[++i])
  }
  return out
}

/** 去掉尾部 /v1，得到控制台根；某些网关把控制台挂在根上。 */
function rootOf(base) {
  return base.replace(/\/+$/, '').replace(/\/v\d+$/i, '')
}

/** origin（scheme://host[:port]）。很多中转站把 OpenAI 兼容面挂在 /api/<name>/v1，
 *  控制台面挂在 origin，两者根不同，必须分别试。 */
function originOf(base) {
  const u = new URL(base)
  return u.origin
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 只保留判定所需的字段，避免把整站响应写进产物。 */
function summarize(label, json) {
  if (json === null || typeof json !== 'object') return undefined
  const d = json.data ?? json
  switch (label) {
    case 'models': {
      const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : []
      return { count: arr.length, sample: arr.slice(0, 3).map(m => m?.id ?? m) }
    }
    case 'status':
      return {
        keys: Object.keys(d ?? {}).slice(0, 40),
        system_name: d?.system_name, version: d?.version,
        quota_per_unit: d?.quota_per_unit, display_in_currency: d?.display_in_currency,
        price: d?.price, stripe_unit_price: d?.stripe_unit_price,
        group_ratio: d?.group_ratio ?? d?.group_ratios,
        default_group: d?.default_group, default_use_auto_group: d?.default_use_auto_group,
        enable_batch_update: d?.enable_batch_update,
      }
    case 'pricing': {
      const list = Array.isArray(d) ? d : Array.isArray(d?.models) ? d.models : []
      const first = list[0]
      return {
        count: list.length,
        sampleKeys: first ? Object.keys(first) : [],
        sample: list.slice(0, 2),
        group_ratio: json?.group_ratio ?? json?.data?.group_ratio,
        quota_type: json?.quota_type,
      }
    }
    case 'ratio_config':
      return {
        keys: Object.keys(d ?? {}),
        group_ratio: d?.group_ratio,
        model_ratio_count: d?.model_ratio ? Object.keys(d.model_ratio).length : undefined,
        completion_ratio_count: d?.completion_ratio ? Object.keys(d.completion_ratio).length : undefined,
      }
    case 'billing_subscription':
      return d
    case 'user_self':
      // username 可能是邮箱/手机号，只留存在性不留值。
      return { keys: Object.keys(d ?? {}), has_quota: d?.quota !== undefined, has_used_quota: d?.used_quota !== undefined, group: d?.group, username: d?.username === undefined ? undefined : '<redacted>' }
    default:
      return { keys: Object.keys(d ?? {}) }
  }
}

async function probeOne(base, p, key, delayMs) {
  const url = base + p.path
  const headers = { accept: 'application/json' }
  if (p.auth && key) headers.authorization = `Bearer ${key}`
  const rec = { base, path: p.path, label: p.label, auth: p.auth }
  const started = Date.now()
  try {
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) })
    rec.status = res.status
    rec.ms = Date.now() - started
    rec.ctype = res.headers.get('content-type') ?? null
    const text = await res.text()
    rec.bytes = text.length
    // 关键陷阱：控制台 SPA 对未知路径回落 index.html，HTTP 200 + HTML，
    // 不是接口成功。必须显式判掉，否则会把「前端页面」当成「账单 API」。
    const looksHtml = /^\s*<(!doctype|html)/i.test(text) || /text\/html/i.test(rec.ctype ?? '')
    if (looksHtml) {
      rec.html = true
      rec.spaFallbackLikely = true
      rec.textHead = text.slice(0, 120).replace(/\s+/g, ' ')
    } else {
      try {
        const json = JSON.parse(text)
        rec.json = true
        rec.summary = summarize(p.label, json)
        if (json && typeof json === 'object' && 'success' in json) rec.success = json.success
        if (json?.message !== undefined) rec.message = String(json.message).slice(0, 200)
        if (json?.error !== undefined) rec.error = typeof json.error === 'string' ? json.error.slice(0, 200) : json.error
      } catch {
        rec.json = false
        rec.textHead = text.slice(0, 200).replace(/\s+/g, ' ')
      }
    }
  } catch (e) {
    rec.status = null
    rec.ms = Date.now() - started
    rec.transportError = String(e?.message ?? e)
  }
  await sleep(delayMs)
  return rec
}

async function probe(target, key, delayMs) {
  const root = rootOf(target.base)
  const origin = originOf(target.base)
  const out = {
    id: target.id, base: target.base, root, origin,
    keyPresent: Boolean(key), keyHint: key ? key.slice(0, 6) + '…' : null, results: [],
  }
  // 模型面在 target.base（可能带 /api/<name> 前缀），控制台面在 origin。
  for (const p of PATHS_ON_BASE) out.results.push(await probeOne(root, p, key, delayMs))
  for (const p of PATHS_ON_ORIGIN) out.results.push(await probeOne(origin, p, key, delayMs))
  return out
}

const opts = args()
const refs = loadCredentialRefs()

let targets = opts.targets ?? BUILTIN_TARGETS
if (opts.only) targets = targets.filter(t => t.id === opts.only)

const skipped = []
targets = targets.filter(t => {
  const host = (() => { try { return new URL(t.base).host.toLowerCase() } catch { return '' } })()
  if (BLOCKED_HOSTS.has(host)) { skipped.push({ id: t.id, reason: 'blocked-by-workspace-policy' }); return false }
  return true
})

const report = { startedAt: new Date().toISOString(), skipped, targets: [] }
for (const t of targets) {
  const key = refs[t.keyEnv] ?? process.env[t.keyEnv] ?? null
  const r = await probe(t, key, opts.delayMs)
  r.keyEnv = t.keyEnv
  report.targets.push(r)
  const line = r.results.map(x => `${x.label}=${x.status ?? 'ERR'}`).join(' ')
  console.log(`[${t.id}] ${line}`)
}
report.finishedAt = new Date().toISOString()

mkdirSync(join(here, 'out'), { recursive: true })
const file = join(here, 'out', 'relay-probe.json')
writeFileSync(file, JSON.stringify(report, null, 2))
console.log(`\n-> ${file}`)
