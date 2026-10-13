/**
 * Sub2Api 适配器（纯函数 + 无框架依赖，可独立测试）。
 *
 * 上游项目：https://github.com/Wei-Shaw/sub2api
 * 两个 key 可读的只读接口（均已实测）：
 *
 *   GET {root}/v1/usage            → 额度 / 余额 / 消耗 / 逐模型明细
 *   GET {root}/v1/sub2api/billing  → 倍率（分组 / 用户覆盖 / 峰谷 / 最终生效）
 *   GET {root}/v1/models           → 模型清单（OpenAI 兼容；积分倍率型站的 `credits` 也在这里）
 *
 * 计费公式（本站口径）：
 *   官方价金额 = usage 里的 cost          （站方按上游官方价算出来的原价）
 *   实际所需   = 官方价金额 × effective_rate_multiplier
 *   站方实扣   = usage 里的 actual_cost    （用于交叉校验，不用于覆盖）
 *
 * 之所以「乘倍率」而不是「读 actual_cost」：用户要的是"按倍率算花费"，
 * 而且 cost 是站方给的、无需我方维护官方价格表；actual_cost 拿来做对照，
 * 两者对不上时告警（jiuhaoche 上实测存在 1 vs 1.28 的口径分歧）。
 */

export const USAGE_PATH = '/v1/usage'
export const BILLING_PATH = '/v1/sub2api/billing'
export const MODELS_PATH = '/v1/models'

/** 供应商类型枚举。`other` 是默认值：不做任何 Sub2Api 专属探测。 */
export const PROVIDER_TYPES = ['sub2api', 'other']
export const DEFAULT_PROVIDER_TYPE = 'other'

/** 2xx 之外也读 body（后端用 body 里的 code 表达业务错误）。 */
const DEFAULT_TIMEOUT_MS = 15000
/** 单次响应体上限：接口都是小 JSON，超过就是异常，不信任 Content-Length。 */
const MAX_BODY_BYTES = 512 * 1024

/**
 * 把用户填的 baseURL 归一成 Sub2Api 的站点根。
 * provider 配置里常见两种写法，都要能吃：
 *   https://walkcoding.top/v1            → https://walkcoding.top
 *   https://nexus.itssx.com/api/grok45   → 原样（同一条 listeners 下的子路径挂载）
 * @param {string} baseURL
 * @returns {string}
 */
export function apiRoot(baseURL) {
  let base = String(baseURL ?? '').trim().replace(/\/+$/, '')
  // 只有「以 /v1 结尾」时才剥离，避免把 /api/grok45 这类子路径截断。
  base = base.replace(/\/v\d+$/i, '')
  return base
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '')
}

/** 有界读取：流式计字节，超限即断。 */
async function readBounded(response, maxBytes = MAX_BODY_BYTES) {
  if (Number(response.headers?.get?.('content-length')) > maxBytes) {
    try { await response.body?.cancel?.() } catch { /* 已断开的 body 无需再处理 */ }
    return { tooLarge: true }
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) {
      try { await response.body?.cancel?.() } catch { /* 同上 */ }
      return { tooLarge: true }
    }
    chunks.push(buffer)
  }
  return { text: Buffer.concat(chunks).toString('utf8') }
}

