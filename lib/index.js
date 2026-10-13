/**
 * dsh-balance-monitor —— host 半身。
 *
 * 职责：
 *   1. 枚举当前 profile 里已配置的供应商（`llm-pi-ai` 的 providers + `llm-deepseek` 官方路由）
 *   2. 保存每个供应商的「类型」（sub2api / other），存 `$DSH_HOME/storages/dsh-balance-monitor/state.json`
 *   3. 对类型为 sub2api 的供应商，用它的 API Key 调 Sub2Api 的只读接口，
 *      算出租额度 / 倍率 / 模型 / 花费，缓存到内存
 *   4. 给 `llm-pi-ai` 里没声明输入模态的模型自动补 `input: [text, image]`
 *      （新加的自定义供应商不用再逐个勾「图片」），走 `settings.mutate` 落 profile patch
 *   5. 包裹 `llm/stream`：每次调用按「官方价 × 站方倍率」在**调用时刻**记账，
 *      落到 `$DSH_HOME/storages/dsh-balance-monitor/ledger.json`（依据变更不重算历史）
 *   6. 查询 DeepSeek 官方余额（**只有官方这一家**有余额接口），并管理它的多把 key 引用
 *      （`GET/PUT/DELETE /keys` 读写宿主凭据库；`POST /keys/reveal` 按需回明文）
 *   7. 通过 webServer 上的同源路由把结果交给客户端（浏览器侧跨域取不到中转站接口，必须宿主代取），
 *      并对**状态变更**路由做跨站拦截（`crossSiteGuard`：Sec-Fetch-Site / Origin / content-type）
 *
 * 依赖：只用 node 内建模块 + 本包的 ./sub2api.js、./pricing.js、./price-table.js、
 * ./usage-ledger.js、./billing-stream.js、./balance.js、./vision.js、./credentials-refs.js。
 * **不依赖任何
 * `@deepseek-ai/*` 包**——凭据引用按文法学院自校验后把原字符串交给 `ctx.credentials.resolve()`
 * （brand 是编译期的，见下方 REF_PATTERN 注释），因此宿主的模块图解析失败也不会影响本插件。
 * 写配置同理：宿主 `settings` 服务如果不在（老宿主 / 精简组合），插件照常只读运行。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

import { probeSub2Api, describeProbeError, DEFAULT_PROVIDER_TYPE, PROVIDER_TYPES } from './sub2api.js'
import { VISION_SETTINGS_NS, planVisionOps, readModels } from './vision.js'
import { DEFAULT_PRICE_TABLE } from './price-table.js'
import { STATION_PRICE_TABLE, STATION_PRICE_TABLE_META } from './price-table-station.js'
import { STATION_ATTRIBUTION, fetchStationPrices, mergeStationTable, parseStationPrices } from './litellm-prices.js'
import {
  DEFAULT_OFFICIAL_PEAK,
  DEFAULT_PRICE_SOURCES,
  PRICE_SOURCES,
  entrySource,
  makeCallRecord,
  normalizeOfficialPeak,
  phaseAt,
  pricingFingerprint,
  resolveTier,
  upcomingSwitches,
} from './pricing.js'
import { createLlmStreamBilling, usageBuckets } from './billing-stream.js'
import { queryDeepSeekAccountBalance, queryDeepSeekBalance } from './balance.js'
import { REF_NAME_PATTERN, readRefNames } from './credentials-refs.js'
import {
  DEFAULT_DISPLAY,
  addRecordToRollupDay,
  appendRecord,
  applyRollupDay,
  buildReport,
  buildSidebarData,
  createLedger,
  createRollup,
  createUsageDeduper,
  dayKey,
  DEFAULT_RETENTION,
  normalizeLedger,
  normalizeRetention,
  normalizeRollup,
  pruneLedger,
  pruneRollup,
  summarizeDay,
  summarizeDayModels,
  summarizeSession,
} from './usage-ledger.js'

/** Cordis 插件名（Loader 里 entry id 用 `balance-monitor`，这里是包内名）。 */
export const name = 'balance-monitor'

/** 这个插件需要 webServer 才能把结果交给浏览器；settings/credentials 是可选依赖。 */
export const inject = ['webServer']

/**
 * 候选引用名生成：`DEEPSEEK_API_KEY`、`DEEPSEEK_API_KEY_2` … `_9`（前缀与上限可配）。
 *
 * 为什么只能「猜名字」：宿主凭据服务没有枚举 refs 的公开接口
 * （`listRecords()` 只覆盖 `records:` 段，API Key 存在 `refs:` 段里）。
 * 所以用 `credentials.describe(ref)` 逐个探测 —— 它只回「有没有配 / 来源」，
 * **不回值**，探测本身不接触密钥内容。
 */
const DEFAULT_KEY_PREFIXES = ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY']
const DEFAULT_KEY_MAX_INDEX = 9

function keyRefCandidates({ apiKeyEnv = null, prefixes = DEFAULT_KEY_PREFIXES, maxIndex = DEFAULT_KEY_MAX_INDEX } = {}) {
  const list = []
  const push = value => {
    if (typeof value !== 'string') return
    const ref = value.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || list.includes(ref)) return
    list.push(ref)
  }
  push(apiKeyEnv)
  for (const prefix of Array.isArray(prefixes) && prefixes.length > 0 ? prefixes : DEFAULT_KEY_PREFIXES) {
    push(prefix)
    const limit = Math.max(1, Math.min(50, Math.trunc(maxIndex) || DEFAULT_KEY_MAX_INDEX))
    for (let index = 2; index <= limit; index += 1) push(`${prefix}_${index}`)
  }
  return list
}

/** 归一 `deepseekKeyPrefixes`（数组，元素是合法引用名前缀）。 */
function normalizeKeyPrefixes(value) {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter(item => typeof item === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.trim()))
    .map(item => item.trim().slice(0, 60))
  return out.length === 0 ? undefined : [...new Set(out)]
}

/** 清空历史必须显式带这个确认串（破坏性操作，写错一个字都不动手）。 */
const HISTORY_CLEAR_TOKEN = 'clear-all-history'

/**
 * 「导入安装前历史」的能力探测。
 *
 * 唯一可能的来源是宿主会话日志（`~/.dsh/sessions/<项目>/<会话>/session.jsonl.zstd`）。
 * 实测（Node v24，2026-10）：文件是**分帧 zstd**，`zstdDecompressSync` 只解出会话头那一行
 * （`type,version,id,createdAt,cwd,delegationDepth,agentPreset`），流式解码也拿不到可用的
 * 用量记录。所以这里**如实报「不可用 + 原因」**，不拿未验证的格式写一个「导入成功」的假实现，
 * 也**不做任何回放 / 重定价**（那会推翻「入账即固化」：历史金额会随改价变）。
 */
function historyImportProbe() {
  const root = join(dshHome(), 'sessions')
  const report = {
    available: false,
    reason: null,
    sessionsRoot: root,
    projects: 0,
    sessionFiles: 0,
    zstd: typeof zstdDecompressSync === 'function',
  }
  let projectNames = []
  try {
    projectNames = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    report.reason = '读不到宿主会话目录（这个环境没有会话存储，或权限不足）'
    return report
  }
  report.projects = projectNames.length
  for (const name of projectNames) {
    try {
      for (const session of readdirSync(join(root, name), { withFileTypes: true })) {
        if (session.isDirectory() && existsSync(join(root, name, session.name, 'session.jsonl.zstd'))) {
          report.sessionFiles += 1
        }
      }
    } catch {
      // 单个项目读不动不影响整体统计
    }
  }
  if (report.sessionFiles === 0) {
    report.reason = '会话目录里没有可读的会话日志（没有历史可导入）'
    return report
  }
  report.reason = report.zstd
    ? `找到 ${report.sessionFiles} 份会话日志，但它们是分帧 zstd 存储、且没有公开的用量字段 schema：`
      + '实测只解得出会话头一行（拿不到逐次调用的 usage），所以本版本不导入 —— '
      + '宁可不做，也不用未验证的格式算出一堆错的金额。'
    : `找到 ${report.sessionFiles} 份会话日志，但当前 Node 不支持 zstd 解压（需要 Node ≥ 22.15 的 zlib.zstdDecompress），读不出来。`
  return report
}

/**
 * 归一 `allowedHosts`：额外放行的 `host[:port]` 列表（默认空 = 只允许回环）。
 *
 * 只做形状校验（字母/数字/点/横线/下划线，可选端口，IPv6 方括号），去重、转小写、上限 20 条。
 * 语义上它**只放宽** Host 判据，不影响跨站判据 —— 所以列一个公网域名进来不会让
 * 「任意网页的跨站 POST」重新得逞。
 */
function normalizeAllowedHosts(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const host = item.trim().toLowerCase()
    if (host.length === 0 || host.length > 100) continue
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d{1,5})?$/.test(host)) continue
    if (!out.includes(host)) out.push(host)
    if (out.length >= 20) break
  }
  return out.length === 0 ? undefined : out
}

/** 界面偏好的默认值（`state.json` 的 `ui` 块按这个结构逐字段覆盖它）。 */
const UI_DEFAULTS = {
  /** `auto` = 跟随浏览器语言；`zh` / `en` = 固定。 */
  locale: 'auto',
  /** 侧栏轮询间隔（秒）。 */
  refreshSeconds: 30,
  /** 隐藏官方余额区块（截屏防泄露）。 */
  hideOfficialBalance: false,
  /** 隐藏今日消耗区块。 */
  hideTodayCost: false,
  /** 会话明细表里显示完整会话 ID。 */
  showSessionId: false,
}
const UI_REFRESH_MIN = 10
const UI_REFRESH_MAX = 60

/**
 * 归一 `ui` 块（只保留合法且**显式给出**的字段；非法值当没给）。
 *
 * 这里不补默认值 —— 默认由 `uiConfig()` 那侧合并，所以 `state.json` 里只沉淀
 * 与默认不同的部分（用户不动配置就不会平白多出一段）。
 */
function normalizeUi(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  if (value.locale === 'zh' || value.locale === 'en') out.locale = value.locale
  const seconds = Number(value.refreshSeconds)
  if (Number.isInteger(seconds) && seconds >= UI_REFRESH_MIN && seconds <= UI_REFRESH_MAX) out.refreshSeconds = seconds
  for (const key of ['hideOfficialBalance', 'hideTodayCost', 'showSessionId']) {
    if (typeof value[key] === 'boolean') out[key] = value[key]
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** 与默认值相同的字段不落盘（用户没改过的键不进 `state.json`）。`ui` 与 `modelCard` 共用。 */
function diffFromDefaults(value, defaults = UI_DEFAULTS) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== defaults[key]) out[key] = item
  }
  return out
}

/** 会话相关三块（本会话费用 / 额度横条 / 右下角角标）的默认值。 */
const SESSION_COST_DEFAULTS = {
  enabled: false,
  /** `composer`（输入区下方）/ `header`（会话标题栏）/ `off`。 */
  position: 'composer',
  showHitRate: true,
  /** 把父会话 id 指向本会话的调用也算进来（宿主给了归属信息才算得出来）。 */
  includeSubagent: false,
}
const QUOTA_STRIP_DEFAULTS = {
  enabled: false,
  /** 横条里是否也显示官方余额。 */
  showBalance: true,
}
const CORNER_DEFAULTS = {
  enabled: false,
  /** 角标里是否带 Top-1 模型。 */
  showTop1: false,
}

/** 三个会话区块共用一套归一：布尔只认 `true`，`position` 只认三个枚举值，且只留与默认不同的。 */
function normalizeConversationBlock(raw, defaults) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = raw[key]
    if (key === 'position') {
      if ((value === 'composer' || value === 'header' || value === 'off') && value !== fallback) out[key] = value
      continue
    }
    if (typeof fallback === 'boolean' && value === true) out[key] = true
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** 三个会话区块的局部补丁合并（给的值合法就用它，否则沿用当前生效值）。 */
function mergeConversationBlock(patch, current, defaults) {
  const merged = {}
  for (const key of Object.keys(defaults)) {
    const raw = patch[key]
    merged[key] = key === 'position'
      ? (raw === 'composer' || raw === 'header' || raw === 'off' ? raw : current[key])
      : (typeof raw === 'boolean' ? raw : current[key])
  }
  return merged
}

/** 侧栏「模型花费卡片」的默认值（`state.json` 的 `modelCard` 按字段覆盖它）。 */
const MODEL_CARD_DEFAULTS = {
  /** 默认关闭：侧栏位置寸土寸金，不默认塞一块。 */
  enabled: false,
  /** 打开时是否默认展开（否则只显示一行摘要）。 */
  defaultExpanded: false,
  /** 记住用户上次的展开/收起（`localStorage`）。 */
  rememberExpanded: true,
  /** 行里显示 token 数。 */
  showTokens: true,
  /** 显示费用占比条。 */
  showShare: true,
  /** 默认周期：`today` / `days90`。 */
  period: 'today',
  /** 显示几行（1–10）。 */
  rows: 5,
  /** 卡片位置：`bottom`（默认，跟在峰谷条后面）/ `top`（紧跟今日行）。 */
  position: 'bottom',
}
const MODEL_CARD_ROWS_MAX = 10

/** 归一模型花费卡片配置：只保留合法且与默认不同的字段（与 `ui` 块同一套规矩）。 */
function normalizeModelCard(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const key of ['enabled', 'defaultExpanded', 'rememberExpanded', 'showTokens', 'showShare']) {
    if (raw[key] === true) out[key] = true
  }
  if (raw.period === 'days90') out.period = 'days90'
  const rows = Number(raw.rows)
  if (Number.isInteger(rows) && rows >= 1 && rows <= MODEL_CARD_ROWS_MAX && rows !== MODEL_CARD_DEFAULTS.rows) out.rows = rows
  if (raw.position === 'top') out.position = 'top'
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * 让一批 key 的**显示标签**互不重复。
 *
 * 派生标签会撞车：`DEEPSEEK_API_KEY` 与 `API_KEY` 都派生成 `API KEY`（实测确认），
 * 侧栏明细里两行看起来一模一样，用户分不清谁是谁。撞了就退回「标签（原引用名）」。
 * 只动显示，不动引用解析。
 */
