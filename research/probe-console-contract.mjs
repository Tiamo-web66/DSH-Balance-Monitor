#!/usr/bin/env node
/**
 * 只读提取中转站「控制台前端契约」：从公开的 HTML/JS 静态资源里列出它到底调了哪些接口。
 *
 * 为什么需要它：
 *   /api/status、/api/pricing 在这些站上 404，不代表站里没有倍率/额度接口，
 *   只代表「不在 New API 的默认路径上」。控制台自己会调它自己的接口，
 *   接口名就写在公开的 JS bundle 里。读公开静态资源 = 正常访问网页，不做路径枚举。
 *
 * 只做：GET 首页 → 解析 <script src> → GET 这些 JS → 正则抽出路径字面量。
 * 不做的：不猜路径、不爆破、不发带凭据的请求、不碰受保护站点。
 *
 * 用法：node research/probe-console-contract.mjs https://walkcoding.top
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const origin = process.argv[2]
if (!origin) { console.error('usage: node probe-console-contract.mjs <origin>'); process.exit(1) }

const MAX_ASSETS = 6
const MAX_ASSET_BYTES = 8_000_000

async function getText(url) {
  const res = await fetch(url, { headers: { accept: '*/*' }, signal: AbortSignal.timeout(25000) })
  const text = await res.text()
  return { status: res.status, ctype: res.headers.get('content-type'), text }
}

const index = await getText(origin + '/')
console.log(`[index] HTTP ${index.status} ${index.ctype} ${index.text.length}B`)

// 抽静态资源：<script src>、modulepreload、以及 HTML 里出现的 .js 字面量
const assets = new Set()
for (const m of index.text.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.(?:js|mjs))["']/gi)) {
  assets.add(m[1])
}
for (const m of index.text.matchAll(/["'](\/[^"'\s]+\.(?:js|mjs))["']/g)) {
  assets.add(m[1])
}
const assetUrls = [...assets].slice(0, MAX_ASSETS).map(u => (u.startsWith('http') ? u : new URL(u, origin).href))
console.log(`[assets] ${assetUrls.length}: ${assetUrls.join('\n          ')}`)

// 从 JS 里抽接口路径字面量。只取形如 "/x/y" 的路径，至少两段，避免噪音。
const PATH_RE = /["'`](\/(?:api|v1|dashboard|admin|user|token|auth)[A-Za-z0-9_\-/.:]*?)["'`]/g
// 余额/倍率/订阅相关的关键词，用来给命中的路径加标注
const HINT_RE = /(ratio|倍率|quota|balance|余额|credit|subscription|订阅|plan|usage|额度|group_ratio|倍率)/i

const found = new Map()
const hints = new Map()
for (const url of assetUrls) {
  let res
  try { res = await getText(url) } catch (e) { console.log(`[asset] ${url} ERR ${e.message}`); continue }
  if (res.text.length > MAX_ASSET_BYTES) { console.log(`[asset] ${url} too big (${res.text.length}B), skipped`); continue }
  console.log(`[asset] ${url} HTTP ${res.status} ${res.text.length}B`)
  for (const m of res.text.matchAll(PATH_RE)) {
    const p = m[1]
    found.set(p, (found.get(p) ?? 0) + 1)
  }
  // 关键词命中处前后各 80 字符，用于判断语义
  for (const m of res.text.matchAll(new RegExp(`.{0,70}${HINT_RE.source}.{0,70}`, 'gi'))) {
    const s = m[0].replace(/\s+/g, ' ')
    if (s.length > 20) hints.set(s, (hints.get(s) ?? 0) + 1)
  }
}

const paths = [...found.entries()].sort((a, b) => b[1] - a[1])
console.log(`\n[paths] ${paths.length} unique`)
for (const [p, n] of paths) console.log(`  ${String(n).padStart(3)}×  ${p}`)

console.log(`\n[hints] 余额/倍率/订阅相关片段 ${hints.size} 条（最多列 25）`)
let i = 0
for (const [s] of hints) { console.log(`  · ${s}`); if (++i >= 25) break }

mkdirSync(join(here, 'out'), { recursive: true })
const file = join(here, 'out', `console-contract-${new URL(origin).host.replace(/\W/g, '_')}.json`)
writeFileSync(file, JSON.stringify({ origin, at: new Date().toISOString(), assets: assetUrls, paths, hints: [...hints] }, null, 2))
console.log(`\n-> ${file}`)
