/**
 * 站方口径价目：LiteLLM 价目数据的抓取 / 转换 / 合并（零依赖，可独立测试）。
 *
 * ## 为什么用它
 *
 * Sub2Api（`Wei-Shaw/sub2api`）**自己就是用 LiteLLM 的价格表算钱**的：
 *   - 价目文件在它的仓库里：`backend/resources/model-pricing/model_prices_and_context_window.json`（212 KB）
 *   - 同目录 README 写明：原始文件由 **LiteLLM**（`BerriAI/litellm`，MIT）维护，
 *     通过 GitHub Actions 镜像到本仓库的 `price-mirror` 分支；本地那份只是**下不到时的兜底**
 *   - `backend/internal/service/account_stats_pricing.go` 注释：「模型定价文件（LiteLLM）中上游
 *     模型的默认价格」，且「与用户计费共用同一条定价管线」
 *
 * 也就是说：中转站的 `cost` / `actual_cost` 就是用这张表 × 站方倍率算出来的。
 * 拿它当「官方价」，乘上站方倍率，才和站方账单同源 —— 这比第三方转售价（OpenCode Zen）靠得住。
 *
 * ## 它不是什么
 *
 * 它**不是**厂商官方文档的逐字拷贝：LiteLLM 目录里混有各类渠道条目（bedrock / vertex_ai /
 * azure / openrouter / together…）与推算值。所以本模块只收**自营厂商条目**（见 PROVIDER_MAP），
 * 且把来源标成 `station`（站方口径），而不是 `official`（厂商文档）。
 *
 * ## 抓取顺序（第一个成功即用）
 *
 *   1. LiteLLM 上游 raw
 *   2. Sub2Api 的 price-mirror 分支 raw
 *   3. GitHub contents API 取 sub2api 仓库里那份兜底副本（base64）—— raw 被墙时的生路
 */

/**
 * 抓取顺序（第一个成功即用）。
 *
 * `raw.githubusercontent.com` 在部分网络里是**不通**的（本机实测 `fetch failed`），
 * 所以 raw 之后必须有 GitHub API 生路：contents 只给元数据（>1 MB 的文件不内联），
 * 再用 `git/blobs/<sha>` 取 base64 正文（blobs API 支持大文件）。
 */
export const STATION_PRICE_SOURCES = [
  { kind: 'raw', url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json' },
  { kind: 'raw', url: 'https://raw.githubusercontent.com/Wei-Shaw/sub2api/price-mirror/model_prices_and_context_window.json' },
  { kind: 'github-blob', repo: 'BerriAI/litellm', path: 'model_prices_and_context_window.json' },
  { kind: 'github-contents', repo: 'Wei-Shaw/sub2api', path: 'backend/resources/model-pricing/model_prices_and_context_window.json' },
]

/** 合并进价表时用的目录名（`providers.station`）。 */
export const STATION_CATALOG = 'station'

/** 数据出处（署名用；数据是 LiteLLM 的 MIT 资产，经 sub2api 镜像分发）。 */
export const STATION_ATTRIBUTION = 'LiteLLM model_prices_and_context_window.json (MIT), mirrored by Wei-Shaw/sub2api'

/** 响应体上限：LiteLLM 全量目录 ~1–2 MB，base64 后的 API 响应更大。 */
const MAX_BYTES = 12 * 1024 * 1024

/**
 * LiteLLM 的 `litellm_provider` → 本插件的厂商名（**只收自营厂商**）。
 * 渠道/路由器（azure、vertex_ai、bedrock、openrouter、together_ai、groq、fireworks_ai、
 * ollama 等）一律不收：它们不是厂商官方价，混进来会顶掉真价格。
 */
export const PROVIDER_MAP = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  mistral: 'mistral',
  meta: 'meta',
  meta_llama: 'meta',
  nvidia_nim: 'nvidia',
  upstage: 'upstage',
  minimax: 'minimax',
  zai: 'z-ai',
  'z-ai': 'z-ai',
  zhipu: 'z-ai',
  zhipuai: 'z-ai',
  dashscope: 'alibaba',
  alibaba: 'alibaba',
  qwen: 'alibaba',
  tencent: 'tencent',
  hunyuan: 'tencent',
  xiaomi: 'xiaomi',
  meituan: 'meituan',
  stepfun: 'stepfun',
}

/** 只接受对话/补全类条目（其余模式的单价不是「每 token」口径）。 */
const CHAT_MODES = new Set(['chat', 'completion', undefined, null, ''])

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim().length > 0) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return null
}

/** 每 token 的美元价 → 每 1M token 的美元价（非有限/负数 → null）。 */
function perMillion(value) {
  const number = finiteNumber(value)
  if (number === null || number < 0) return null
  const scaled = number * 1_000_000
  if (!Number.isFinite(scaled)) return null
  // 浮点尘（1e-7 × 1e6 = 0.09999999999999999）统一收敛到 6 位小数
  const rounded = Number(scaled.toFixed(6))
  return rounded === 0 && scaled > 0 ? Number(scaled.toPrecision(15)) : rounded
}