function disambiguateKeyLabels(entries) {
  const counts = new Map()
  for (const entry of entries) {
    const label = entry.label ?? entry.ref
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return entries.map(entry => {
    const label = entry.label ?? entry.ref
    return counts.get(label) > 1 ? { ...entry, label: `${label}（${entry.ref}）` } : entry
  })
}

/**
 * 引用名的**派生短标签**：手工在 `state.json` 里填 `deepseekKeys` 的引用没有 label，
 * 侧栏明细会退化成一长串 `DEEPSEEK_API_KEY_2`。这里按名字派一个中性的短标签，
 * 手工填的也有可读名字（卡片上自己填的 label 优先，见 `describeKeys`）。
 *
 *   `DEEPSEEK_API_KEY`   → `API KEY`
 *   `DEEPSEEK_API_KEY_2` → `API KEY 2`
 *   `DEEPSEEK_KEY`       → `KEY`
 *   `WALK_GROK_API_KEY`  → `WALK GROK API KEY`
 *
 * **只影响显示**（余额明细那一行），不参与任何账目与引用解析。
 */
function deriveKeyLabel(ref) {
  const name = String(ref ?? '').trim()
  if (name.length === 0) return null
  const stripped = name
    .replace(/^DEEPSEEK[_-]?/i, '')
    .replace(/^API[_-]?KEY[_-]?/i, 'API KEY ')
    .replace(/[_-]+/g, ' ')
    .trim()
  return stripped.length === 0 ? name : stripped
}

/**
 * DeepSeek 的**两条路线**（登录账号后宿主里会同时存在两个供应商，余额是两份不同的钱）：
 *
 * | provider id         | 包                          | 认证                | 余额来源 |
 * |---------------------|-----------------------------|---------------------|----------|
 * | `deepseek-official` | `dsh-llm-deepseek-api-key`  | `Authorization: Bearer` | `api.deepseek.com/user/balance` |
 * | `deepseek-account`  | `dsh-llm-deepseek-account`  | `x-dsh-auth-token`（来自 `deepseekAccount` 服务） | `platform.deepseek.com/api/v0/users/get_user_summary` |
 *
 * 两条都算「官方」：没有站方倍率，按官方价 + 官方峰谷计价。
 * settingsNs 用候选列表：实际 entry id 由部署决定（实测本机 API Key 路线是 `llm-deepseek`，
 * 也可能是 `llm-deepseek-api-key`）。
 */
const DEEPSEEK_ROUTES = [
  {
    provider: 'deepseek-official',
    displayName: 'DeepSeek',
    kind: 'api-key',
    namespaces: ['llm-deepseek', 'llm-deepseek-api-key'],
    defaultBaseURL: 'https://api.deepseek.com',
  },
  {
    provider: 'deepseek-account',
    displayName: 'DeepSeek Account',
    kind: 'account',
    namespaces: ['llm-deepseek-account'],
    defaultBaseURL: 'https://api.deepseek.com',
  },
]
/** 官方路线：不乘站方倍率。 */
const OFFICIAL_PROVIDERS = new Set(DEEPSEEK_ROUTES.map(route => route.provider))

/**
 * 归一 `deepseekKeys`：支持 `["REF", ...]` 与 `[{ ref, label?, route? }, ...]` 两种写法。
 *
 * 为什么需要它：宿主自己的 DeepSeek API Key 适配器只认**一把** key（`apiKeyEnv` 是单值），
 * 想按多把 key 汇总余额，只能在本插件配置里列出多个凭据引用。
 */
function normalizeDeepseekKeys(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  const seen = new Set()
  for (const item of value) {
    const raw = typeof item === 'string' ? { ref: item } : item
    if (raw === null || typeof raw !== 'object') continue
    const ref = typeof raw.ref === 'string' ? raw.ref.trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || seen.has(ref)) continue
    seen.add(ref)
    out.push({
      ref,
      ...(typeof raw.label === 'string' && raw.label.trim().length > 0 ? { label: raw.label.trim().slice(0, 40) } : {}),
      ...(raw.route === 'deepseek-account' || raw.route === 'deepseek-official' ? { route: raw.route } : {}),
    })
  }
  return out.length === 0 ? undefined : out
}

const ROUTE_PREFIX = '/plugins/dsh-balance-monitor'
/** state.json 结构版本：v2 起多一个 `autoImage`（自动补图片开关）。v1 文件照读。 */
const STATE_VERSION = 2
/** 自动刷新的缓存时长；手动刷新绕过。 */
const CACHE_MS = 60_000
/** 单次请求体上限，防止本地任意进程往 POST 里灌垃圾。 */
const MAX_BODY_BYTES = 16 * 1024
/** 写配置失败后的自动重试冷却：避免每次 GET /state 都撞同一堵墙。 */
const VISION_RETRY_MS = 30_000
/** 侧栏触发的探测冷却：侧栏会常驻轮询，不能让它把中转站的探测节奏带成 60s 一次。 */
const SIDEBAR_PROBE_COOLDOWN_MS = 5 * 60_000
/** 官方余额的缓存时长（官方接口，代价低，但没必要每次轮询都打）。 */
const BALANCE_CACHE_MS = 60_000
/** 账本落盘防抖。 */
const LEDGER_WRITE_DEBOUNCE_MS = 2_000

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 峰谷提醒的默认值（`state.json` 的 `peakNotify` 按字段覆盖它）。 */
const PEAK_NOTIFY_DEFAULTS = {
  /** 跨档时在侧栏弹一条提醒。 */
  enabled: false,
  /** 同时发浏览器系统通知（需授权）。 */
  system: false,
  /** 提前多少分钟提醒（1–30）。 */
  leadMinutes: 2,
  /** 提醒哪一侧：`both` / `peak`（只提醒进入峰）/ `off`（只提醒进入谷）。 */
  type: 'both',
  /** 弹窗位置：`corner`（右下角）/ `center`（屏幕中间）。 */
  position: 'corner',
}
const PEAK_LEAD_MIN = 1
const PEAK_LEAD_MAX = 30

/**
 * 归一峰谷提醒（`state.json` 的 `peakNotify`）。
 *
 * 规则与 `ui` 块一致：**只保留与默认不同的字段**（全默认 = `undefined`，文件里不留一条）。
 * 于是「关掉提醒」既可以是 `enabled: false`，也可以理解成「这一项没配」——
 * 两者语义相同，不需要额外区分。
 */
function normalizePeakNotify(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  if (raw.enabled === true) out.enabled = true
  if (raw.system === true) out.system = true
  const lead = Number(raw.leadMinutes)
  if (Number.isInteger(lead) && lead >= PEAK_LEAD_MIN && lead <= PEAK_LEAD_MAX
    && lead !== PEAK_NOTIFY_DEFAULTS.leadMinutes) out.leadMinutes = lead
  if ((raw.type === 'peak' || raw.type === 'off') && raw.type !== PEAK_NOTIFY_DEFAULTS.type) out.type = raw.type
  if (raw.position === 'center') out.position = 'center'
  return Object.keys(out).length === 0 ? undefined : out
}

/** 严格取字符串：空串按未设置处理。 */
function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function loadStore() {
  const file = join(dshHome(), 'storages', 'dsh-balance-monitor', 'state.json')
  const empty = { version: STATE_VERSION, types: {}, autoImage: {} }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { file, data: empty }
  }
  const types = {}
  if (parsed && typeof parsed.types === 'object' && parsed.types !== null) {
    for (const [provider, type] of Object.entries(parsed.types)) {
      if (PROVIDER_TYPES.includes(type)) types[provider] = type
    }
  }
  // 自动补图片开关：只有显式 false 才关（默认开，符合「新加供应商不用手动勾」的诉求）。
  const autoImage = {}
  if (parsed && typeof parsed.autoImage === 'object' && parsed.autoImage !== null) {
    for (const [provider, enabled] of Object.entries(parsed.autoImage)) {
      if (typeof enabled === 'boolean') autoImage[provider] = enabled
    }
  }
  // 展示币种：与参照实现同名的四个字段（currency / symbol / decimals / exchangeRate）。
  const display = { ...DEFAULT_DISPLAY }
  if (parsed && typeof parsed.display === 'object' && parsed.display !== null) {
    const currency = typeof parsed.display.currency === 'string' ? parsed.display.currency.toUpperCase() : undefined
    if (currency === 'CNY' || currency === 'USD') display.currency = currency
    if (typeof parsed.display.symbol === 'string' && parsed.display.symbol.length > 0) display.symbol = parsed.display.symbol
    const decimals = Number(parsed.display.decimals)
    if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 8) display.decimals = decimals
    const rate = Number(parsed.display.exchangeRate)
    if (Number.isFinite(rate) && rate > 0) display.exchangeRate = rate
  }
  // 价表覆盖：给了就整段顶掉默认表（默认表在 lib/price-table.js，自动生成）。
  const priceTable = parsed && typeof parsed.priceTable === 'object' && parsed.priceTable !== null && !Array.isArray(parsed.priceTable)
    ? parsed.priceTable
    : undefined
  // 计价采用的来源等级：**默认只用官方价 + 手工价**；转售（opencode.ai）/聚合（openrouter）
  // 需在这里显式列入才会参与计算。空数组/非法值回落默认。
  const priceSources = Array.isArray(parsed?.priceSources)
    ? parsed.priceSources.filter(source => PRICE_SOURCES.includes(source))
    : undefined
  // 预算：额度 + 周期（今日 / 本月 / 累计）
  const budgetPeriods = ['today', 'month', 'all']
  const rawBudget = parsed?.budget
  // 注意 `null` / 空串 / 非数字都算「没填」：`Number(null)` 是 0，稍不注意就把
  // 「未设额度」写成「额度 0」。
  const rawAmount = rawBudget?.amount
  const parsedAmount = typeof rawAmount === 'number'
    ? rawAmount
    : (typeof rawAmount === 'string' && rawAmount.trim() !== '' ? Number(rawAmount) : Number.NaN)
  const budget = rawBudget !== null && typeof rawBudget === 'object' && !Array.isArray(rawBudget)
    ? {
        enabled: rawBudget.enabled === true,
        amount: Number.isFinite(parsedAmount) && parsedAmount >= 0 ? parsedAmount : null,
        period: budgetPeriods.includes(rawBudget.period) ? rawBudget.period : 'month',
      }
    : undefined
  // 多把 DeepSeek key：凭据引用列表（宿主适配器只认一把，多 key 靠这里表达）
  const deepseekKeys = normalizeDeepseekKeys(parsed?.deepseekKeys)
  // 候选扫描：前缀列表 + 序号上限（只用于 describe() 探测名字，不读值）
  const deepseekKeyPrefixes = normalizeKeyPrefixes(parsed?.deepseekKeyPrefixes)
  const rawMaxIndex = Number(parsed?.deepseekKeyMaxIndex)
  const deepseekKeyMaxIndex = Number.isFinite(rawMaxIndex) && rawMaxIndex >= 1 && rawMaxIndex <= 50 ? Math.trunc(rawMaxIndex) : undefined
  // 方案 B 开关：读凭据文件的 refs 段「只取键名」（默认开；关掉就退回纯候选名探测）
  const scanCredentialsFile = parsed?.scanCredentialsFile === false ? false : undefined
  // 保留期：账本明细 / 日汇总各留几天（都能省；省了就用 DEFAULT_RETENTION）
  const retention = normalizeRetention(parsed?.retention)
  // 峰谷提醒：应用内 / 系统通知（都关就是默认）
  const peakNotify = normalizePeakNotify(parsed?.peakNotify)
  // 官方峰谷：窗口 / 假期 / 三个时刻，逐字段覆盖默认表（`lib/pricing.js` 的
  // `DEFAULT_OFFICIAL_PEAK`）。不写就用随包默认表 —— 假期表因此不用改源码也能更新。
  const officialPeak = normalizeOfficialPeak(parsed?.officialPeak)
  // Host 白名单：默认只允许回环（防 DNS rebinding）；反代 / 自定义域名在这里显式列出。
  const allowedHosts = normalizeAllowedHosts(parsed?.allowedHosts)
  // 界面偏好（语言 / 轮询间隔 / 隐藏敏感区块 / 会话表显示 ID）：同样只沉淀与默认不同的字段。
  const ui = normalizeUi(parsed?.ui)
  // 侧栏模型花费卡片：同样是「只存与默认不同的字段」。
  const modelCard = normalizeModelCard(parsed?.modelCard)
  // 会话相关三块（T3）：本会话费用 / 额度横条 / 右下角角标。
  const sessionCost = normalizeConversationBlock(parsed?.sessionCost, SESSION_COST_DEFAULTS)
  const quotaStrip = normalizeConversationBlock(parsed?.quotaStrip, QUOTA_STRIP_DEFAULTS)
  const corner = normalizeConversationBlock(parsed?.corner, CORNER_DEFAULTS)
  return {
    file,
    data: {
      version: STATE_VERSION,
      types,
      autoImage,
      display,
      ...(budget === undefined ? {} : { budget }),
      ...(retention === undefined ? {} : { retention }),
      ...(peakNotify === undefined ? {} : { peakNotify }),
      ...(officialPeak === undefined ? {} : { officialPeak }),
      ...(deepseekKeys === undefined ? {} : { deepseekKeys }),
      ...(deepseekKeyPrefixes === undefined ? {} : { deepseekKeyPrefixes }),
      ...(deepseekKeyMaxIndex === undefined ? {} : { deepseekKeyMaxIndex }),
      ...(scanCredentialsFile === undefined ? {} : { scanCredentialsFile }),
      ...(allowedHosts === undefined ? {} : { allowedHosts }),
      ...(ui === undefined ? {} : { ui }),
      ...(modelCard === undefined ? {} : { modelCard }),
      ...(sessionCost === undefined ? {} : { sessionCost }),
      ...(quotaStrip === undefined ? {} : { quotaStrip }),
      ...(corner === undefined ? {} : { corner }),
      ...(priceTable === undefined ? {} : { priceTable }),
      ...(priceSources === undefined || priceSources.length === 0 ? {} : { priceSources }),
    },
  }
}

