/**
 * WorkBuddy 适配器（纯函数 + 无框架依赖，可独立测试）。
 *
 * 对端是 [Sliverkiss/workbuddy2api] 系分支 `workbuddy2api-panel`：把腾讯 CodeBuddy 账号
 * 包装成 OpenAI 兼容网关，自带一个 Web 管理面板。这一类站的指纹与数据源（均已实测）：
 *
 *   GET {root}/v1/usage                → 404（不是 Sub2Api，没有额度接口）
 *   GET {root}/v1/models               → 模型清单，每个模型带 `credits`（积分倍率，如 "x0.79"）
 *   GET {origin}/panel/api/usage       → 站方自己的逐请求用量聚合（含积分与缓存命中）
 *   GET {origin}/panel/api/request_logs→ 逐请求归档（含 credit 真值 + 调用来源 IP/UA）
 *
 * 面板与 `/v1/*` **共用同一把 api_key**（面板走 httpauth.VerifyBearer），所以一把 key
 * 既能对话也能读账。
 *
 * 为什么必须有两条数据源：
 *   - `panel/api/usage` 是**站方口径**：站长整个账号池的消耗，包含所有买家，不是「我的」；
 *   - `panel/api/request_logs` 带 `client_ip` / `user_agent`，**按调用来源过滤**之后才是
 *     「我这把 key 用了多少」。
 *
 * 「积分」不是钱：这类站没有余额接口，也无从获得基准价，所以本适配器只产出积分量，
 * 不折算货币，也不与 USD 账本相加（见 lib/pricing.js 的 creditsWeight 注释）。
 */

import { requestJson, toNumber } from './sub2api.js'

export const PANEL_USAGE_PATH = '/panel/api/usage'
export const PANEL_LOGS_PATH = '/panel/api/request_logs'

/**
 * `request_logs` 的 `limit` 上限（对端硬编码 clamp 到 1000），且**没有分页**：
 * 读的是归档文件尾部的最近 N 条。所以窗口必须切得足够小，否则静默漏数。
 */
export const LOGS_LIMIT_MAX = 1000

/** 单次探测最多切几个窗口。24 小时按 1 小时切 = 24，留一格余量。 */
export const MAX_LOG_WINDOWS = 25

/** 默认来源过滤：DSH 自己就是这个名字（host 侧 UA 形如 `deepseek-harness/0.2.0-rc.2`）。 */
export const DEFAULT_USER_AGENT_FILTER = 'deepseek-harness'

/**
 * 面板地址：取 baseURL 的 **origin**（丢掉 `/v1` 和任何子路径）。
 * 面板挂在站点根下，不是 `/v1` 下。
 * @param {string} baseURL
 * @returns {string} 空串表示解析失败
 */
export function panelOrigin(baseURL) {
  try {
    const url = new URL(String(baseURL ?? '').trim())
    return url.origin
  } catch {
    return ''
  }
}

/**
 * `"x0.79"` / `"0.79"` / `0.79` → `0.79`；脏值 → `undefined`。
 * 与 lib/pricing.js 的 `parseCredits` 同口径（那边用于计价，这边用于指纹与展示，
 * 刻意不跨模块依赖：sub2api.js 也是「纯函数、可独立测试」的风格）。
 * @param {unknown} value
 * @returns {number|undefined}
 */
export function parseCredits(value) {
  const direct = toNumber(value)
  if (direct !== undefined) return direct
  if (typeof value !== 'string') return undefined
  const matched = value.trim().match(/^[x×]\s*([0-9]*\.?[0-9]+)$/i)
  return matched === null ? undefined : toNumber(matched[1])
}

/** 面板的 from/to 参数：unix 秒（对端也接受 RFC3339，但秒最省事）。 */
function seconds(atMs) {
  return Math.floor(Number(atMs) / 1000)
}

function buildQuery(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text.length === 0 ? '' : `?${text}`
}

/**
 * 读 `/v1/models`，带上每模型的积分倍率原文与解析值。
 * @param {string} baseURL provider 配置里的 baseURL（含 /v1）
 * @param {string} apiKey
 * @param {object} [options] 透传给 requestJson
 */
export async function fetchModels(baseURL, apiKey, options = {}) {
  const base = String(baseURL ?? '').trim().replace(/\/+$/, '').replace(/\/v\d+$/i, '')
  const result = await requestJson(`${base}/v1/models`, apiKey, options)
  if (!result.ok) return { ok: false, models: [], error: result.error, status: result.status ?? null }

  const data = result.body?.data
  if (!Array.isArray(data)) return { ok: false, models: [], error: '响应缺少 data 数组', status: result.status }

  const models = []
  for (const item of data) {
    const id = typeof item?.id === 'string' ? item.id : undefined
    if (id === undefined || id.length === 0) continue
    const raw = typeof item?.credits === 'string' ? item.credits.trim() : item?.credits
    const credits = parseCredits(raw)
    models.push({
      id,
      name: typeof item?.name === 'string' ? item.name : undefined,
      credits: credits ?? undefined,
      creditsRaw: typeof raw === 'string' && raw.length > 0 ? raw : undefined,
    })
  }
  return { ok: true, models, status: result.status }
}