/**
 * 一次有界的 JSON GET（只读）。余额查询（`./balance.js`）复用它。
 *
 * 加固点（照参照实现的有效做法，而不是依赖声明式的权限字段）：
 *   - `redirect: 'manual'` 且显式拒绝 3xx：`Authorization` 头不能被带到重定向目标主机；
 *   - 响应体上限 512 KiB，流式计字节、不信 `Content-Length`；
 *   - HTML 回落页（SPA 假 200）判为失败，绝不 `JSON.parse` 成功就当真。
 *
 * @param {string} url
 * @param {string} [apiKey] 空值则不带 Authorization 头
 * @param {{ fetchImpl?: Function, timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function requestJson(url, apiKey, options) {
  const { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal, headers: extraHeaders } = options
  const headers = { accept: 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  // 额外头（如 DeepSeek 账号路线的 `x-dsh-auth-token`）：只允许调用方显式给出，
  // 默认不加，免得凭据悄悄跑到别的端点上。
  if (extraHeaders !== null && typeof extraHeaders === 'object') {
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (typeof value === 'string' && value.length > 0) headers[name] = value
    }
  }
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout

  let response
  try {
    // 禁跟随重定向：Authorization 头会被原样带到 3xx 的目标主机。
    response = await fetchImpl(url, { headers, signal: composed, redirect: 'manual' })
  } catch (error) {
    return { ok: false, transport: true, status: null, error: String(error?.message ?? error) }
  }

  if (response.status >= 300 && response.status < 400) {
    try { await response.body?.cancel?.() } catch { /* 同上 */ }
    return { ok: false, status: response.status, error: `endpoint redirected (HTTP ${response.status}); redirects are refused to avoid forwarding credentials` }
  }

  const read = await readBounded(response)
  if (read.tooLarge) {
    return { ok: false, status: response.status, error: `response body exceeds ${MAX_BODY_BYTES} bytes` }
  }
  const text = read.text

  const looksHtml = /^\s*</.test(text)
  if (looksHtml) {
    // 前端 SPA 对未知路径回落 index.html：HTTP 200 + HTML，不是接口成功。
    return { ok: false, status: response.status, spaFallback: true, error: 'endpoint returned HTML (SPA fallback)' }
  }

  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, status: response.status, error: `non-JSON response: ${text.slice(0, 120)}` }
  }

  if (!response.ok) {
    // sub2api 的业务错误：{code, message}（billing）/ {error:{message,type}}（gateway）
    const message = pick(body?.error, 'message') ?? body?.message ?? response.statusText
    const code = body?.code ?? body?.error?.type ?? body?.error?.code
    return { ok: false, status: response.status, code, error: String(message ?? ''), body }
  }

  return { ok: true, status: response.status, body }
}

/**
 * 判据：确认对端确实是 Sub2Api。
 * 只看 `object` 字段，不用「有没有某个键」这种弱判据。
 * @param {unknown} body
 */
export function isSub2ApiBilling(body) {
  return Boolean(body) && typeof body === 'object' && body.object === 'sub2api.key_billing'
}

/**
 * 严格取数：Number(null)/Number('')/Number(false) 都是 0，
 * 会把「解析失败」伪装成「余额为 0」。这里只接受真数字与数值字符串。
 * @param {unknown} value
 * @returns {number|undefined}
 */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0) return undefined
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return undefined
    return Number(text)
  }
  return undefined
}