/**
 * 账本（按天的调用记录）。坏文件按空账本启动：账本不该让插件起不来。
 * 但**要把「读失败」这件事带出去** —— 空账本会被 syncRollup 当成「今天没花钱」，
 * 那会把 days.json 当天的金额覆盖成 0（见 syncRollup 的守卫与 apply 里的日志）。
 * @returns {{ file: string, ledger: object, readFailed: boolean, missing: boolean, error?: string }}
 */
function loadLedger() {
  const file = join(dshHome(), 'storages', 'dsh-balance-monitor', 'ledger.json')
  try {
    return { file, ledger: normalizeLedger(JSON.parse(readFileSync(file, 'utf8'))), readFailed: false, missing: false }
  } catch (error) {
    return {
      file,
      ledger: createLedger(),
      readFailed: true,
      // 首次运行没有这个文件是正常现象，不该刷警告
      missing: error?.code === 'ENOENT',
      error: String(error?.message ?? error),
    }
  }
}

/**
 * 站方价目（点「更新价格表」后写在这里）。与 state.json 分开：
 * 全量目录几百 KB，不该塞进会被频繁读写的配置里。
 * @returns {{ file: string, models: object, meta: object | null }}
 */
function loadStationPrices() {
  const file = join(dshHome(), 'storages', 'dsh-balance-monitor', 'prices.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const models = parsed?.models
    if (models !== null && typeof models === 'object' && !Array.isArray(models) && Object.keys(models).length > 0) {
      return { file, models, meta: parsed?.meta ?? null }
    }
  } catch {
    // 没有文件 / 坏文件：回落到随包快照
  }
  return { file, models: null, meta: null }
}

/**
 * 长期日汇总（本月 / 累计要靠它，账本只留最近几天）。
 * @returns {{ file: string, rollup: object }}
 */
function loadRollup() {
  const file = join(dshHome(), 'storages', 'dsh-balance-monitor', 'days.json')
  try {
    return { file, rollup: normalizeRollup(JSON.parse(readFileSync(file, 'utf8'))) }
  } catch {
    return { file, rollup: createRollup() }
  }
}

function saveStore(file, data) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  // 先写临时文件再改名：中途崩溃不会留下半截 JSON。
  renameSync(tmp, file)
}

/** 读请求体（带上限），返回解析后的 JSON 或 undefined。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(body.length))
  res.end(body)
}

/** 会改状态的方法（其余按只读处理）。 */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

/** 回环的合法写法（比较前先剥端口、转小写）。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

/** `Host` 去掉端口：`127.0.0.1:3080` → `127.0.0.1`、`[::1]:3080` → `[::1]`。 */
function bareHost(host) {
  const value = String(host ?? '').trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(0, end + 1)
  }
  const colon = value.lastIndexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

/** 是不是「本机」的地址：整个 `127.0.0.0/8`、`localhost`、IPv6 回环。 */
function isLoopbackHost(host) {
  const bare = bareHost(host)
  if (LOOPBACK_HOSTS.has(bare)) return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/**
 * `Host` 白名单（**所有方法都查**）：挡 DNS rebinding。
 *
 * 为什么光有跨站判据不够：rebinding 攻击里，恶意页所在的域名先解析到攻击者服务器
 * （用来投递页面），随后 DNS 重新解析到 `127.0.0.1`，浏览器于是把 `fetch('/plugins/…')`
 * 打到本机的宿主 webserver 上 —— 对浏览器来说这是**同源**请求，于是
 * `Sec-Fetch-Site: same-origin`、`Origin: http://evil.test:3080`、`Host: evil.test:3080`
 * 三者与合法请求逐字节相同，跨站那三条判据一条都不会命中。唯一能区分的就是 `Host`：
 * 合法请求的 Host 一定是用户地址栏里那个（默认就是回环地址）。
 *
 * 因此：Host 去端口后必须是回环；不是回环就要在 `state.json` 的 `allowedHosts` 里显式列出
 * （反代 / 自定义域名 / 局域网访问的部署）。
 *
 * **不带 `Host` 时放行**（HTTP/1.0、脚本、测试桩）—— 浏览器一定会带这个头，
 * 所以放行它不会给浏览器侧的 rebinding 留口子。
 *
 * @param {object} req
 * @param {string[]} allowedHosts 额外允许的 `host[:port]`（小写）
 * @returns {{ status: number, error: string } | null} null = 放行
 */
function hostGuard(req, allowedHosts) {
  const raw = req?.headers?.host
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  if (isLoopbackHost(raw)) return null
  const host = raw.trim().toLowerCase()
  const extra = Array.isArray(allowedHosts) ? allowedHosts : []
  if (extra.includes(host) || extra.includes(bareHost(host))) return null
  return {
    status: 403,
    error: `Host「${host}」不在允许列表：本插件默认只接受回环地址（防 DNS rebinding）。`
      + '若你通过反向代理 / 自定义域名访问宿主，请把该主机名写进 state.json 的 allowedHosts（设置页「显示 → 访问控制」可改）。',
  }
}

/** `Origin` 的 `host[:port]`（小写）；不是合法 URL（含字面量 `null`）时回 null。 */
function originHost(origin) {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * content-type 判据：HTML 表单 / `no-cors` fetch 都带不上 `application/json`
 * （跨站想带 `application/json` 必然触发预检，而本路由不处理 `OPTIONS`）。
 */
function contentTypeGuard(headers) {
  const raw = typeof headers['content-type'] === 'string' ? headers['content-type'] : null
  const type = raw === null ? null : raw.split(';')[0].trim().toLowerCase()
  if (type !== null && type.length > 0 && type !== 'application/json') {
    return { status: 415, error: `只接受 application/json（收到 ${type}）` }
  }
  return null
}

/**
 * 状态变更路由的跨站拦截面（**只挡浏览器，不挡命令行**）。
 *
 * 这个 webserver 本身不鉴权（宿主不管认证），只监听回环，所以「本机任意进程」
 * 本来就挡不住，也没打算挡 —— 它能直接读凭据文件，拦这个路由没有意义。要挡的是
 * **任意网页**：一个简单请求（无预检）就能把 POST 打进来，让插件替你删 key / 写 key /
 * 改类型 / 触发抓取，而这些都有副作用。
 *
 * 判据分两级，**有 `Sec-Fetch-Site` 就以它为准**：
 *   ① `Sec-Fetch-Site` 由浏览器自己写（页内脚本改不了），存在时只看它：
 *      `same-origin` / `none` 放行，其余（`cross-site` / `same-site`）一律拒；
 *   ② 老浏览器不发这个头 → 退回 `Origin` ↔ `Host` 比对（不同源即拒）。
 *
 * 为什么第②级不能无条件跑：`Origin` 是浏览器按**页面 URL** 填的，而 `Host` 在反向代理
 * 后面可能被改写（nginx `proxy_pass` 的默认行为就是把 Host 写成上游地址）。那种部署下
 * 「页面同源、Host 却是 127.0.0.1:3080」是正常现象，无条件比对会把插件自己的 UI 全挡掉
 * （所有写操作 403）。两级都过不了只剩一种情况：老浏览器 + 反代改写 Host —— 那种环境
 * 请让反代保留原始 `Host`。
 *
 * 三个头都不存在时**放行**（`curl`、脚本、老客户端），否则打不开命令行用法。GET 不校验。
 *
 * @param {object} req
 * @returns {{ status: number, error: string } | null} null = 放行
 */
function crossSiteGuard(req) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (!STATE_CHANGING_METHODS.has(method)) return null
  const headers = req?.headers ?? {}

  const site = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'].trim().toLowerCase() : null
  if (site !== null) {
    if (site !== 'same-origin' && site !== 'none') {
      return { status: 403, error: `跨站请求被拒绝（Sec-Fetch-Site: ${site}）` }
    }
    return contentTypeGuard(headers)
  }

  const origin = typeof headers.origin === 'string' ? headers.origin.trim() : null
  if (origin !== null && origin.length > 0) {
    const host = typeof headers.host === 'string' ? headers.host.trim().toLowerCase() : null
    if (host === null || originHost(origin) !== host) {
      return { status: 403, error: `跨源请求被拒绝（Origin: ${origin}）` }
    }
  }

  return contentTypeGuard(headers)
}

/**
 * 读 settings 服务的配置快照：`ns → { value, revision }`。
 *
 * 宿主（0.2.x）的 `settings` 服务是 `@deepseek-ai/dsh-settings`，它**没有 `get(ns)`**：
 * 它把「可实时编辑的字段」（schema 里 `.volatile()` 的那部分）投影成带修订号的描述符，
 * `describe()` → `[{ ns, revision, value, base, user, ... }]`。`llm-pi-ai` 的
 * `providers` 正是它唯一的 volatile 段，所以 `value.providers` 就是供应商字典；
 * `revision` 拿来写回时防「读到写之间被别人改了」。
 *
 * 旧宿主 / 测试桩只有 `get(ns)` 时退回它（没有修订号，写回时就只能放弃并发保护）。
 *
 * @returns {Map<string, { value: object, revision?: number }>}
 */
function readSettings(ctx) {
  const out = new Map()
  const settings = ctx.get('settings')
  if (settings === undefined) return out

  if (typeof settings.describe === 'function') {
    try {
      for (const row of settings.describe() ?? []) {
        if (row && typeof row.ns === 'string') {
          out.set(row.ns, {
            value: row.value ?? {},
            revision: typeof row.revision === 'number' ? row.revision : undefined,
          })
        }
      }
      if (out.size > 0) return out
    } catch (error) {
      ctx.logger?.warn?.(`dsh-balance-monitor: 读 settings 描述符失败，退回 get()：${String(error?.message ?? error)}`)
    }
  }

  if (typeof settings.get === 'function') {
    for (const ns of [VISION_SETTINGS_NS, 'llm-deepseek']) {
      try {
        const value = settings.get(ns)
        if (value !== undefined && value !== null) out.set(ns, { value })
      } catch {
        // 单个段读失败不影响其它段。
      }
    }
  }
  return out
}

/**
 * 从 settings 快照枚举供应商。
 *
 * `llm-pi-ai` 的 settings 段是 `{ providers: { <id>: { apiKeyEnv, baseURL, displayName, api, models } } }`；
 * `llm-deepseek` 是官方路由，配置在段顶层（无 providers 字典），它的 provider id 用 `deepseek-official`。
 * 每行都带 `models`（模态补全要按它算缺口）。
 */
function collectProviders(ctx) {
  const sections = readSettings(ctx)
  const rows = []

  const providers = sections.get(VISION_SETTINGS_NS)?.value?.providers
  if (providers && typeof providers === 'object') {
    for (const [id, profile] of Object.entries(providers)) {
      if (!profile || typeof profile !== 'object') continue
      const models = readModels(profile)
      rows.push({
        provider: id,
        displayName: text(profile.displayName) ?? id,
        settingsNs: VISION_SETTINGS_NS,
        baseURL: text(profile.baseURL),
        apiKeyEnv: text(profile.apiKeyEnv),
        api: text(profile.api),
        modelCount: models.length,
        models,
      })
    }
  }

  // DeepSeek 的两条路线都枚举：登录账号后宿主里会有两个供应商，余额是两份不同的钱。
  // settingsNs 用候选列表匹配（entry id 由部署决定），只有配置真的存在时才列出来。
  for (const route of DEEPSEEK_ROUTES) {
    // 只认「配置里真的存在这个 settings ns」：账号路线的配置可能是空对象，
    // 所以判据是 ns 存在而不是「配置非空」。
    const ns = route.namespaces.find(candidate => sections.get(candidate)?.value !== undefined)
    if (ns === undefined) continue
    const value = sections.get(ns)?.value ?? {}
    rows.push({
      provider: route.provider,
      displayName: route.displayName,
      settingsNs: ns,
      deepseekRoute: route.kind,
      baseURL: text(value.baseURL) ?? route.defaultBaseURL,
      // 账号路线没有 API Key：它用 `deepseekAccount` 服务的 token。
      apiKeyEnv: route.kind === 'api-key' ? (text(value.apiKeyEnv) ?? 'DEEPSEEK_API_KEY') : undefined,
      api: undefined,
      modelCount: 0,
      models: [],
    })
  }

  return rows
}

/**
 * 凭据引用名的文法，与 `@deepseek-ai/dsh-credentials` 的 `REF_PATTERN` 一致：
 * `/^[A-Za-z_][A-Za-z0-9_]*$/`。
 *
 * 为什么这里不 import `credentialRef`：
 *   1. 它的实现是 `credentialRef(v) { if (!isCredentialRefName(v)) throw ...; return brandString(v) }`，
 *      而 `brandString(value) { return value }` —— **brand 只存在于编译期**，运行时它就是个原字符串。
 *      所以自己按同一文法校验后直接把字符串传给 `credentials.resolve()`，与调 `credentialRef()` 完全等价。
 *   2. `@deepseek-ai/dsh-credentials` 在磁盘上解析不到（profile 下的 `@deepseek-ai/*` 全是断链 junction，
 *      只有宿主自己的模块图能提供）。依赖它就得赌宿主的 loader 是否也接管动态 import。
 *   不依赖它，插件在任何宿主上都不会因为一个凭据包的解析失败而丢掉余额查询能力。
 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 从 DSH 凭据库解析某 provider 的 API Key；失败退回同名环境变量。
 * 与 dsh-cost-meter 的 resolveGoKey 同构：凭据库优先，env 兜底。
 * @returns {Promise<{ value: string, source: string } | undefined>}
 */
async function resolveApiKey(ctx, apiKeyEnv) {
  if (apiKeyEnv === undefined) return undefined
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function' && REF_PATTERN.test(apiKeyEnv)) {
    try {
      // 直接传字符串：见上方 REF_PATTERN 的注释，brand 是编译期的。
      const hit = await credentials.resolve(apiKeyEnv)
      const value = text(hit?.value)
      if (value !== undefined) return { value, source: typeof hit?.source === 'string' ? hit.source : 'store' }
    } catch {
      // 凭据服务不可用 → 回落环境变量，不抛出。
    }
  }
  const env = text(process.env[apiKeyEnv])
  return env === undefined ? undefined : { value: env, source: 'env' }
}