function creditAggRow(entry) {
  if (!entry || typeof entry !== 'object') return undefined
  return {
    key: entry.key ?? undefined,
    realm: entry.realm ?? undefined,
    nickname: entry.nickname ?? undefined,
    rate: entry.rate ?? undefined,
    requests: toNumber(entry.requests),
    credits: toNumber(entry.credits),
    creditSamples: toNumber(entry.credit_samples),
    creditTokens: toNumber(entry.credit_tokens),
    /** 与积分同时观测到的缓存命中/未命中 token —— 标定积分单价的两组自变量。 */
    cacheHitTokens: toNumber(entry.cache_hit_tokens),
    cacheMissTokens: toNumber(entry.cache_miss_tokens),
    cacheHitRate: toNumber(entry.cache_hit_rate),
  }
}

/**
 * 读 `/panel/api/usage`（**站方口径**：整个账号池，含所有买家）。
 * @param {{ panelBase: string, apiKey: string, from?: number, to?: number, hours?: number }} input
 *   `from`/`to` 是毫秒时间戳；`hours` 是滚动窗口（二者取其一）。
 */
export async function fetchPanelUsage({ panelBase, apiKey, from, to, hours, ...options } = {}) {
  const root = String(panelBase ?? '').trim().replace(/\/+$/, '')
  if (root.length === 0) return { ok: false, error: '面板地址为空' }
  const query = from !== undefined
    ? { from: seconds(from), to: seconds(to ?? Date.now()) }
    : { hours: hours ?? 24 }
  const result = await requestJson(`${root}${PANEL_USAGE_PATH}${buildQuery(query)}`, apiKey, options)
  if (!result.ok) return { ok: false, error: result.error, status: result.status ?? null }

  const body = result.body
  const totals = body?.totals ?? {}
  return {
    ok: true,
    status: result.status,
    window: { from: body?.window_from ?? undefined, to: body?.window_to ?? undefined },
    totals: {
      requests: toNumber(totals.requests),
      credits: toNumber(totals.credits),
      creditSamples: toNumber(totals.credit_samples),
      creditTokens: toNumber(totals.credit_tokens),
      creditsPer1MTokens: toNumber(totals.credits_per_1m_tokens),
      totalTokens: toNumber(totals.total_tokens),
      cacheHitTokens: toNumber(totals.cache_hit_tokens),
      cacheMissTokens: toNumber(totals.cache_miss_tokens),
      cacheHitRate: toNumber(totals.cache_hit_rate),
    },
    /** 逐账号：标定积分单价时每个账号就是一条观测方程。 */
    byAccount: Array.isArray(body?.credit_by_account) ? body.credit_by_account.map(creditAggRow).filter(Boolean) : [],
    /** 逐模型：带 `rate`（该模型当时的生效倍率），用来把系数折成「×倍率」形式。 */
    byModel: Array.isArray(body?.credit_by_model) ? body.credit_by_model.map(creditAggRow).filter(Boolean) : [],
  }
}

/**
 * 读 `/panel/api/request_logs` 并在**本地**按调用来源过滤求和（**自身口径**）。
 *
 * 两个必须处理的边界（都来自对端实现，不是猜测）：
 *   1. `limit` 上限 1000 且**没有分页**（对端只从归档尾部取最近 N 条）→ 必须把区间切成
 *      足够小的窗口逐个读；某窗返回满 1000 条即标记 `truncated`，如实报告可能漏数，
 *      不假装完整。
 *   2. `credit_known` 区分「上游返回了真 0」与「上游没给 credit 字段」→ 后者不能当 0 计，
 *      单独计数成 `unknown`。
 *
 * @param {{ panelBase: string, apiKey: string, from: number, to: number,
 *           userAgent?: string, clientIp?: string, windowMs?: number }} input
 */