function pick(object, ...keys) {
  for (const key of keys) {
    const value = object?.[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * 解析 /v1/sub2api/billing。
 * @param {any} body
 */
export function parseBilling(body) {
  if (!isSub2ApiBilling(body)) return undefined
  const peakEnabled = body.peak_rate_enabled === true
  return {
    scope: body.billing_scope ?? undefined,
    schemaVersion: toNumber(body.schema_version),
    groupRate: toNumber(body.group_rate_multiplier),
    userRate: toNumber(body.user_rate_multiplier),
    resolvedRate: toNumber(body.resolved_rate_multiplier),
    effectiveRate: toNumber(body.effective_rate_multiplier),
    observedAt: body.observed_at ?? undefined,
    peak: peakEnabled
      ? {
          enabled: true,
          start: body.peak_start ?? undefined,
          end: body.peak_end ?? undefined,
          multiplier: toNumber(body.peak_rate_multiplier),
          applied: toNumber(body.applied_peak_multiplier),
          timezone: body.timezone ?? undefined,
        }
      : { enabled: false },
  }
}

/**
 * 解析 /v1/usage 的额度部分。
 * 两种 mode：
 *   quota_limited → quota{limit,used,remaining,unit} + rate_limits[] + expires_at
 *   unrestricted  → subscription{...} 或 钱包 balance/remaining/unit/planName
 * @param {any} body
 */
export function parseUsage(body) {
  if (!body || typeof body !== 'object') return undefined
  const mode = body.mode ?? undefined

  const quota = body.quota
    ? {
        limit: toNumber(body.quota.limit),
        used: toNumber(body.quota.used),
        remaining: toNumber(body.quota.remaining),
        unit: body.quota.unit ?? body.unit ?? undefined,
      }
    : undefined

  const rateLimits = Array.isArray(body.rate_limits)
    ? body.rate_limits.map(entry => ({
        window: entry?.window ?? undefined,
        limit: toNumber(entry?.limit),
        used: toNumber(entry?.used),
        remaining: toNumber(entry?.remaining),
        windowStart: entry?.window_start ?? undefined,
        resetAt: entry?.reset_at ?? undefined,
      }))
    : undefined

  const subscription = body.subscription
    ? {
        dailyUsage: toNumber(body.subscription.daily_usage_usd),
        weeklyUsage: toNumber(body.subscription.weekly_usage_usd),
        monthlyUsage: toNumber(body.subscription.monthly_usage_usd),
        dailyLimit: toNumber(body.subscription.daily_limit_usd),
        weeklyLimit: toNumber(body.subscription.weekly_limit_usd),
        monthlyLimit: toNumber(body.subscription.monthly_limit_usd),
        weeklyWindowStart: body.subscription.weekly_window_start ?? undefined,
        expiresAt: body.subscription.expires_at ?? undefined,
      }
    : undefined

  return {
    mode,
    isValid: body.isValid === true,
    status: body.status ?? undefined,
    unit: body.unit ?? undefined,
    planName: body.planName ?? undefined,
    balance: toNumber(pick(body, 'balance', 'remaining')),
    remaining: toNumber(body.remaining),
    quota,
    rateLimits,
    subscription,
    expiresAt: body.expires_at ?? body.subscription?.expires_at ?? undefined,
    daysUntilExpiry: toNumber(body.days_until_expiry),
    usage: parseUsageTotals(body.usage),
    daily: Array.isArray(body.daily_usage) ? body.daily_usage.map(parseDailyEntry) : [],
    models: Array.isArray(body.model_stats) ? body.model_stats.map(parseModelStat) : [],
  }
}

function parseUsageTotals(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  return {
    today: usage.today ? parseTotals(usage.today) : undefined,
    total: usage.total ? parseTotals(usage.total) : undefined,
    averageDurationMs: toNumber(usage.average_duration_ms),
    rpm: toNumber(usage.rpm),
    tpm: toNumber(usage.tpm),
  }
}

function parseTotals(entry) {
  return {
    requests: toNumber(entry.requests),
    inputTokens: toNumber(entry.input_tokens),
    outputTokens: toNumber(entry.output_tokens),
    cacheCreationTokens: toNumber(entry.cache_creation_tokens),
    cacheReadTokens: toNumber(entry.cache_read_tokens),
    totalTokens: toNumber(entry.total_tokens),
    cost: toNumber(entry.cost),
    actualCost: toNumber(entry.actual_cost),
  }
}

function parseDailyEntry(entry) {
  return { date: entry?.date ?? undefined, ...parseTotals(entry ?? {}) }
}

function parseModelStat(entry) {
  return {
    model: entry?.model ?? undefined,
    ...parseTotals(entry ?? {}),
    accountCost: toNumber(entry?.account_cost),
  }
}

/**
 * 口径分歧的**结构化**原因（不返回整句：文案归客户端本地化，宿主只给事实）。
 *
 * 「不一致」本身没法让用户行动，所以把事实拆出来：
 *   - `factor` / `percent` / `direction`：实扣是按倍率算的几倍、高还是低；
 *   - `rateIsUnity`：倍率接口报的就是 1 —— 这种组合（实测 jiuhaoche）通常意味着
 *     站方并不用 `cost × effective_rate_multiplier` 这条公式，而不是「倍数算错了」；
 *   - `modelRateMin/Max/Count`：逐模型反推倍率的范围，用来区分「整体等比例偏移」
 *     与「站方按模型逐个定价」（两者对下一条排查方向完全不同）。
 *
 * @param {{ effectiveRate: number, impliedRate: number, deltaRatio: number, usage: object }} input
 */
function mismatchDetail({ effectiveRate, impliedRate, deltaRatio, usage }) {
  if (typeof effectiveRate !== 'number' || typeof impliedRate !== 'number' || deltaRatio === null) return null
  const rates = []
  for (const item of usage?.models ?? []) {
    const cost = item?.cost
    const actual = item?.actualCost
    if (typeof cost === 'number' && cost > 0 && typeof actual === 'number') rates.push(actual / cost)
  }
  return {
    factor: impliedRate / effectiveRate,
    percent: Math.abs(deltaRatio) * 100,
    direction: impliedRate > effectiveRate ? 'station-charged-more' : 'station-charged-less',
    /** 倍率接口报的就是 1，说明多半不是「cost × 倍率」这条公式。 */
    rateIsUnity: effectiveRate === 1,
    modelRateCount: rates.length,
    modelRateMin: rates.length === 0 ? null : Math.min(...rates),
    modelRateMax: rates.length === 0 ? null : Math.max(...rates),
  }
}

/**
 * 花费计算：官方价（cost）× 生效倍率，并与站方实扣对照。
 *
 * 逐模型可用时用 model_stats 求和；否则退回 usage.total.cost。
 * 倍率缺失时返回 null 的 byMultiplier —— 不静默当成 1。
 *
 * @param {ReturnType<typeof parseUsage>} usage
 * @param {ReturnType<typeof parseBilling>} billing
 */
export function computeSpend(usage, billing) {
  const effectiveRate = billing?.effectiveRate
  const hasRate = typeof effectiveRate === 'number' && Number.isFinite(effectiveRate)

  const modelOfficial = (usage?.models ?? []).reduce((sum, item) => sum + (item.cost ?? 0), 0)
  const modelActual = (usage?.models ?? []).reduce((sum, item) => sum + (item.actualCost ?? 0), 0)

  // 优先级：usage.total（累计，权威）→ usage.today（今日；部分站不返回 total，实测 jiuhaoche 就是）
  // → model_stats 求和。period 一并回传，UI 必须标注是"累计"还是"今日"。
  let period = 'total'
  let officialCost = usage?.usage?.total?.cost
  let actualCost = usage?.usage?.total?.actualCost
  if (officialCost === undefined && actualCost === undefined) {
    period = 'today'
    officialCost = usage?.usage?.today?.cost
    actualCost = usage?.usage?.today?.actualCost
  }
  if (officialCost === undefined && actualCost === undefined) {
    period = 'models'
    officialCost = modelOfficial
    actualCost = modelActual
  }

  const byMultiplier = hasRate && typeof officialCost === 'number' ? officialCost * effectiveRate : null
  const delta = byMultiplier === null || typeof actualCost !== 'number' ? null : byMultiplier - actualCost
  const deltaRatio = delta === null || actualCost === 0 ? null : delta / actualCost
  /** 反推出的实际倍率，仅作展示与告警，不参与计算。 */
  const impliedRate = typeof officialCost === 'number' && officialCost > 0 && typeof actualCost === 'number'
    ? actualCost / officialCost
    : null
  const mismatch = deltaRatio !== null && Math.abs(deltaRatio) > 0.02

  return {
    currency: usage?.unit ?? 'USD',
    period,
    effectiveRate: hasRate ? effectiveRate : null,
    officialCost: typeof officialCost === 'number' ? officialCost : null,
    actualCost: typeof actualCost === 'number' ? actualCost : null,
    byMultiplier,
    delta,
    deltaRatio,
    impliedRate,
    /** 逐模型：倍率 × 该模型原价。 */
    models: (usage?.models ?? []).map(item => ({
      model: item.model,
      requests: item.requests,
      totalTokens: item.totalTokens,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheReadTokens: item.cacheReadTokens,
      officialCost: item.cost,
      actualCost: item.actualCost,
      spend: item.cost !== undefined && hasRate ? item.cost * effectiveRate : null,
    })),
    /** 两个口径对不上时置位，UI 应显示告警而不是悄悄选一个。 */
    mismatch,
    /**
     * `mismatch` 为 true 时的结构化原因（可读文案由界面按语言拼）；没分歧时是 null。
     * 界面仍然**以接口倍率为准** —— 反推值只用来解释「差在哪」。
     */
    mismatchReason: mismatch
      ? mismatchDetail({ effectiveRate, impliedRate, deltaRatio, usage })
      : null,
  }
}

/**
 * 一次完整探测：额度 + 倍率 + 模型。
 * 三个请求互相独立，任一失败不影响其余；`ok` 表示「确认是 Sub2Api 且拿到倍率或额度」。
 *
 * @param {string} baseURL provider 配置里的 baseURL
 * @param {string} apiKey
 * @param {{fetchImpl?: Function, timeoutMs?: number, signal?: AbortSignal, withModels?: boolean}} [options]
 */
export async function probeSub2Api(baseURL, apiKey, options = {}) {
  const root = apiRoot(baseURL)
  if (root.length === 0) return { ok: false, root, error: 'baseURL is empty' }

  const [usageResult, billingResult, modelsResult] = await Promise.all([
    requestJson(`${trimTrailingSlash(root)}${USAGE_PATH}`, apiKey, options),
    requestJson(`${trimTrailingSlash(root)}${BILLING_PATH}`, apiKey, options),
    options.withModels === false
      ? Promise.resolve({ ok: false, skipped: true })
      : requestJson(`${trimTrailingSlash(root)}${MODELS_PATH}`, apiKey, options),
  ])

  const billing = billingResult.ok ? parseBilling(billingResult.body) : undefined
  const usage = usageResult.ok ? parseUsage(usageResult.body) : undefined

  const modelList = []
  if (modelsResult.ok) {
    const data = modelsResult.body?.data
    if (Array.isArray(data)) {
      for (const item of data) {
        const id = typeof item?.id === 'string' ? item.id : undefined
        if (!id) continue
        // 积分倍率型站（WorkBuddy / wbfd）把「倍率」挂在模型清单上（`"credits": "x0.11"`），
        // 这里原样带出去；解析与计价在 lib/pricing.js 的 creditsOf()/creditsWeight()。
        const credits = typeof item?.credits === 'string' && item.credits.trim().length > 0
          ? item.credits.trim()
          : undefined
        modelList.push({
          id,
          name: typeof item?.name === 'string' ? item.name : undefined,
          ...(credits === undefined ? {} : { credits }),
        })
      }
    }
  }

  // 判定是不是 Sub2Api：billing 的 object 是唯一强判据；
  // 拿不到 billing 但 usage 结构对得上，也算（例如 RunModeSimple 下 billing 返回 404）。
  const looksLikeSub2Api = Boolean(billing) || Boolean(usage?.mode)

  return {
    ok: looksLikeSub2Api && (billingResult.ok || usageResult.ok),
    root,
    detected: looksLikeSub2Api,
    billing,
    usage,
    models: modelList,
    spend: usage ? computeSpend(usage, billing) : undefined,
    errors: {
      usage: usageResult.ok ? undefined : pickError(usageResult),
      billing: billingResult.ok ? undefined : pickError(billingResult),
      models: modelsResult.ok || modelsResult.skipped ? undefined : pickError(modelsResult),
    },
  }
}

function pickError(result) {
  if (!result) return undefined
  return {
    status: result.status ?? null,
    code: result.code ?? undefined,
    message: result.error ?? undefined,
    spaFallback: result.spaFallback === true,
    transport: result.transport === true,
  }
}

/** 人类可读的错误摘要，供 UI 直接显示。 */
export function describeProbeError(probe) {
  if (!probe) return '未探测'
  if (probe.ok) return undefined
  const errors = probe.errors ?? {}
  if (errors.billing?.code === 'not_found_error') return '对端不是 Sub2Api（billing 接口不存在）'
  const parts = []
  for (const [scope, error] of Object.entries(errors)) {
    if (!error) continue
    if (error.status === 401 || error.code === 'authentication_error' || error.code === 'INVALID_TOKEN') {
      parts.push(`${scope}: API Key 无效`)
    } else if (error.spaFallback) {
      parts.push(`${scope}: 该地址不是 Sub2Api 接口`)
    } else if (error.transport) {
      parts.push(`${scope}: 网络不可达`)
    } else {
      parts.push(`${scope}: ${error.status ?? '?'} ${error.code ?? ''} ${error.message ?? ''}`.trim())
    }
  }
  return parts.join(' / ') || '探测失败'
}