const STATIC_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-balance-monitor</title></head>
<body style="font:14px/1.6 system-ui;padding:24px">
<h1>dsh-balance-monitor</h1>
<p>本插件没有独立页面，它在「设置 → 模型」的每张供应商卡片里渲染，并在侧栏底部显示「余额 / 今日 / 峰谷倒计时」。</p>
<p>调试接口：<code>GET ${ROUTE_PREFIX}/state</code>、<code>GET ${ROUTE_PREFIX}/sidebar</code></p>
<ul>
  <li><code>POST ${ROUTE_PREFIX}/type</code> { provider, type }</li>
  <li><code>POST ${ROUTE_PREFIX}/refresh</code> { provider? }</li>
  <li><code>POST ${ROUTE_PREFIX}/vision/auto</code> { provider, enabled }</li>
  <li><code>POST ${ROUTE_PREFIX}/vision/apply</code> { provider? }（省略 provider = 全部补一遍）</li>
  <li><code>GET ${ROUTE_PREFIX}/sidebar</code>（侧栏：余额 / 今日 / 峰谷倒计时 / 价目状态）</li>
  <li><code>GET ${ROUTE_PREFIX}/report</code>（设置页「费用」：今日 / 本月 / 累计、今日会话、预算、额度、用量、价目）</li>
  <li><code>POST ${ROUTE_PREFIX}/config</code> { display?, budget?, retention?, peakNotify?, priceSources? }</li>
  <li><code>POST ${ROUTE_PREFIX}/balance/refresh</code>（强制刷新官方余额）</li>
  <li><code>GET ${ROUTE_PREFIX}/prices</code> / <code>POST ${ROUTE_PREFIX}/prices/update</code>（价目状态 / 联网更新）</li>