/** `input_cost_per_token_above_272k_tokens` → 272000（没有这种后缀就返回 null）。 */
function aboveTokensOf(key, field) {
  const matched = new RegExp(`^${field}_above_(\\d+)k(?:_tokens)?$`).exec(key)
  if (matched === null) return null
  const thousands = Number(matched[1])
  return Number.isFinite(thousands) && thousands > 0 ? thousands * 1000 : null
}

/**
 * 长上下文档：LiteLLM 用 `*_above_<N>k_tokens` 后缀表达「超过 N 之后的那一档」。
 * 我们收成 `longContext: { aboveInputTokens, cacheMiss, cacheHit, cacheWrite?, output? }`，
 * 与 `lib/pricing.js` 的 `costOf()` 阈值切档一致（也对应 sub2api 的 `Intervals`）。
 */
function longContextOf(raw) {
  const thresholds = new Map()
  for (const key of Object.keys(raw)) {
    for (const field of ['input_cost_per_token', 'output_cost_per_token', 'cache_read_input_token_cost', 'cache_creation_input_token_cost']) {
      const above = aboveTokensOf(key, field)
      if (above === null) continue
      const bucket = thresholds.get(above) ?? {}
      bucket[field] = raw[key]
      thresholds.set(above, bucket)
    }
  }
  let best = null
  for (const [aboveInputTokens, fields] of thresholds) {
    const cacheMiss = perMillion(fields.input_cost_per_token)
    if (cacheMiss === null) continue // 没有输入价的长档没有意义
    const candidate = {
      aboveInputTokens,
      cacheMiss,
      cacheHit: perMillion(fields.cache_read_input_token_cost) ?? cacheMiss,
      ...(perMillion(fields.cache_creation_input_token_cost) === null ? {} : { cacheWrite: perMillion(fields.cache_creation_input_token_cost) }),
      ...(perMillion(fields.output_cost_per_token) === null ? {} : { output: perMillion(fields.output_cost_per_token) }),
    }
    // 多个阈值时取最小的那个（最先触发）
    if (best === null || candidate.aboveInputTokens < best.aboveInputTokens) best = candidate
  }
  return best
}

/**
 * 解析 LiteLLM 价目 JSON → 我们的价目条目。
 *
 * @param {object} json `model_prices_and_context_window.json` 的解析结果
 * @param {{ sourceUrl?: string, checkedAt?: string }} [meta]
 * @returns {{ models: Record<string, object>, stats: object }}
 *   `models` 的键是模型 id（去掉渠道前缀），值形如
 *   `{ cacheMiss, cacheHit, cacheWrite?, output, currency: 'USD', source: 'station', … }`
 */
export function parseStationPrices(json, meta = {}) {
  const models = {}
  const stats = { total: 0, accepted: 0, skippedProvider: 0, skippedMode: 0, skippedCost: 0, skippedShape: 0, byVendor: {} }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { models, stats }
  }
  const checkedAt = typeof meta.checkedAt === 'string' && meta.checkedAt.length > 0
    ? meta.checkedAt
    : new Date().toISOString().slice(0, 10)
  const sourceUrl = typeof meta.sourceUrl === 'string' ? meta.sourceUrl : null

  for (const [rawKey, raw] of Object.entries(json)) {
    stats.total += 1
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      stats.skippedShape += 1
      continue
    }
    const litellmProvider = typeof raw.litellm_provider === 'string' ? raw.litellm_provider.toLowerCase() : ''
    const vendor = PROVIDER_MAP[litellmProvider]
    if (vendor === undefined) {
      stats.skippedProvider += 1
      continue
    }
    if (!CHAT_MODES.has(raw.mode)) {
      stats.skippedMode += 1
      continue
    }
    const cacheMiss = perMillion(raw.input_cost_per_token)
    const output = perMillion(raw.output_cost_per_token)
    if (cacheMiss === null || output === null) {
      stats.skippedCost += 1
      continue
    }
    const cacheHit = perMillion(raw.cache_read_input_token_cost) ?? cacheMiss
    const cacheWrite = perMillion(raw.cache_creation_input_token_cost)
    const longContext = longContextOf(raw)
    // 键：去掉渠道前缀（`anthropic/claude-…` → `claude-…`），保留原生 id 原样
    const slash = rawKey.lastIndexOf('/')
    const modelId = slash >= 0 && slash < rawKey.length - 1 ? rawKey.slice(slash + 1) : rawKey
    if (modelId.length === 0 || modelId === '__proto__' || modelId === 'constructor') {
      stats.skippedShape += 1
      continue
    }
    const existing = models[modelId]
    // 同一个 id 出现多次时：优先「自营厂商 + 无渠道前缀」的那条，其余忽略
    if (existing !== undefined) {
      const better = existing.litellmProvider !== vendor && litellmProvider === vendor
      if (!better) {
        stats.skippedShape += 1
        continue
      }
    }
    models[modelId] = {
      cacheMiss,
      cacheHit,
      ...(cacheWrite === null ? {} : { cacheWrite }),
      output,
      ...(longContext === null ? {} : { longContext }),
      currency: 'USD',
      source: 'station',
      litellmProvider,
      vendor,
      ...(sourceUrl === null ? {} : { sourceUrl }),
      checkedAt,
    }
    stats.accepted += 1
    if (longContext !== null) stats.withLongContext = (stats.withLongContext ?? 0) + 1
    stats.byVendor[vendor] = (stats.byVendor[vendor] ?? 0) + 1
  }
  return { models, stats }
}