export async function fetchOwnCredits({
  panelBase, apiKey, from, to, userAgent = DEFAULT_USER_AGENT_FILTER, clientIp, windowMs = 3600_000, ...options
} = {}) {
  const root = String(panelBase ?? '').trim().replace(/\/+$/, '')
  if (root.length === 0) return { ok: false, error: '面板地址为空' }

  const start = Number(from)
  const end = Number(to ?? Date.now())
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ok: false, error: '时间区间不合法' }
  }

  const step = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 3600_000
  const windows = []
  for (let cursor = start; cursor < end && windows.length < MAX_LOG_WINDOWS; cursor += step) {
    windows.push([cursor, Math.min(cursor + step, end)])
  }
  const tooManyWindows = Math.ceil((end - start) / step) > MAX_LOG_WINDOWS

  let credits = 0
  let calls = 0
  let unknown = 0
  let truncated = false
  const errors = []

  for (const [windowFrom, windowTo] of windows) {
    const query = {
      limit: LOGS_LIMIT_MAX,
      from: seconds(windowFrom),
      to: seconds(windowTo),
      user_agent: userAgent,
      client_ip: clientIp,
    }
    const result = await requestJson(`${root}${PANEL_LOGS_PATH}${buildQuery(query)}`, apiKey, options)
    if (!result.ok) {
      errors.push({ from: windowFrom, to: windowTo, status: result.status ?? null, message: result.error })
      continue
    }
    const entries = Array.isArray(result.body?.entries) ? result.body.entries : []
    if (entries.length >= LOGS_LIMIT_MAX) truncated = true
    for (const entry of entries) {
      calls++
      if (entry?.credit_known !== true) { unknown++; continue }
      const value = toNumber(entry?.credit)
      if (value !== undefined) credits += value
    }
  }

  return {
    ok: errors.length < windows.length || calls > 0,
    credits,
    calls,
    unknown,
    truncated,
    windows: windows.length,
    /** 窗口数被上限截断：区间开太大，结果不完整。 */
    windowCapped: tooManyWindows,
    errors,
  }
}

/**
 * 一次完整探测：模型清单（含倍率）+ 站方用量 + 自身用量。
 *
 * 三个请求互相独立，任一失败不影响其余。`detected` 是**类型指纹**，与面板可达性解耦：
 * 面板读不到（没权限 / 版本不同）时类型判定依然成立，只是没有消耗数据。
 *
 * @param {string} baseURL
 * @param {string} apiKey
 * @param {{ from?: number, to?: number, userAgent?: string, clientIp?: string,
 *           panelBase?: string, withPanel?: boolean, fetchImpl?: Function,
 *           timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function probeWorkBuddy(baseURL, apiKey, options = {}) {
  const { from, to, userAgent, clientIp, panelBase, withPanel = true, ...rest } = options

  const [modelsResult, usageProbe] = await Promise.all([
    fetchModels(baseURL, apiKey, rest),
    requestJson(`${String(baseURL ?? '').trim().replace(/\/+$/, '').replace(/\/v\d+$/i, '')}/v1/usage`, apiKey, rest),
  ])

  const models = modelsResult.models ?? []
  const ratedModels = models.filter(model => model.credits !== undefined)
  // 指纹：`/v1/usage` 不是 Sub2Api 的 200 结构，且模型清单里有积分倍率。
  // 只要有一条带 credits 就足以确认是「积分倍率型」，不要求全部模型都带
  // （实测 `cn:auto` 这类聚合模型可以没有 credits）。
  const detected = usageProbe.ok === false && ratedModels.length > 0

  const origin = panelBase ?? panelOrigin(baseURL)
  let site
  let own
  if (withPanel && detected && origin.length > 0) {
    const windowFrom = from ?? todayStartMs(to ?? Date.now())
    const windowTo = to ?? Date.now()
    const [siteResult, ownResult] = await Promise.all([
      fetchPanelUsage({ panelBase: origin, apiKey, from: windowFrom, to: windowTo, ...rest }),
      fetchOwnCredits({ panelBase: origin, apiKey, from: windowFrom, to: windowTo, userAgent, clientIp, ...rest }),
    ])
    site = siteResult
    own = ownResult
  }

  return {
    ok: detected,
    detected,
    origin,
    models,
    ratedModelCount: ratedModels.length,
    /** 站方口径：整个账号池（含所有买家）。 */
    site,
    /** 自身口径：按 `client_ip` / `user_agent` 过滤后的真值。 */
    own,
    filter: { userAgent: userAgent ?? DEFAULT_USER_AGENT_FILTER, clientIp: clientIp ?? undefined },
    errors: {
      models: modelsResult.ok ? undefined : { status: modelsResult.status ?? null, message: modelsResult.error },
      usage: usageProbe.ok ? undefined : { status: usageProbe.status ?? null, message: usageProbe.error },
      site: site?.ok === false ? site : undefined,
      own: own?.ok === false ? own : undefined,
    },
  }
}

/** 本地时区的「今天 00:00」毫秒。对端窗口按服务器本地时区算，这里跟用户直觉一致。 */
export function todayStartMs(nowMs = Date.now()) {
  const date = new Date(nowMs)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 人类可读的错误摘要，供 UI 直接显示（与 sub2api.js 的 describeProbeError 同风格）。 */
export function describeWorkBuddyError(probe) {
  if (!probe) return '未探测'
  if (probe.detected) return undefined
  const models = probe.errors?.models
  const usage = probe.errors?.usage
  if (models?.status === 401) return 'API Key 无效'
  if (models !== undefined && usage?.ok !== false) return `模型清单读取失败：${models.message ?? models.status}`
  if (probe.ratedModelCount === 0) return '对端不是 WorkBuddy 型（模型清单里没有 credits 倍率）'
  return '对端不是 WorkBuddy 型'
}