</ul>
</body></html>`

export function apply(ctx) {
  const { file, data } = loadStore()
  /** 探测结果只放内存：账号金额不落盘。 */
  const cache = new Map()
  const inflight = new Map()

  // ── 账本：调用记录（依据在入账时冻结，之后只加总，不重算历史） ──
  /** 当前生效的保留期（读的是同一份 `data`，所以改配置后不必重启就生效）。 */
  const retentionConfig = () => data.retention ?? DEFAULT_RETENTION
  const { file: ledgerFile, ledger, readFailed: ledgerReadFailed, missing: ledgerMissing, error: ledgerError } = loadLedger()
  pruneLedger(ledger, { keepDays: retentionConfig().ledgerDays })
  // 账本读不出来（截断 / 权限 / 被别的进程占用）时**必须出声**：否则它会以空账本启动，
  // 再把 days.json 当天的金额对齐成 0（下面 syncRollup 有守卫，但日志是第一道线索）。
  if (ledgerReadFailed && ledgerMissing !== true) {
    ctx.logger?.warn?.(`dsh-balance-monitor: 账本读取失败，按空账本启动（今天的明细会缺） ${ledgerError}`)
  }
  // ── 日汇总：账本只留最近几天，设置页的「本月 / 累计」靠这份小文件 ──
  const { file: rollupFile, rollup } = loadRollup()
  /**
   * 按当前保留期各裁一次并落盘。改小保留期时**立刻**生效 —— 否则旧记录要留到下次启动
   * 才消失，用户会以为没保存上。
   */
  const pruneNow = (atMs = Date.now()) => {
    const { ledgerDays, rollupDays } = retentionConfig()
    const droppedLedger = pruneLedger(ledger, { keepDays: ledgerDays, nowMs: atMs })
    const droppedRollup = pruneRollup(rollup, { date: dayKey(atMs), keepDays: rollupDays })
    if (droppedLedger > 0 || droppedRollup > 0) {
      ctx.logger?.warn?.(`dsh-balance-monitor: 保留期裁剪后写入 ${ledgerWriteResult(saveLedgerFiles())}`)
    }
    return { droppedLedger, droppedRollup }
  }
  /** 两个文件各写各的：一个失败不该连带另一个不写（days.json 是本/月/累计的唯一来源）。 */
  const saveLedgerFiles = () => {
    const failed = []
    try {
      saveStore(ledgerFile, ledger)
    } catch (error) {
      failed.push(`账本 ${String(error?.message ?? error)}`)
    }
    try {
      saveStore(rollupFile, rollup)
    } catch (error) {
      failed.push(`日汇总 ${String(error?.message ?? error)}`)
    }
    return failed
  }
  const ledgerWriteResult = failed => (failed.length === 0 ? '成功' : `失败（${failed.join('；')}）`)
  /**
   * 覆盖式对齐（启动 / 报表前调用一次，自愈用；O(当日记录数)）。
   *
   * **守卫**：账本当天一条都没有、而 days.json 当天有金额时**不覆盖**。账本空有两种可能 ——
   * 真的还没调用，或者账本文件坏了/被清了。后者若照覆盖，就把「本/月/累计」赖以生存的
   * 日汇总一起抹成 0（400 天的汇总数据一次性丢一天，且没有任何报错）。
   */
  const syncRollup = (atMs = Date.now()) => {
    const date = dayKey(atMs)
    const summary = summarizeDay(ledger, date)
    const known = rollup.days?.[date]
    if (summary.calls === 0 && known !== undefined && (known.calls ?? 0) > 0) return
    // 按模型明细与日汇总一起覆盖式对齐（同一条累加口径，见 usage-ledger 的 accumulateRow）
    applyRollupDay(rollup, date, summary, summarizeDayModels(ledger, date))
    if (pruneRollup(rollup, { date, keepDays: retentionConfig().rollupDays }) > 0) {
      // 裁剪后顺手落一次盘，避免文件无限增长
      try {
        saveStore(rollupFile, rollup)
      } catch {
        // 写入失败留到下次防抖再写
      }
    }
  }
  syncRollup()
  let ledgerTimer = null
  const scheduleLedgerWrite = () => {
    if (ledgerTimer !== null) return
    ledgerTimer = setTimeout(() => {
      ledgerTimer = null
      const failed = saveLedgerFiles()
      if (failed.length > 0) ctx.logger?.warn?.(`dsh-balance-monitor: 账本写入失败（${failed.join('；')}）`)
    }, LEDGER_WRITE_DEBOUNCE_MS)
    ledgerTimer.unref?.()
  }
  /**
   * 清空全部历史（破坏性）。
   *
   * **内存与磁盘一起清**：只删文件的话，插件内存里那份会在下一次防抖写入时把数据带回来；
   * 而 `ledger` / `rollup` 是 `const` 绑定（别处也持有同一个引用），所以只能原地清空，
   * 不能换新对象。
   */
  const clearHistory = () => {
    const ledgerDates = Object.keys(ledger.days ?? {})
    const rollupDates = Object.keys(rollup.days ?? {})
    let records = 0
    let rollupUsd = 0
    for (const date of ledgerDates) {
      const day = ledger.days[date]
      records += Array.isArray(day?.records) ? day.records.length : 0
    }
    for (const date of rollupDates) {
      const value = Number(rollup.days[date]?.usd)
      if (Number.isFinite(value)) rollupUsd += value
    }
    for (const date of ledgerDates) delete ledger.days[date]
    for (const date of rollupDates) delete rollup.days[date]
    // 清完立刻落盘（顺带把防抖里待写的那次也取消掉，否则它会带着旧数据写一遍）
    const failed = flushLedger()
    return { ledgerDays: ledgerDates.length, records, rollupDays: rollupDates.length, rollupUsd, failed }
  }

  /** 立刻落盘（防抖窗口里的记录不能丢）。返回失败原因，供调用方决定怎么报。 */
  const flushLedger = () => {
    if (ledgerTimer !== null) clearTimeout(ledgerTimer)
    ledgerTimer = null
    return saveLedgerFiles()
  }
  // 卸载前最终落盘（防抖窗口里剩的记录不能丢）。
  ctx.effect(() => () => {
    const failed = flushLedger()
    if (failed.length > 0) ctx.logger?.warn?.(`dsh-balance-monitor: 退出前账本落盘失败（${failed.join('；')}）`)
  }, 'balance-monitor: ledger flush')
  // 防抖定时器是 `unref()` 的（不拖住宿主的退出），所以**硬退出**（kill / 宿主不 dispose 就退）
  // 会丢掉最后 ≤2s 的记录。这里挂一个同步兜底：`exit` 阶段只允许同步写，`saveStore` 正是同步的。
  const onProcessExit = () => {
    const failed = flushLedger()
    if (failed.length > 0) {
      // 退出路径不能抛：只能尽力写，写不进去也不能改变退出码
      try {
        process.stderr.write(`dsh-balance-monitor: 退出前账本落盘失败（${failed.join('；')}）\n`)
      } catch { /* 连 stderr 都没有就算了 */ }
    }
  }
  if (typeof process.once === 'function') {
    process.once('exit', onProcessExit)
    ctx.effect(() => () => { process.off?.('exit', onProcessExit) }, 'balance-monitor: exit flush')
  }

  const displayConfig = () => ({ ...DEFAULT_DISPLAY, ...(data.display ?? {}) })
  /**
   * 官方峰谷**生效配置**：`state.json` 里只存「与随包默认不同」的字段，这里把它们补全成
   * 完整结构再交给计价 / 展示 / 指纹。
   *
   * 为什么要补全：`applyRollupDay` 之类是覆盖式的，而 `phaseAt()` 拿到 `windows` 缺失时
   * 会判成「没有窗口」（永不判峰）、`holidayZoneAt()` 拿到 `weekendOffPeakFrom` 缺失时
   * 会判成「没有假期」—— 直接把半份配置传下去会静默改掉计价口径。
   *
   * 返回值**身份稳定**：按 `data.officialPeak` 的引用做缓存，只有 `/config` 换掉这个引用
   * 时才重建；`basisCache`（依据指纹缓存）靠这个身份判断要不要重算。
   */
  let peakConfigCache = { stored: undefined, value: DEFAULT_OFFICIAL_PEAK }
  const officialPeakConfig = () => {
    if (peakConfigCache.stored === data.officialPeak) return peakConfigCache.value
    const value = data.officialPeak === undefined
      ? DEFAULT_OFFICIAL_PEAK
      : normalizeOfficialPeak({ ...DEFAULT_OFFICIAL_PEAK, ...data.officialPeak }) ?? DEFAULT_OFFICIAL_PEAK
    peakConfigCache = { stored: data.officialPeak, value }
    return value
  }
  /** 站方价目状态：磁盘上没有就用随包快照（开箱即用）。 */
  const stationPrices = loadStationPrices()
  const stationMeta = () => stationPrices.meta ?? {
    origin: STATION_ATTRIBUTION,
    sourceUrl: STATION_PRICE_TABLE_META.sourceUrl,
    sourceKind: STATION_PRICE_TABLE_META.sourceKind,
    fetchedAt: STATION_PRICE_TABLE_META.fetchedAt,
    accepted: Object.keys(STATION_PRICE_TABLE).length,
    bundled: true,
  }
  // 生效价表要合并「基表 + 站方目录」。合并会造一个新对象，而它在每次记账、每次轮询
  // 都要用（定价 + 指纹 + 来源统计），所以按输入身份缓存：基表/站方数据一变就重建。
  let tableCache = { base: null, station: null, value: null }
  const priceTableConfig = () => {
    const base = data.priceTable ?? DEFAULT_PRICE_TABLE
    const station = stationPrices.models ?? STATION_PRICE_TABLE
    if (tableCache.base === base && tableCache.station === station) return tableCache.value
    tableCache = { base, station, value: mergeStationTable(base, station) }
    return tableCache.value
  }
  /** 允许参与计价的来源等级（默认 official + station + manual，见 lib/pricing.js）。 */
  const priceSourcesConfig = () => (Array.isArray(data.priceSources) && data.priceSources.length > 0
    ? data.priceSources
    : DEFAULT_PRICE_SOURCES)
  /** 预算配置（未设置时给默认值，界面直接可编辑）。 */
  const budgetConfig = () => ({ enabled: false, amount: null, period: 'month', ...(data.budget ?? {}) })
  /** 峰谷提醒（开关 / 系统通知 / 提前量 / 提醒哪一侧 / 弹窗位置），随状态与报表一起下发。 */
  const peakNotifyConfig = () => ({ ...PEAK_NOTIFY_DEFAULTS, ...(data.peakNotify ?? {}) })
  /**
   * 密钥扫描配置（设置页「显示」可编辑）：凭据文件扫描开关 + 候选名前缀 + 序号上限。
   * 与 `budgetConfig` 同一套做法 —— 都给默认值，界面拿到的就是可直接编辑的形状。
   */
  const keyDiscoveryConfig = () => ({
    scanCredentialsFile: data.scanCredentialsFile !== false,
    prefixes: normalizeKeyPrefixes(data.deepseekKeyPrefixes) ?? DEFAULT_KEY_PREFIXES,
    maxIndex: data.deepseekKeyMaxIndex ?? DEFAULT_KEY_MAX_INDEX,
  })
  /**
   * Host 白名单（额外放行的主机名，小写；空数组 = 只允许回环）。
   * 它是 `hostGuard` 的逃生门：反代 / 自定义域名 / 局域网访问的部署把主机名写进来。
   */
  const allowedHostsConfig = () => (Array.isArray(data.allowedHosts) ? data.allowedHosts : [])
  /**
   * 界面偏好（生效值 = 默认值 + `state.json` 里存的那几个差异字段）。
   * 随 `/state`、`/sidebar`、`/report` 三处一起下发，客户端三块 UI 共用同一份。
   */
  const uiConfig = () => ({ ...UI_DEFAULTS, ...(data.ui ?? {}) })
  /** 侧栏模型花费卡片的生效配置（默认值 + `state.json` 里的差异字段）。 */
  const modelCardConfig = () => ({ ...MODEL_CARD_DEFAULTS, ...(data.modelCard ?? {}) })
  /** 会话三块的生效配置（输入区那三个槽位读的就是它）。 */
  const sessionCostConfig = () => ({ ...SESSION_COST_DEFAULTS, ...(data.sessionCost ?? {}) })
  const quotaStripConfig = () => ({ ...QUOTA_STRIP_DEFAULTS, ...(data.quotaStrip ?? {}) })
  const cornerConfig = () => ({ ...CORNER_DEFAULTS, ...(data.corner ?? {}) })
  /**
   * 官方峰谷相位 → 侧栏与报表共用的展示块。
   * `upcoming` 是接下来 6 个切换点（`lib/pricing.js` 的 `upcomingSwitches`），
   * 给侧栏「峰谷表」一键预览用；禁用峰谷时相位是 null，这块也整体为 null。
   */
  const peakBlock = (phase, atMs) => phase === null ? null : {
    enabled: true,
    inPeak: phase.inPeak,
    zoneKind: phase.zoneKind,
    prevAtMs: phase.prevAtMs,
    nextAtMs: phase.nextAtMs,
    nextIntoPeak: phase.nextIntoPeak,
    upcoming: upcomingSwitches(atMs, { limit: 6, config: officialPeakConfig() }),
  }
  /**
   * 一条 API Key 路线要查哪些凭据引用。
   * 配置里没写 → 退回该路线自己的 `apiKeyEnv`（旧行为）；写了 → 按配置（可按 route 限定）。
   */
  const deepseekKeyRefs = row => {
    const configured = normalizeDeepseekKeys(data.deepseekKeys) ?? []
    const list = configured
      .filter(entry => entry.route === undefined || entry.route === row.provider)
      .map(entry => ({ ref: entry.ref, label: entry.label ?? deriveKeyLabel(entry.ref) }))
    if (list.length === 0 && typeof row.apiKeyEnv === 'string' && row.apiKeyEnv.length > 0) {
      list.push({ ref: row.apiKeyEnv, label: deriveKeyLabel(row.apiKeyEnv) })
    }
    return disambiguateKeyLabels(list)
  }
  /**
   * 探测**有哪些 DeepSeek key 引用存在**（方案 A：候选名逐个 `describe`）。
   *
   * 只调 `credentials.describe(ref)`：返回 `{ configured, source, writable }`，**不含值**。
   * 宿主没有枚举 refs 的公开接口（`listRecords()` 只管 `records:` 段），所以只能按候选名探。
   */
  const discoverKeyRefs = async row => {
    const service = ctx.get('credentials')
    const configured = (normalizeDeepseekKeys(data.deepseekKeys) ?? []).map(entry => entry.ref)
    if (service === undefined || typeof service.describe !== 'function') {
      return { supported: false, scanned: [], found: [], missing: [], added: configured, candidates: [] }
    }
    const patternCandidates = keyRefCandidates({
      apiKeyEnv: row?.apiKeyEnv ?? null,
      prefixes: normalizeKeyPrefixes(data.deepseekKeyPrefixes) ?? DEFAULT_KEY_PREFIXES,
      maxIndex: data.deepseekKeyMaxIndex ?? DEFAULT_KEY_MAX_INDEX,
    })
    // 方案 B：直接读凭据文件的 refs 段**只取键名** —— 命名再怪也列得全。
    // 关掉（scanCredentialsFile: false）就只按候选名探测。
    const fileScan = data.scanCredentialsFile === false
      ? { ok: false, file: null, names: [], disabled: true }
      : readRefNames(join(dshHome(), '.credentials.yaml'))
    const candidates = [...new Set([...patternCandidates, ...fileScan.names.filter(name => REF_NAME_PATTERN.test(name))])]
    const results = await Promise.all(candidates.map(async ref => {
      try {
        const info = await service.describe(ref)
        return { ref, configured: info?.configured === true, source: typeof info?.source === 'string' ? info.source : null }
      } catch {
        // 单个引用探测失败不能拖垮整轮（凭据服务可能正在重载）
        return { ref, configured: false, source: null }
      }
    }))
    const found = results.filter(item => item.configured).map(item => ({ ref: item.ref, source: item.source }))
    return {
      supported: true,
      scanned: candidates,
      // 关掉文件扫描时这几个字段干脆不出现（别让界面误以为是「扫了但没结果」）
      ...(fileScan.disabled === true ? {} : {
        scannedFromFile: fileScan.names,
        credentialsFile: fileScan.ok === true ? fileScan.file : null,
        ...(fileScan.ok === true ? {} : { fileScanError: fileScan.error }),
      }),
      found,
      foundRefs: found.map(item => item.ref),
      /** 已列入总额的引用（配置里的那些） */
      added: configured,
      /** 探测到但还没计入总额的 → 界面下拉里该显示这些 */
      candidates: found.map(item => item.ref).filter(ref => !configured.includes(ref)),
    }
  }
  /** 当前生效价表的来源分布（按条目数），同一张表只算一次。 */
  let breakdownCache = { table: null, value: null }
  const sourceBreakdown = () => {
    const table = priceTableConfig()
    if (breakdownCache.table === table) return breakdownCache.value
    const counts = { official: 0, station: 0, manual: 0, reseller: 0, aggregator: 0, unknown: 0 }
    const count = catalog => {
      if (catalog === null || typeof catalog !== 'object') return
      for (const entry of Object.values(catalog)) counts[entrySource(entry)] += 1
    }
    count(table.models)
    for (const catalog of Object.values(table.providers ?? {})) count(catalog)
    breakdownCache = { table, value: counts }
    return counts
  }
  /** 当前计价依据的指纹：价表 + 官方峰谷 + 币种/汇率（只用于标注记录，不触发重算）。 */
  /** 指纹缓存（键是价表身份 + 来源清单 + 峰谷配置身份 + 汇率/币种）。 */
  let basisCache = { table: null, sources: null, peak: null, exchangeRate: null, currency: null, value: null }
  const currentBasisId = () => {
    const display = displayConfig()
    const table = priceTableConfig()
    const sources = priceSourcesConfig()
    const peak = officialPeakConfig()
    const sourcesKey = sources.join('\u0000')
    // 指纹要把整张表（几百 KB）序列化一遍，所以按「输入身份 + 关键标量」缓存：
    // 之前每次记账、每次轮询都要重算（实测 ~2.4 ms/次），纯属浪费。
    if (basisCache.table === table && basisCache.sources === sourcesKey && basisCache.peak === peak
      && basisCache.exchangeRate === display.exchangeRate && basisCache.currency === display.currency) {
      return basisCache.value
    }
    const value = pricingFingerprint({
      priceTable: table,
      priceSources: sources,
      officialPeak: peak,
      exchangeRate: display.exchangeRate,
      pricingCurrency: display.currency,
    })
    basisCache = { table, sources: sourcesKey, peak, exchangeRate: display.exchangeRate, currency: display.currency, value }
    return value
  }

  /**
   * 计费回调：把一次调用按**调用时刻**的档位算成钱并落账。
   *
   * 两条不猜的原则：
   *   - 中转站的倍率来自探测缓存，没探到就**不按 1 算**：记 token、金额留 null，界面显示 `—`；
   *   - 官方路由（deepseek-official）没有站方倍率，只有官方价 + 官方峰谷档。
   */
  const deduper = createUsageDeduper()
  /**
   * 记账。第 6 个参数是宿主给的整份调用选项 —— 「本会话费用」要按父会话 id 归属子代理调用，
   * 而那个字段宿主不一定给（老宿主 / 不给就只统计本会话，见 `/session` 的 `subagentSupported`）。
   */
  const account = (usage, model, sessionId, atMs, provider, extra = null) => {
    const buckets = usageBuckets(usage)
    if (buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite + buckets.reasoning === 0) return
    if (!deduper.admit(sessionId, model, buckets, atMs)) return
    const providerId = typeof provider === 'string' && provider.length > 0 ? provider : 'deepseek-official'
    const cached = cache.get(providerId)?.sub2api
    const snapshot = cached === undefined ? null : {
      billing: cached.billing ?? null,
      models: Array.isArray(cached.models) ? cached.models : [],
    }
    // 两条 DeepSeek 路线都是官方直连：没有站方倍率（account 路线也不该被当成中转站）。
    const multiplierKnown = OFFICIAL_PROVIDERS.has(providerId) || snapshot?.billing != null
    const resolved = resolveTier({
      provider: providerId,
      model,
      atMs,
      snapshot,
      priceTable: priceTableConfig(),
      allowSources: priceSourcesConfig(),
      officialPeak: officialPeakConfig(),
    })
    const record = makeCallRecord({
      atMs,
      provider: providerId,
      model,
      sessionId,
      // 子代理归属：宿主在调用选项里给什么就用什么（`parentSessionId` / `parent` 都认）
      parentSessionId: text(extra?.parentSessionId) ?? text(extra?.parent) ?? null,
      buckets,
      resolved: multiplierKnown ? resolved : { ...resolved, tier: null },
      basisId: currentBasisId(),
      exchangeRate: displayConfig().exchangeRate,
    })
    if (appendRecord(ledger, record)) {
      // 增量累加当日汇总（O(1)）；覆盖式对齐留给启动与 /report
      addRecordToRollupDay(rollup, dayKey(atMs), record)
    }
    scheduleLedgerWrite()
  }

  // 包裹 llm/stream：链尾监听者，只透传数据块并在流结束时记账。
  // 宿主没有这条事件（老宿主 / 测试桩）时静默降级为「只探测不记账」。
  if (typeof ctx.on === 'function') {
    ctx.on('llm/stream', createLlmStreamBilling({ account }), { global: true })
  }

  // ── DeepSeek 余额：两条路线各查一份（登录账号后是两个供应商、两份钱） ──
  /** provider → { at, value }；官方接口代价低，但仍按 60s 复用。 */
  const balanceCache = new Map()
  const balanceFields = balance => ({
    amount: balance.total ?? null,
    currency: balance.currency ?? null,
    isAvailable: balance.isAvailable === true,
    granted: balance.granted ?? null,
    toppedUp: balance.toppedUp ?? null,
    source: balance.source ?? null,
  })
  /** 查一条路线（不写缓存）。 */
  const queryOneBalance = async row => {
    const base = {
      provider: row.provider,
      displayName: row.displayName,
      kind: row.deepseekRoute ?? null,
      updatedAt: new Date().toISOString(),
    }
    if (row.deepseekRoute === 'account') {
      // 账号路线没有 API Key：token 由宿主的 deepseekAccount 服务解析（只有宿主能拿到）。
      const service = ctx.get('deepseekAccount')
      if (service === undefined || typeof service.resolveToken !== 'function') {
        return { ...base, error: '宿主没有 deepseekAccount 服务，账号余额不可查' }
      }
      let token
      try {
        token = await service.resolveToken(row.baseURL ?? 'https://api.deepseek.com')
      } catch (error) {
        return { ...base, error: `账号 token 解析失败：${String(error?.message ?? error)}` }
      }
      if (typeof token !== 'string' || token.trim().length === 0) {
        return { ...base, error: '未登录 DeepSeek 账号' }
      }
      const result = await queryDeepSeekAccountBalance({ token })
      return result.ok === true ? { ...base, ...balanceFields(result.balance) } : { ...base, error: result.error }
    }
    // API Key 路线：**可以配多把 key**（多张凭据引用）→ 逐把查、总额相加、明细逐条带出去。
    // 宿主自己的 DeepSeek 适配器只认一把（`apiKeyEnv` 是单值），所以多 key 由本插件的
    // `deepseekKeys` 配置表达：默认 [该路线的 apiKeyEnv]。
    const refs = deepseekKeyRefs(row)
    const keys = []
    for (const entry of refs) {
      const credential = await resolveApiKey(ctx, entry.ref)
      if (credential === undefined) {
        keys.push({ ref: entry.ref, label: entry.label ?? entry.ref, error: '未找到该引用的 Key' })
        continue
      }
      const result = await queryDeepSeekBalance(row.baseURL, credential.value)
      keys.push(result.ok === true
        ? { ref: entry.ref, label: entry.label ?? entry.ref, ...balanceFields(result.balance) }
        : { ref: entry.ref, label: entry.label ?? entry.ref, error: result.error })
    }
    const priced = keys.filter(item => typeof item.amount === 'number')
    if (keys.length === 1) {
      // 单把 key：保持和以前一样的形状（amount/currency/… 直接挂在路线上）
      return priced.length === 1 ? { ...base, ...keys[0], ref: keys[0].ref, keys } : { ...base, ...keys[0], keys }
    }
    const currency = priced[0]?.currency ?? null
    const sameCurrency = priced.every(item => (item.currency ?? null) === currency)
    const sum = priced.reduce((total, item) => total + item.amount, 0)
    return {
      ...base,
      // 多把 key：金额是**全部相加**；币种不一致时不给总额（避免把不同币种直接相加）
      amount: priced.length === 0 || !sameCurrency ? null : Number(sum.toFixed(6)),
      currency: sameCurrency ? currency : null,
      isAvailable: priced.length > 0 && priced.every(item => item.isAvailable !== false),
      granted: sameCurrency && priced.every(item => typeof item.granted === 'number')
        ? Number(priced.reduce((total, item) => total + (item.granted ?? 0), 0).toFixed(6))
        : null,
      toppedUp: sameCurrency && priced.every(item => typeof item.toppedUp === 'number')
        ? Number(priced.reduce((total, item) => total + (item.toppedUp ?? 0), 0).toFixed(6))
        : null,
      source: priced[0]?.source ?? null,
      error: priced.length === 0 ? keys.map(item => `${item.label}：${item.error}`).join('；') : undefined,
      mixedCurrency: !sameCurrency,
      keys,
    }
  }
  /**
   * 刷新并返回**全部**官方路线的余额（顺序固定为 DEEPSEEK_ROUTES，界面切换才稳定）。
   * @param {{ force?: boolean, provider?: string }} [options]
   */
  const refreshBalances = async ({ force = false, provider } = {}) => {
    const rows = collectProviders(ctx).filter(row => OFFICIAL_PROVIDERS.has(row.provider))
    for (const row of rows) {
      const cached = balanceCache.get(row.provider)
      if (!force && provider !== row.provider && cached !== undefined && Date.now() - cached.at < BALANCE_CACHE_MS) continue
      if (provider !== undefined && provider !== row.provider) continue
      balanceCache.set(row.provider, { at: Date.now(), value: await queryOneBalance(row) })
    }
    return rows.map(row => balanceCache.get(row.provider)?.value ?? {
      provider: row.provider,
      displayName: row.displayName,
      kind: row.deepseekRoute ?? null,
      error: '尚未查询',
    })
  }
  /** 侧栏「余额」行默认显示哪一条：账号路线优先（成功且有金额），否则第一条成功的。 */
  const pickPrimaryBalance = list => list.find(item => item.kind === 'account' && typeof item.amount === 'number' && item.error === undefined)
    ?? list.find(item => typeof item.amount === 'number' && item.error === undefined)
    ?? list[0]
    ?? null

  /**
   * 这条路线现在有哪些 key（引用名 + 配没配）以及下一个可用空位。
   * 只回「有/没有」，**不回值** —— 界面据此画密钥行。
   */
  const describeKeys = async row => {
    const credentials = ctx.get('credentials')
    const managed = normalizeDeepseekKeys(data.deepseekKeys) ?? []
    const patternCandidates = keyRefCandidates({
      apiKeyEnv: row.apiKeyEnv ?? null,
      prefixes: normalizeKeyPrefixes(data.deepseekKeyPrefixes) ?? DEFAULT_KEY_PREFIXES,
      maxIndex: data.deepseekKeyMaxIndex ?? DEFAULT_KEY_MAX_INDEX,
    })
    const fileRefs = data.scanCredentialsFile === false ? [] : readRefNames(join(dshHome(), '.credentials.yaml')).names
    // 行 = 候选扫描名 ∪ 凭据文件里的键名 ∪ 已纳入本插件配置的引用
    const candidates = [...new Set([...patternCandidates, ...fileRefs])]
    const refs = [...new Set([...candidates, ...managed.map(entry => entry.ref)])]
    const keys = []
    for (const ref of refs) {
      let present = false
      if (credentials !== undefined && typeof credentials.describe === 'function') {
        try { present = (await credentials.describe(ref))?.configured === true } catch { present = false }
      }
      // 界面只列「有配置的」+「本插件纳入的」，其余候选名不显示（否则一屏空行）
      if (!present && !managed.some(entry => entry.ref === ref)) continue
      keys.push({
        ref,
        label: managed.find(entry => entry.ref === ref)?.label ?? deriveKeyLabel(ref),
        configured: present,
        managed: managed.some(entry => entry.ref === ref),
        primary: ref === row.apiKeyEnv,
      })
    }
    const taken = new Set(keys.filter(item => item.configured).map(item => item.ref))
    return {
      provider: row.provider,
      primaryRef: typeof row.apiKeyEnv === 'string' ? row.apiKeyEnv : null,
      keys: disambiguateKeyLabels(keys),
      scanned: candidates.length,
      /** 添加新 key 时顺位用的引用名 */
      nextRef: candidates.find(ref => !taken.has(ref)) ?? null,
    }
  }
  /** 侧栏触发的探测节流：侧栏是常驻轮询，别让它把探测节奏带起来。 */
  let sidebarProbedAt = 0

  /**
   * 拉一次「站方口径价目」并落盘（对应界面上的「更新价格表」按钮）。
   *
   * 数据源是 LiteLLM 的价目文件（Sub2Api 自己就用它算钱，见 lib/litellm-prices.js 的说明），
   * 抓取链：LiteLLM raw → sub2api price-mirror → GitHub API blobs → 仓库内副本。
   * 更新**只影响之后的调用**（依据变更不重算历史），并按新指纹继续记账。
   */
  let priceUpdating = null
  const updateStationPrices = async () => {
    if (priceUpdating !== null) return priceUpdating
    priceUpdating = (async () => {
      const fetched = await fetchStationPrices({})
      if (fetched.ok !== true) {
        return { ok: false, error: `抓取失败：${fetched.errors.slice(0, 3).join('；')}` }
      }
      let parsed = null
      try {
        parsed = JSON.parse(fetched.text)
      } catch {
        return { ok: false, error: '价目数据不是有效 JSON' }
      }
      const { models, stats } = parseStationPrices(parsed, {
        sourceUrl: fetched.sourceUrl,
        checkedAt: new Date().toISOString().slice(0, 10),
      })
      const accepted = Object.keys(models).length
      if (accepted === 0) return { ok: false, error: '价目里没有可用的自营厂商条目' }
      const meta = {
        origin: STATION_ATTRIBUTION,
        sourceUrl: fetched.sourceUrl,
        sourceKind: fetched.kind,
        fetchedAt: new Date().toISOString(),
        ...stats,
      }
      try {
        saveStore(stationPrices.file, { version: 1, meta, models })
      } catch (error) {
        return { ok: false, error: `写入价目失败：${String(error?.message ?? error)}` }
      }
      stationPrices.models = models
      stationPrices.meta = meta
      ctx.logger?.info?.(`dsh-balance-monitor: 价目已更新 ${accepted} 条（${fetched.kind}）`)
      return { ok: true, meta }
    })().finally(() => { priceUpdating = null })
    return priceUpdating
  }

  const writeStore = () => {
    try {
      saveStore(file, data)
      return true
    } catch (error) {
      ctx.logger?.warn?.(`dsh-balance-monitor: 保存类型失败 ${String(error?.message ?? error)}`)
      return false
    }
  }

  const typeOf = provider => data.types[provider] ?? DEFAULT_PROVIDER_TYPE

  /** 自动补图片开关：只有显式关掉才 false。 */
  const autoImageOf = provider => data.autoImage[provider] !== false

  /** 最近一次成功探测的时间；`buildState` 会读它，所以先声明。 */
  let lastProbedAt
  /** 最近一次「补图片」的结果与时间（自动 / 手动共用一份记录）。 */
  let visionApplied = []
  let visionAt
  let visionError
  let visionFailedAt = 0
  /** 正在跑的补全任务：GET /state 可能并发进来，复用一个 Promise。 */
  let visionInflight = null

  const stateOf = providerId => {
    const entry = cache.get(providerId)
    if (entry === undefined) return { status: 'idle' }
    return entry
  }

  const imageOf = row => {
    // 官方 `llm-deepseek` 路由的模型出自它自己的 catalog（`inputModalities` 那套），
    // 不归本插件的补全逻辑管，所以标成不可编辑，客户端据此隐藏控件。
    if (row.settingsNs !== VISION_SETTINGS_NS) {
      return { editable: false, auto: false, total: 0, declared: 0, missing: 0, explicitText: 0 }
    }
    const models = Array.isArray(row.models) ? row.models : []
    return {
      editable: true,
      auto: autoImageOf(row.provider),
      total: models.length,
      declared: models.filter(model => model.image === 'yes').length,
      missing: models.filter(model => model.image !== 'yes').length,
      explicitText: models.filter(model => model.image === 'explicit-text').length,
    }
  }

  const buildState = () => {
    const providers = collectProviders(ctx).map(row => {
      const type = typeOf(row.provider)
      const cached = stateOf(row.provider)
      return {
        provider: row.provider,
        displayName: row.displayName,
        settingsNs: row.settingsNs,
        // deepseek-official / deepseek-account（界面据此区分两条官方路线）
        ...(row.deepseekRoute === undefined ? {} : { deepseekRoute: row.deepseekRoute }),
        baseURL: row.baseURL,
        apiKeyEnv: row.apiKeyEnv,
        api: row.api,
        configuredModels: row.modelCount,
        type,
        image: imageOf(row),
        // 只暴露「有没有 key」这个事实：key 本身既不落盘也不出网以外的任何地方。
        // 未探测过时是 undefined（未知），不是 false。
        hasKey: cached.keyPresent,
        status: cached.status ?? 'idle',
        error: cached.error,
        updatedAt: cached.updatedAt,
        sub2api: cached.sub2api,
      }
    })
    return {
      version: STATE_VERSION,
      providers,
      types: { ...data.types },
      vision: { applied: visionApplied, at: visionAt, error: visionError },
      probedAt: lastProbedAt,
      // 界面偏好随状态一起给（卡片按它决定语言与是否隐藏敏感区块）
      ui: uiConfig(),
    }
  }

  /**
   * 把若干供应商的模态缺口写回 profile patch。
   *
   * 写路径是宿主 `settings` 服务（`@deepseek-ai/dsh-settings`）的
   * `mutate(ns, ops, expectedRevision)` —— 和内置「设置 → 模型」页保存供应商走的是同一条：
   * 校验路径落在 volatile 节点下、按修订号拒绝过期写入、经 `config-editor` 原子替换
   * profile patch 并交给 Loader 热重载（注释和 `!!js` 表达式都会保留）。
   * 我们自己直接改 YAML 就没这些保障，所以宁可依赖这个服务；它不在时如实报错。
   *
   * 计划（哪些模型缺）和修订号**取自同一份快照**：否则「计划用旧快照、修订号用新快照」
   * 会绕过并发保护，把旧下标写到新布局上。
   *
   * @param {Array<{ provider: string, force: boolean }>} requests
   */
  const writeVision = async requests => {
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.mutate !== 'function') {
      return {
        ok: false,
        error: '宿主 settings 服务不支持写入（需要 @deepseek-ai/dsh-settings + @deepseek-ai/dsh-config-editor）',
        applied: [],
      }
    }
    const section = readSettings(ctx).get(VISION_SETTINGS_NS)
    const providers = section?.value?.providers
    const planned = requests
      .map(({ provider, force }) => ({
        provider,
        ...planVisionOps(provider, readModels(providers?.[provider]), { force }),
      }))
      .filter(item => item.ops.length > 0)
    if (planned.length === 0) return { ok: true, applied: [] }

    const ops = planned.flatMap(item => item.ops)
    try {
      await settings.mutate(VISION_SETTINGS_NS, ops, section?.revision)
    } catch (error) {
      // 读到写之间配置被别处改了（含内置设置页保存）→ 重读修订号重试一次。
      if (error?.code !== 'SETTINGS_CONFLICT') throw error
      await settings.mutate(VISION_SETTINGS_NS, ops, readSettings(ctx).get(VISION_SETTINGS_NS)?.revision)
    }
    return { ok: true, applied: planned.map(item => ({ provider: item.provider, models: item.models.map(model => model.id) })) }
  }

  /**
   * 自动补图片：给还没声明过模态的模型补 `input: [text, image]`。
   * `force=false`（GET /state 走这条）尊重用户显式勾的纯文本；`force=true`（手动按钮）连它一起补。
   * 失败只记录不抛：探测/写配置的故障不该让状态接口挂掉。
   */
  const sweepVision = async ({ force = false, provider } = {}) => {
    if (visionInflight !== null) return visionInflight
    const task = (async () => {
      if (!force && Date.now() - visionFailedAt < VISION_RETRY_MS) return { ok: true, applied: [] }
      const requests = collectProviders(ctx)
        .filter(row => row.settingsNs === VISION_SETTINGS_NS && (provider === undefined || row.provider === provider))
        .filter(row => force || autoImageOf(row.provider))
        .filter(row => planVisionOps(row.provider, row.models, { force }).ops.length > 0)
        .map(row => ({ provider: row.provider, force }))
      if (requests.length === 0) return { ok: true, applied: [] }
      try {
        const result = await writeVision(requests)
        visionApplied = result.applied
        visionAt = new Date().toISOString()
        visionError = result.ok ? undefined : result.error
        return result
      } catch (error) {
        const message = String(error?.message ?? error)
        visionError = message
        if (!force) visionFailedAt = Date.now()
        return { ok: false, error: message, applied: [] }
      }
    })().finally(() => { visionInflight = null })
    visionInflight = task
    return task
  }

  /** 探测一个供应商；同一 provider 并发调用复用同一个 Promise。 */
  const refreshOne = async (row, { withModels = true } = {}) => {
    const running = inflight.get(row.provider)
    if (running !== undefined) return running
    const task = (async () => {
      if (typeOf(row.provider) !== 'sub2api') {
        cache.set(row.provider, { status: 'idle' })
        return
      }
      const credential = await resolveApiKey(ctx, row.apiKeyEnv)
      const keyPresent = credential !== undefined
      if (!keyPresent) {
        cache.set(row.provider, { status: 'error', error: '未找到 API Key（凭据或环境变量）', keyPresent, updatedAt: new Date().toISOString() })
        return
      }
      if (row.baseURL === undefined) {
        cache.set(row.provider, { status: 'error', error: '该供应商未配置 baseURL', keyPresent, updatedAt: new Date().toISOString() })
        return
      }
      const probe = await probeSub2Api(row.baseURL, credential.value, { withModels, timeoutMs: 15000 })
      if (!probe.ok) {
        cache.set(row.provider, { status: 'error', error: describeProbeError(probe), keyPresent, updatedAt: new Date().toISOString() })
        return
      }
      const usage = probe.usage ?? {}
      cache.set(row.provider, {
        status: 'ok',
        keyPresent,
        updatedAt: new Date().toISOString(),
        sub2api: {
          root: probe.root,
          // 原始 parsed billing（camelCase，含 peak 分解）：计价用 lib/pricing.js 的
          // resolveProviderRate()，需要 userRate/resolvedRate/groupRate/effectiveRate 这套字段。
          billing: probe.billing,
          mode: usage.mode,
          planName: usage.planName,
          unit: usage.unit,
          balance: usage.balance,
          quota: usage.quota,
          rateLimits: usage.rateLimits,
          subscription: usage.subscription,
          expiresAt: usage.expiresAt,
          daysUntilExpiry: usage.daysUntilExpiry,
          models: probe.models,
          modelCount: probe.models.length,
          rate: probe.billing
            ? {
                scope: probe.billing.scope,
                group: probe.billing.groupRate,
                user: probe.billing.userRate,
                resolved: probe.billing.resolvedRate,
                effective: probe.billing.effectiveRate,
                peak: probe.billing.peak,
                observedAt: probe.billing.observedAt,
              }
            : undefined,
          spend: probe.spend,
        },
      })
      lastProbedAt = new Date().toISOString()
    })().finally(() => inflight.delete(row.provider))
    inflight.set(row.provider, task)
    return task
  }

  const findRow = provider => collectProviders(ctx).find(row => row.provider === provider)

  const refresh = async ({ provider, withModels = true, force = true } = {}) => {
    const rows = collectProviders(ctx)
    const targets = provider !== undefined ? rows.filter(row => row.provider === provider) : rows
    for (const row of targets) {
      if (!force) {
        const cached = cache.get(row.provider)
        const at = cached?.updatedAt === undefined ? 0 : Date.parse(cached.updatedAt)
        if (Date.now() - at < CACHE_MS) continue
      }
      await refreshOne(row, { withModels })
    }
    return buildState()
  }

  // ── 同源路由：浏览器跨域取不到中转站接口，所有出网请求都在宿主侧做 ──
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const tail = url.pathname.slice(ROUTE_PREFIX.length)

      // 状态变更一律先过跨站拦截面（任意网页的简单请求不该能删 key / 改类型 / 触发抓取）；
      // 所有方法（含 GET）先过 Host 白名单，挡 DNS rebinding。
      const hostBlock = hostGuard(req, allowedHostsConfig())
      if (hostBlock !== null) return sendJson(res, hostBlock.status, { ok: false, error: hostBlock.error })
      const guard = crossSiteGuard(req)
      if (guard !== null) return sendJson(res, guard.status, { ok: false, error: guard.error })

      if (tail === '' || tail === '/' || tail === '/index.html') {
        const body = Buffer.from(STATIC_PAGE, 'utf8')
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('content-length', String(body.length))
        res.end(body)
        return
      }

      if (tail === '/state') {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // 首次访问自动补一次探测（60s 内复用缓存），避免用户还得先点刷新。
        await refresh({ force: false })
        // 顺手补一次模态：卡片渲染时就把「新加的供应商」补齐，不用用户点任何按钮。
        await sweepVision()
        return sendJson(res, 200, { ok: true, state: buildState() })
      }

      if (tail === '/vision/auto') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined) return sendJson(res, 400, { ok: false, error: 'invalid json body' })
        const provider = text(body.provider)
        if (provider === undefined || findRow(provider) === undefined) {
          return sendJson(res, 404, { ok: false, error: `未知供应商 ${provider ?? ''}` })
        }
        if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' })
        data.autoImage[provider] = body.enabled
        if (!writeStore()) return sendJson(res, 500, { ok: false, error: '保存失败，详见宿主日志' })
        if (body.enabled) await sweepVision({ provider })
        return sendJson(res, 200, { ok: true, state: buildState() })
      }

      if (tail === '/vision/apply') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined) return sendJson(res, 400, { ok: false, error: 'invalid json body' })
        const provider = text(body.provider)
        if (provider !== undefined && findRow(provider) === undefined) {
          return sendJson(res, 404, { ok: false, error: `未知供应商 ${provider}` })
        }
        // 手动补：force 连「显式纯文本」的模型一起补（用户按下按钮就是明确要图片）。
        const result = await sweepVision({ force: true, provider })
        if (!result.ok) return sendJson(res, 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, state: buildState() })
      }

      if (tail === '/prices') {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendJson(res, 200, {
          ok: true,
          data: { meta: stationMeta(), sources: priceSourcesConfig(), attribution: STATION_ATTRIBUTION },
        })
      }

      if (tail === '/prices/update') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const result = await updateStationPrices()
        const meta = stationMeta()
        return result.ok === true
          ? sendJson(res, 200, { ok: true, data: { meta } })
          : sendJson(res, 502, { ok: false, error: result.error, data: { meta } })
      }

      if (tail === '/report') {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const now = Date.now()
        const date = dayKey(now)
        // 今日金额与侧栏同源：先把日汇总对齐（覆盖式写入，幂等）
        syncRollup(now)
        const phase = phaseAt(now, officialPeakConfig())
        const locale = String(req.headers?.['accept-language'] ?? '').toLowerCase().includes('en') ? 'en' : 'zh'
        const state = buildState()
        const balances = await refreshBalances()
        const meta = stationMeta()
        const report = buildReport({
          ledger,
          rollup,
          date,
          now,
          display: displayConfig(),
          budget: budgetConfig(),
          retention: retentionConfig(),
          notify: peakNotifyConfig(),
          providers: state.providers.map(row => ({ provider: row.provider, displayName: row.displayName })),
          quotas: state.providers,
          balance: pickPrimaryBalance(balances),
          balances,
          peak: peakBlock(phase, now),
          prices: {
            meta,
            sources: priceSourcesConfig(),
            breakdown: sourceBreakdown(),
            attribution: STATION_ATTRIBUTION,
            basisId: currentBasisId(),
          },
          locale,
        })
        // 有哪些 key 引用可加（候选名探测，只读 describe，不读值）。
        // 注意：这是 buildReport 之后补的字段 —— 写进它的入参会被忽略（它只认自己声明的键）。
        report.keyCandidates = await discoverKeyRefs(state.providers.find(row => row.provider === 'deepseek-official'))
        // 峰谷配置随报表下发：「显示」页要能编辑窗口 / 假期（同样是 buildReport 之后补的字段）。
        report.officialPeak = officialPeakConfig()
        // 密钥扫描配置同理：界面要能改「扫不扫凭据文件 / 候选前缀 / 序号上限」。
        report.keyDiscovery = keyDiscoveryConfig()
        // Host 白名单也下发：「显示 → 访问控制」要能看和改（反代部署必须能自己加）。
        report.allowedHosts = allowedHostsConfig()
        // 界面偏好：语言选择器、刷新间隔、隐藏区块、会话 ID 开关都在这块里。
        report.ui = uiConfig()
        // 模型花费卡片配置（「显示」页要能回填与编辑）。
        report.modelCard = modelCardConfig()
        // 会话三块（同上）
        report.sessionCost = sessionCostConfig()
        report.quotaStrip = quotaStripConfig()
        report.corner = cornerConfig()
        return sendJson(res, 200, { ok: true, data: report })
      }

      if (tail === '/config') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined) return sendJson(res, 400, { ok: false, error: 'invalid json body' })
        // 白名单式写入：只认 display / budget / retention / peakNotify / officialPeak /
        // priceSources / scanCredentialsFile / deepseekKeyPrefixes / deepseekKeyMaxIndex /
        // deepseekKeys 这几个键，别的一律忽略（避免把任意 JSON 灌进配置文件）。
        // `data` 是 apply 作用域里的同一份对象，改动后由 writeStore() 落盘。
        if (body.display !== null && typeof body.display === 'object' && !Array.isArray(body.display)) {
          const display = { ...(data.display ?? {}) }
          if (typeof body.display.currency === 'string' && /^[A-Za-z]{3}$/.test(body.display.currency)) display.currency = body.display.currency.toUpperCase()
          if (typeof body.display.symbol === 'string' && body.display.symbol.length > 0 && body.display.symbol.length <= 4) display.symbol = body.display.symbol
          if (Number.isFinite(Number(body.display.decimals))) display.decimals = Math.max(0, Math.min(8, Math.trunc(Number(body.display.decimals))))
          if (Number.isFinite(Number(body.display.exchangeRate)) && Number(body.display.exchangeRate) > 0) display.exchangeRate = Number(body.display.exchangeRate)
          data.display = display
        }
        if (body.budget !== null && typeof body.budget === 'object' && !Array.isArray(body.budget)) {
          const budget = { ...budgetConfig() }
          if (typeof body.budget.enabled === 'boolean') budget.enabled = body.budget.enabled
          const rawAmount = body.budget.amount
          if (rawAmount === null || rawAmount === undefined || rawAmount === '') budget.amount = null
          else if (Number.isFinite(Number(rawAmount)) && Number(rawAmount) >= 0) budget.amount = Number(rawAmount)
          if (['today', 'month', 'all'].includes(body.budget.period)) budget.period = body.budget.period
          data.budget = budget
        }
        if (Array.isArray(body.priceSources)) {
          const sources = body.priceSources.filter(source => PRICE_SOURCES.includes(source))
          data.priceSources = sources.length === 0 ? [...DEFAULT_PRICE_SOURCES] : sources
        }
        if (typeof body.scanCredentialsFile === 'boolean') {
          if (body.scanCredentialsFile === false) data.scanCredentialsFile = false
          else delete data.scanCredentialsFile
        }
        if (body.deepseekKeyPrefixes !== undefined) {
          const prefixes = normalizeKeyPrefixes(body.deepseekKeyPrefixes)
          if (prefixes === undefined) delete data.deepseekKeyPrefixes
          else data.deepseekKeyPrefixes = prefixes
        }
        if (body.deepseekKeyMaxIndex !== undefined) {
          const maxIndex = Number(body.deepseekKeyMaxIndex)
          if (Number.isFinite(maxIndex) && maxIndex >= 1 && maxIndex <= 50) data.deepseekKeyMaxIndex = Math.trunc(maxIndex)
          else delete data.deepseekKeyMaxIndex
        }
        if (body.deepseekKeys !== undefined) {
          // 空数组 = 清掉自定义列表，回到「用路线自己的 apiKeyEnv」
          const keys = normalizeDeepseekKeys(body.deepseekKeys)
          if (keys === undefined) delete data.deepseekKeys
          else data.deepseekKeys = keys
          // 引用列表变了：余额缓存作废
          balanceCache.clear()
        }
        let pruned = null
        if (body.retention !== undefined) {
          // `null` / `{}` / 两个键都不给 = 清掉自定义，回到默认（7 / 400）
          const retention = normalizeRetention(body.retention)
          if (retention === undefined) delete data.retention
          else data.retention = retention
        }
        if (body.peakNotify !== undefined) {
          // 局部覆盖（只改一个勾选框时不把另一个带掉）：与 display / budget 同一套合并规矩
          const patch = body.peakNotify
          if (patch === null || patch === undefined) {
            delete data.peakNotify
          } else if (typeof patch === 'object' && !Array.isArray(patch)) {
            // 局部覆盖：只改一个控件时不把别的位带掉（与 display / budget / ui 同一套合并规矩）。
            // 每一项都是「给的值合法就用它，否则**沿用当前生效值**」—— 非法值不该把这一项悄悄打回默认。
            const current = peakNotifyConfig()
            const lead = patch.leadMinutes === undefined ? current.leadMinutes : Number(patch.leadMinutes)
            const mergedLead = Number.isInteger(lead) && lead >= PEAK_LEAD_MIN && lead <= PEAK_LEAD_MAX ? lead : current.leadMinutes
            const next = normalizePeakNotify({
              enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
              system: typeof patch.system === 'boolean' ? patch.system : current.system,
              leadMinutes: mergedLead,
              // 没给 / 给的不合法 → 沿用当前生效值（非法值不该把这一项悄悄打回默认）。
              // `both` 是合法值（= 默认），只是归一后不落盘。
              type: patch.type === 'peak' || patch.type === 'off' || patch.type === 'both' ? patch.type : current.type,
              position: patch.position === 'center' || patch.position === 'corner' ? patch.position : current.position,
            })
            if (next === undefined) delete data.peakNotify
            else data.peakNotify = next
          }
        }
        if (body.modelCard !== undefined) {          // 局部补丁（界面每次只改一个控件）：给的值合法就用它，否则沿用当前生效值，
          // 最后只落与默认不同的字段 —— 与 `ui` 块完全同一套规矩。
          const patch = body.modelCard
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            delete data.modelCard
          } else {
            const current = modelCardConfig()
            const keepBool = key => (typeof patch[key] === 'boolean' ? patch[key] : current[key])
            const rows = patch.rows === undefined ? current.rows : Number(patch.rows)
            const merged = {
              enabled: keepBool('enabled'),
              defaultExpanded: keepBool('defaultExpanded'),
              rememberExpanded: keepBool('rememberExpanded'),
              showTokens: keepBool('showTokens'),
              showShare: keepBool('showShare'),
              period: patch.period === 'today' || patch.period === 'days90' ? patch.period : current.period,
              rows: Number.isInteger(rows) && rows >= 1 && rows <= MODEL_CARD_ROWS_MAX ? rows : current.rows,
              position: patch.position === 'bottom' || patch.position === 'top' ? patch.position : current.position,
            }
            const stored = diffFromDefaults(merged, MODEL_CARD_DEFAULTS)
            if (Object.keys(stored).length === 0) delete data.modelCard
            else data.modelCard = stored
          }
        }
        // 会话三块（本会话费用 / 额度横条 / 角标）：同一套局部补丁规矩
        for (const [key, defaults, currentOf] of [
          ['sessionCost', SESSION_COST_DEFAULTS, sessionCostConfig],
          ['quotaStrip', QUOTA_STRIP_DEFAULTS, quotaStripConfig],
          ['corner', CORNER_DEFAULTS, cornerConfig],
        ]) {
          if (body[key] === undefined) continue
          const patch = body[key]
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            delete data[key]
            continue
          }
          const stored = diffFromDefaults(mergeConversationBlock(patch, currentOf(), defaults), defaults)
          if (Object.keys(stored).length === 0) delete data[key]
          else data[key] = stored
        }
        if (body.officialPeak !== undefined) {
          // `null` / 非对象 = 清掉自定义，回到随包默认表。
          const patch = body.officialPeak
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            delete data.officialPeak
          } else {
            // 是对象 = 与**当前生效值**逐字段合并（没给的字段沿用现值，不是回默认）——
            // 局部补丁（比如只改假期）不会把「已关掉的峰谷」或自定义窗口带掉。
            const peak = normalizeOfficialPeak({ ...officialPeakConfig(), ...patch })
            if (peak === undefined) {
              delete data.officialPeak
            } else {
              // 与随包默认值相同的字段**不落盘**：否则用户在设置页点一次保存，就把当版
              // 假期表（和窗口）固化进 state.json，以后随包更新假期表在这台机器上永远不生效。
              const stored = {}
              if (peak.enabled !== DEFAULT_OFFICIAL_PEAK.enabled) stored.enabled = peak.enabled
              if (peak.effectiveAt !== DEFAULT_OFFICIAL_PEAK.effectiveAt) stored.effectiveAt = peak.effectiveAt
              if (peak.weekendOffPeakFrom !== DEFAULT_OFFICIAL_PEAK.weekendOffPeakFrom) stored.weekendOffPeakFrom = peak.weekendOffPeakFrom
              if (peak.legacyBoundary !== DEFAULT_OFFICIAL_PEAK.legacyBoundary) stored.legacyBoundary = peak.legacyBoundary
              if (JSON.stringify(peak.windows) !== JSON.stringify(DEFAULT_OFFICIAL_PEAK.windows)) stored.windows = peak.windows
              if (JSON.stringify(peak.holidays) !== JSON.stringify(DEFAULT_OFFICIAL_PEAK.holidays)) stored.holidays = peak.holidays
              if (Object.keys(stored).length === 0) delete data.officialPeak
              else data.officialPeak = stored
            }
          }
        }
        if (body.allowedHosts !== undefined) {
          // `null` / `[]` = 回到「只允许回环」
          const hosts = normalizeAllowedHosts(body.allowedHosts)
          if (hosts === undefined) delete data.allowedHosts
          else data.allowedHosts = hosts
        }
        if (body.ui !== undefined) {
          // 局部补丁（界面每次只改一个控件）：与当前生效值合并，非法值保持原值。
          const patch = body.ui
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            delete data.ui
          } else {
            const merged = { ...uiConfig(), ...normalizeUi(patch) }
            const stored = diffFromDefaults(merged)
            if (Object.keys(stored).length === 0) delete data.ui
            else data.ui = stored
          }
        }
        if (!writeStore()) return sendJson(res, 500, { ok: false, error: '保存失败，详见宿主日志' })
        if (body.retention !== undefined) {
          // 调小保留期要立刻见效：顺手裁一次并落盘（裁不掉东西就不写，省一次 IO）
          const { droppedLedger, droppedRollup } = pruneNow()
          if (droppedLedger > 0 || droppedRollup > 0) pruned = { droppedLedger, droppedRollup }
        }
        // 依据可能变了（来源等级 / 币种）：指纹随之变化，**之后**的调用按新依据记，历史不动
        return sendJson(res, 200, {
          ok: true,
          data: {
            display: displayConfig(),
            budget: budgetConfig(),
            retention: retentionConfig(),
            peakNotify: peakNotifyConfig(),
            officialPeak: officialPeakConfig(),
            keyDiscovery: keyDiscoveryConfig(),
            allowedHosts: allowedHostsConfig(),
            ui: uiConfig(),
            modelCard: modelCardConfig(),
            sessionCost: sessionCostConfig(),
            quotaStrip: quotaStripConfig(),
            corner: cornerConfig(),
            priceSources: priceSourcesConfig(),
            basisId: currentBasisId(),
            ...(pruned === null ? {} : { pruned }),
          },
        })
      }

      if (tail === '/balance/refresh') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined) return sendJson(res, 400, { ok: false, error: 'invalid json body' })
        const provider = text(body.provider)
        const balances = await refreshBalances({ force: true, ...(provider === undefined ? {} : { provider }) })
        return sendJson(res, 200, { ok: true, data: { balance: pickPrimaryBalance(balances), balances } })
      }

      if (tail === '/keys') {
        // 读：这条路线现在有哪些 key；写：新增/替换一把；删：移除一把（值不回传）
        const credentials = ctx.get('credentials')
        const providerParam = req.method === 'GET' ? text(url.searchParams.get('provider')) : undefined
        if (req.method === 'GET') {
          const row = providerParam === undefined ? undefined : findRow(providerParam)
          if (row === undefined || row.deepseekRoute === undefined) {
            return sendJson(res, 404, { ok: false, error: `未知的 DeepSeek 路线 ${providerParam ?? ''}` })
          }
          return sendJson(res, 200, { ok: true, data: await describeKeys(row) })
        }
        const body = await readJsonBody(req)
        if (body === undefined) return sendJson(res, 400, { ok: false, error: 'invalid json body' })
        const provider = text(body.provider)
        const row = provider === undefined ? undefined : findRow(provider)
        if (row === undefined || row.deepseekRoute === undefined) {
          return sendJson(res, 404, { ok: false, error: `未知的 DeepSeek 路线 ${provider ?? ''}` })
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const value = typeof body.value === 'string' ? body.value.trim() : ''
          if (value.length === 0) return sendJson(res, 400, { ok: false, error: 'key 不能为空' })
          if (credentials === undefined || typeof credentials.set !== 'function') {
            return sendJson(res, 500, { ok: false, error: '宿主凭据服务不支持写入（需要 credentials.set）' })
          }
          const requested = text(body.ref)
          const ref = requested ?? (await describeKeys(row)).nextRef
          if (ref === null || ref === undefined) return sendJson(res, 400, { ok: false, error: '没有可用的引用名（候选都占满了）' })
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return sendJson(res, 400, { ok: false, error: `引用名不合法：${ref}` })
          try {
            await credentials.set(ref, value)
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: `写入凭据失败：${String(error?.message ?? error)}` })
          }
          // 记进本插件配置，它才会被计入余额总额
          const existing = normalizeDeepseekKeys(data.deepseekKeys) ?? []
          if (!existing.some(entry => entry.ref === ref)) {
            data.deepseekKeys = [...existing, {
              ref,
              ...(typeof body.label === 'string' && body.label.trim().length > 0 ? { label: body.label.trim().slice(0, 40) } : {}),
            }]
            if (!writeStore()) return sendJson(res, 500, { ok: false, error: '保存配置失败' })
          }
          balanceCache.clear()
          return sendJson(res, 200, { ok: true, data: { ...(await describeKeys(row)), saved: ref } })
        }
        if (req.method === 'DELETE') {
          const ref = text(body.ref)
          if (ref === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
            return sendJson(res, 400, { ok: false, error: 'ref 不合法' })
          }
          // 主 key 是宿主适配器自己在用的那把，删了 DeepSeek 直接不可用 → 拒绝
          if (ref === row.apiKeyEnv) {
            return sendJson(res, 400, { ok: false, error: `${ref} 是宿主正在用的主 key，不能在这里删（请在卡片上方「API 密钥」里替换）` })
          }
          if (credentials === undefined || typeof credentials.unset !== 'function') {
            return sendJson(res, 500, { ok: false, error: '宿主凭据服务不支持删除（需要 credentials.unset）' })
          }
          try {
            await credentials.unset(ref)
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: `删除凭据失败：${String(error?.message ?? error)}` })
          }
          const existing = normalizeDeepseekKeys(data.deepseekKeys) ?? []
          const next = existing.filter(entry => entry.ref !== ref)
          if (next.length === 0) delete data.deepseekKeys
          else data.deepseekKeys = next
          if (!writeStore()) return sendJson(res, 500, { ok: false, error: '保存配置失败' })
          balanceCache.clear()
          return sendJson(res, 200, { ok: true, data: await describeKeys(row) })
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      }
      if (tail === '/keys/reveal') {
        // 点「小眼睛」才走这里：把某个引用**当时**的值回给界面。
        // 常规的 /keys 列表永远不含值；这条路由只认「属于该路线的引用」，
        // 免得浏览器把插件当任意引用的读取器用。
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined) return sendJson(res, 400, { ok: false, error: 'invalid json body' })
        const provider = text(body.provider)
        const ref = text(body.ref)
        const row = provider === undefined ? undefined : findRow(provider)
        if (row === undefined || row.deepseekRoute === undefined) {
          return sendJson(res, 404, { ok: false, error: `未知的 DeepSeek 路线 ${provider ?? ''}` })
        }
        if (ref === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
          return sendJson(res, 400, { ok: false, error: 'ref 不合法' })
        }
        const allowed = new Set([
          ...(normalizeDeepseekKeys(data.deepseekKeys) ?? []).map(entry => entry.ref),
          ...(typeof row.apiKeyEnv === 'string' ? [row.apiKeyEnv] : []),
        ])
        if (!allowed.has(ref)) {
          return sendJson(res, 403, { ok: false, error: `${ref} 不属于 ${provider}，拒绝返回` })
        }
        const credential = await resolveApiKey(ctx, ref)
        if (credential === undefined) return sendJson(res, 404, { ok: false, error: `${ref} 未配置` })
        // 值不回落到日志/磁盘：只走这一条响应
        return sendJson(res, 200, { ok: true, data: { ref, value: credential.value, source: credential.source } })
      }
      if (tail === '/history/clear') {
        // 破坏性操作：必须显式带确认串（跨站拦截面之外再加一道，误触也不会真清）
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined) return sendJson(res, 400, { ok: false, error: 'invalid json body' })
        if (body.confirm !== HISTORY_CLEAR_TOKEN) {
          return sendJson(res, 400, {
            ok: false,
            error: `清空历史需要显式确认：POST { "confirm": "${HISTORY_CLEAR_TOKEN}" }`,
          })
        }
        const cleared = clearHistory()
        ctx.logger?.warn?.(`dsh-balance-monitor: 已清空历史（明细 ${cleared.ledgerDays} 天 / ${cleared.records} 条，日汇总 ${cleared.rollupDays} 天）`)
        return sendJson(res, 200, {
          ok: true,
          data: {
            ledgerDays: cleared.ledgerDays,
            records: cleared.records,
            rollupDays: cleared.rollupDays,
            rollupUsd: cleared.rollupUsd,
            /** 落盘失败要说出来（否则「清完了」只是内存里的假象）。 */
            writeFailed: cleared.failed,
          },
        })
      }
      if (tail === '/history/import') {
        // 「导入安装前历史」：**只做能力探测**，不做回放 / 重定价（见 historyImportProbe 注释）
        if (req.method !== 'POST' && req.method !== 'GET') {
          return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        }
        return sendJson(res, 200, { ok: true, data: historyImportProbe() })
      }
      if (tail === '/session') {
        // 「本会话费用」（输入区下方 / 会话标题栏）。金额与全站口径一致：都是账本里
        // 冻结好的价格，不在这里做任何重算。
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const sessionId = text(url.searchParams.get('sessionId'))
        if (sessionId === undefined) {
          return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
        }
        const flag = String(url.searchParams.get('includeSubagent') ?? '').toLowerCase()
        const summary = summarizeSession(ledger, {
          sessionId,
          date: dayKey(),
          includeSubagent: flag === '1' || flag === 'true' || flag === 'yes',
          display: displayConfig(),
        })
        if (summary === null) return sendJson(res, 400, { ok: false, error: 'sessionId 不合法' })
        return sendJson(res, 200, { ok: true, data: summary })
      }
      if (tail === '/sidebar') {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const now = Date.now()
        // 侧栏常驻轮询：探测受冷却限制（否则会把中转站的探测节奏带成每次轮询一次）；
        // 余额只问官方，60s 缓存。
        if (now - sidebarProbedAt >= SIDEBAR_PROBE_COOLDOWN_MS) {
          sidebarProbedAt = now
          await refresh({ force: false })
        }
        const balances = await refreshBalances()
        const balance = pickPrimaryBalance(balances)
        const phase = phaseAt(now, officialPeakConfig())
        const locale = String(req.headers?.['accept-language'] ?? '').toLowerCase().includes('en') ? 'en' : 'zh'
        const payload = buildSidebarData({
          ledger,
          // 模型花费卡片的「近 90 天」要读日汇总（账本明细只有几天）
          rollup,
          date: dayKey(now),
          now,
          display: displayConfig(),
          providers: collectProviders(ctx).map(row => ({ provider: row.provider, displayName: row.displayName })),
          balance,
          peak: peakBlock(phase, now),
          locale,
          modelCard: modelCardConfig(),
        })
        // 价目状态给「更新价格表」按钮用（来源与最近一次更新时间）
        const meta = stationMeta()
        payload.prices = {
          fetchedAt: meta.fetchedAt ?? null,
          sourceKind: meta.sourceKind ?? null,
          accepted: meta.accepted ?? null,
          bundled: meta.bundled === true,
        }
        // 两条 DeepSeek 路线的余额都给出去：侧栏点一下就能切换
        payload.balances = balances
        // 峰谷提醒开关：侧栏要在「跨过切换点」时决定弹不弹（判定在客户端侧做）
        payload.notify = peakNotifyConfig()
        // 界面偏好（语言 / 轮询间隔 / 隐藏区块）：侧栏也要按它渲染
        payload.ui = uiConfig()
        // 会话相关三块（输入区下方 / 横条 / 角标）的配置也跟着侧栏一起来 ——
        // 那三个槽位组件与侧栏共用同一个 store，一次请求够用。
        payload.sessionCost = sessionCostConfig()
        payload.quotaStrip = quotaStripConfig()
        payload.corner = cornerConfig()
        return sendJson(res, 200, { ok: true, data: payload })
      }

      if (tail === '/type') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined) return sendJson(res, 400, { ok: false, error: 'invalid json body' })
        const provider = text(body.provider)
        const type = text(body.type)
        if (provider === undefined || type === undefined || !PROVIDER_TYPES.includes(type)) {
          return sendJson(res, 400, { ok: false, error: `type 必须是 ${PROVIDER_TYPES.join(' / ')}` })
        }
        if (findRow(provider) === undefined) return sendJson(res, 404, { ok: false, error: `未知供应商 ${provider}` })
        data.types[provider] = type
        if (!writeStore()) return sendJson(res, 500, { ok: false, error: '保存失败，详见宿主日志' })
        cache.delete(provider)
        if (type === 'sub2api') await refresh({ provider, force: true })
        return sendJson(res, 200, { ok: true, state: buildState() })
      }

      if (tail === '/refresh') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined) return sendJson(res, 400, { ok: false, error: 'invalid json body' })
        const provider = text(body.provider)
        if (provider !== undefined && findRow(provider) === undefined) {
          return sendJson(res, 404, { ok: false, error: `未知供应商 ${provider}` })
        }
        await refresh({ provider, force: true, withModels: body.withModels !== false })
        return sendJson(res, 200, { ok: true, state: buildState() })
      }

      return sendJson(res, 404, { ok: false, error: 'not found' })
    },
  }), `balance-monitor: ${ROUTE_PREFIX}`)

  ctx.logger?.info?.('dsh-balance-monitor 已挂载（见 设置 → 模型 的供应商卡片）')
}