function decodeBase64(text) {
  try {
    return Buffer.from(String(text), 'base64').toString('utf8')
  } catch {
    return null
  }
}

/** 有界读取（流式计字节，不信 Content-Length）。 */
async function readBounded(response) {
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BYTES) {
      try { await response.body?.cancel?.() } catch { /* 已断开 */ }
      return { tooLarge: true }
    }
    chunks.push(buffer)
  }
  return { text: Buffer.concat(chunks).toString('utf8') }
}

/**
 * 按来源链抓取价目（第一个成功即返回）。
 *
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, text: string, sourceUrl: string, kind: string } | { ok: false, errors: string[] }>}
 */
export async function fetchStationPrices({ fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const errors = []
  const request = async url => {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': `${STATION_ATTRIBUTION} (dsh-balance-monitor)` },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!(response.status >= 200 && response.status < 300)) return { error: `HTTP ${response.status}` }
    const read = await readBounded(response)
    if (read.tooLarge) return { error: `响应超过 ${Math.round(MAX_BYTES / 1024 / 1024)} MB` }
    return { text: read.text }
  }
  const accept = (text, sourceUrl, kind) => {
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      return { error: '不是有效 JSON' }
    }
    const keys = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).length : 0
    // 结构守卫：全量目录几千条；条数太少说明对端给了错误页/半截内容
    if (keys < 100) return { error: `只有 ${keys} 条，判为异常响应` }
    return { ok: true, text, sourceUrl, kind }
  }
  const fromContents = payload => {
    if (payload?.encoding !== 'base64' || typeof payload.content !== 'string' || payload.content.length === 0) return null
    const decoded = decodeBase64(payload.content.replace(/\s+/g, ''))
    return decoded
  }

  for (const source of STATION_PRICE_SOURCES) {
    const label = source.kind === 'raw' ? source.url : `${source.kind} ${source.repo}/${source.path}`
    try {
      if (source.kind === 'raw') {
        const result = await request(source.url)
        if (result.error !== undefined) {
          errors.push(`${label} → ${result.error}`)
          continue
        }
        const accepted = accept(result.text, source.url, 'raw')
        if (accepted.ok === true) return accepted
        errors.push(`${label} → ${accepted.error}`)
        continue
      }
      // GitHub API：先拿元数据（>1 MB 的文件 content 为空），再按 sha 取 blob
      const metaUrl = `https://api.github.com/repos/${source.repo}/contents/${source.path}`
      const metaResult = await request(metaUrl)
      if (metaResult.error !== undefined) {
        errors.push(`${label} → ${metaResult.error}`)
        continue
      }
      let meta = null
      try {
        meta = JSON.parse(metaResult.text)
      } catch {
        errors.push(`${label} → 元数据不是 JSON`)
        continue
      }
      const inline = fromContents(meta)
      if (inline !== null) {
        const accepted = accept(inline, metaUrl, source.kind)
        if (accepted.ok === true) return accepted
        errors.push(`${label} → ${accepted.error}`)
        continue
      }
      if (typeof meta?.sha !== 'string' || meta.sha.length === 0) {
        errors.push(`${label} → 元数据里没有 sha`)
        continue
      }
      const blobUrl = `https://api.github.com/repos/${source.repo}/git/blobs/${meta.sha}`
      const blobResult = await request(blobUrl)
      if (blobResult.error !== undefined) {
        errors.push(`${label} → blobs ${blobResult.error}`)
        continue
      }
      let blob = null
      try {
        blob = JSON.parse(blobResult.text)
      } catch {
        errors.push(`${label} → blob 不是 JSON`)
        continue
      }
      const decoded = fromContents(blob)
      if (decoded === null) {
        errors.push(`${label} → blob 内容不是 base64`)
        continue
      }
      const accepted = accept(decoded, blobUrl, 'github-blob')
      if (accepted.ok === true) return accepted
      errors.push(`${label} → ${accepted.error}`)
    } catch (error) {
      errors.push(`${label} → ${String(error?.message ?? error)}`)
    }
  }
  return { ok: false, errors }
}

/**
 * 把站方价目合并进基础价表：**追加**一个 `station` 目录。
 *
 * 位置很关键：它排在现有厂商目录之后，所以
 *   - 官方来源条目（`official`）先命中 → 直连官方渠道仍按厂商官方价；
 *   - 转售/聚合目录（`reseller` / `aggregator`）默认被策略排除 → 站方口径胜出。
 */
export function mergeStationTable(base, stationModels) {
  if (base === null || typeof base !== 'object') return base
  if (stationModels === null || typeof stationModels !== 'object' || Object.keys(stationModels).length === 0) return base
  return {
    ...base,
    providers: { ...(base.providers ?? {}), [STATION_CATALOG]: stationModels },
  }
}
