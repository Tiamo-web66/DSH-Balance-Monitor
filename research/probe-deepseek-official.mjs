#!/usr/bin/env node
/**
 * DeepSeek 官方侧能力探测（只读）。
 *
 * 两条互不相通的凭据链路，必须分别测：
 *   A) API Key      : Authorization: Bearer sk-...  ->  GET /user/balance（余额快照）
 *   B) 平台登录态    : x-dsh-auth-token            ->  GET platform /api/v0/users/get_user_summary
 *                                                     （充值/赠金钱包 + 累计消耗 total_costs）
 *
 * 结论（实测见 research/out/deepseek-official.json）：
 *   - A 只能拿余额快照，没有用量/消耗历史接口；
 *   - B 多一个累计消耗金额 total_costs，但 DSH 内置解析器只投影 wallets，会丢掉该字段；
 *   - 官方不提供「价格 / 峰谷时段」的机读接口，只能抓定价页 HTML。
 *
 * 用法：node research/probe-deepseek-official.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const credText = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8')

const refs = {}
{
  const block = /^refs:\s*$([\s\S]*?)(?=^\S|\Z)/m.exec(credText)
  for (const line of block?.[1].split(/\r?\n/) ?? []) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(\S+)\s*$/.exec(line)
    if (m) refs[m[1]] = m[2]
  }
}
const grant = /deepseek-account-platform\/default:[\s\S]*?token:\s*(\S+)/.exec(credText)?.[1] ?? null

async function get(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 401 可能是纯文本 */ }
  return { status: res.status, ctype: res.headers.get('content-type'), json, text: json ? undefined : text.slice(0, 200) }
}

const out = { at: new Date().toISOString(), checks: {} }

// A) 官方余额：同一把 sk- key
const key = refs.DEEPSEEK_API_KEY
out.checks.balance_api_key = {
  keyEnv: 'DEEPSEEK_API_KEY', keyPresent: Boolean(key), keyHint: key?.slice(0, 6) + '…',
  ...(await get('https://api.deepseek.com/user/balance', { authorization: `Bearer ${key}` })),
}

// A2) 模型清单（元数据，无价格字段）
out.checks.models_api_key = await get('https://api.deepseek.com/models', { authorization: `Bearer ${key}` })

// A3) 无效 key 的错误形态（用明显无效的 key，不触碰真实额度）
out.checks.balance_invalid_key = await get('https://api.deepseek.com/user/balance', { authorization: 'Bearer sk-00000000000000000000000000000000' })

// B) 平台登录态：钱包 + 累计消耗
if (grant) {
  const headers = {
    'x-dsh-auth-token': grant,
    'x-client-platform': 'win32',
    'x-client-version': '0.2.0-rc.2',
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': '28800',
    'x-client-bundle-id': '',
  }
  out.checks.user_summary_platform = await get('https://platform.deepseek.com/api/v0/users/get_user_summary', headers)
  out.checks.profile_platform = await get('https://platform.deepseek.com/auth-api/v0/users/current', headers)
} else {
  out.checks.user_summary_platform = { skipped: 'no stored platform grant' }
}

// 落盘前抹掉身份/凭据字段，产物里不留账号信息与任何 token。
// 注意：/auth-api/v0/users/current 的响应体里**会回显 grant token**，
// 必须显式删掉，否则报告产物等于把登录态抄了一份。
const REDACT = /^(email|mobile|mobile_number|id_profile|username|token|identity_verification_id|business_verification_id)$/
const scrub = o => {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      if (REDACT.test(k)) o[k] = '<redacted>'
      else scrub(o[k])
    }
  }
}
scrub(out)

mkdirSync(join(here, 'out'), { recursive: true })
writeFileSync(join(here, 'out', 'deepseek-official.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
