/**
 * DeepSeek 官方余额（纯函数 + 一次只读请求）。
 *
 * **只有官方这一家支持余额**：中转站要么没有余额接口（wbfd 型），要么余额口径不明
 * （Sub2Api 的 `balance`/`quota.remaining` 是站点自己的单位）。所以侧栏的「余额」行
 * 只在 provider 是官方路由时出现。
 *
 * 安全边界（与参照实现一致）：余额请求**只允许打官方域名**，配置里 baseURL 不是
 * `api.deepseek.com` 时直接拒绝发起请求 —— 免得把 DeepSeek 的 Key 送到别处去。
 * 官方文档：`GET /user/balance` → `{ is_available, balance_infos: [{ currency,
 * total_balance, granted_balance, topped_up_balance }] }`（金额是字符串）。
 */
import { requestJson, toNumber } from './sub2api.js'

export const DEEPSEEK_OFFICIAL_HOST = 'api.deepseek.com'
export const DEEPSEEK_BALANCE_URL = `https://${DEEPSEEK_OFFICIAL_HOST}/user/balance`

/**
 * 账号登录路线（`deepseek-account`）的余额端点。
 *
 * 两条 DeepSeek 路线是**不同的钱包**（同一账号下 API Key 路线与账号路线各记一份），
 * 所以余额要分别查、界面上要能切换：
 *   - 账号路线：`{platformOrigin}/api/v0/users/get_user_summary`，头 `x-dsh-auth-token`，
 *     返回精确到小数点后 6+ 位的 `normal_wallets` / `bonus_wallets`（赠送）与 `total_costs`；
 *   - API Key 路线：`{api}/user/balance`，头 `Authorization: Bearer`（见 queryDeepSeekBalance）。
 *
 * 账号 token 同时也能打推理域（实测 `api.deepseek.com/user/balance` 也认 `x-dsh-auth-token`），
 * 所以平台端点拿不到时用推理域兜底（数字会被官方四舍五入到 2 位）。
 */
export const DEEPSEEK_PLATFORM_ORIGIN = 'https://platform.deepseek.com'
export const DEEPSEEK_PLATFORM_BALANCE_URL = `${DEEPSEEK_PLATFORM_ORIGIN}/api/v0/users/get_user_summary`

/** 该 baseURL 是不是官方端点（主机名必须**恰好**是官方域名）。 */
export function isOfficialDeepSeek(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.trim().length === 0) return false
  try {
    const url = new URL(baseURL.trim())
    if (url.protocol !== 'https:') return false
    return url.hostname.toLowerCase() === DEEPSEEK_OFFICIAL_HOST
  } catch {
    return false
  }
}

/**
 * 解析 `GET /user/balance`。
 * @returns {{ isAvailable: boolean, currency: string | null, total: number | null,
 *             granted: number | null, toppedUp: number | null,
 *             infos: Array<{ currency: string | null, total: number | null }> } | null}
 *          null 表示响应不含 `balance_infos`（结构变了或不是官方端点）
 */
export function parseDeepSeekBalance(body) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.balance_infos)) return null
  const infos = body.balance_infos
    .filter(info => info !== null && typeof info === 'object')
    .map(info => ({
      currency: typeof info.currency === 'string' ? info.currency.toUpperCase() : null,
      total: toNumber(info.total_balance) ?? null,
      granted: toNumber(info.granted_balance) ?? null,
      toppedUp: toNumber(info.topped_up_balance) ?? null,
    }))
  if (infos.length === 0) return null
  // 多币种时优先人民币（该账户的实际计费币种），否则取第一条。
  const primary = infos.find(info => info.currency === 'CNY') ?? infos[0]
  return {
    isAvailable: body.is_available === true,
    currency: primary.currency,
    total: primary.total,
    granted: primary.granted,
    toppedUp: primary.toppedUp,
    infos: infos.map(info => ({ currency: info.currency, total: info.total })),
  }
}

/**
 * 解析账号路线的 `get_user_summary`（实测形状）：
 *
 * ```json
 * { "code": 0, "msg": "", "data": { "biz_code": 0, "biz_msg": "", "biz_data": {
 *     "normal_wallets": [{ "currency": "CNY", "balance": "-0.0433720200000000", "token_estimation": "0" }],
 *     "bonus_wallets":  [{ "currency": "CNY", "balance": "0", "token_estimation": "0" }],
 *     "total_costs":    [{ "currency": "CNY", ... }] } } }
 * ```
 *
 * 兼容 `biz_data` 直接挂在 `data` 上的变体；钱包金额是**字符串**，保留原精度。
 * @returns {{ currency: string | null, total: number | null, granted: number | null,
 *             toppedUp: number | null, normalWallets: Array, bonusWallets: Array } | null}
 */
export function parseDeepSeekAccountSummary(body) {
  if (body === null || typeof body !== 'object') return null
  const envelope = body.data !== null && typeof body.data === 'object' ? body.data : body
  const payload = envelope?.biz_data !== null && typeof envelope?.biz_data === 'object' ? envelope.biz_data : envelope
  if (payload === null || typeof payload !== 'object') return null
  const wallets = list => (Array.isArray(list) ? list : [])
    .filter(item => item !== null && typeof item === 'object')
    .map(item => ({
      currency: typeof item.currency === 'string' ? item.currency.toUpperCase() : null,
      balance: toNumber(item.balance) ?? null,
    }))
  const normal = wallets(payload.normal_wallets)
  const bonus = wallets(payload.bonus_wallets)
  if (normal.length === 0 && bonus.length === 0) return null
  const pick = (rows, currency) => rows.find(row => row.currency === currency) ?? rows[0] ?? null
  const primaryNormal = pick(normal, 'CNY')
  const primaryBonus = pick(bonus, primaryNormal?.currency ?? 'CNY')
  const total = primaryNormal?.balance ?? null
  const granted = primaryBonus?.balance ?? null
  return {
    currency: primaryNormal?.currency ?? primaryBonus?.currency ?? null,
    total,
    granted,
    // 充值 = 正常钱包 - 赠送（平台不给这个字段，自己算；缺一边就为 null）
    toppedUp: total !== null && granted !== null ? Number((total - granted).toFixed(6)) : null,
    normalWallets: normal,
    bonusWallets: bonus,
    source: 'account-platform',
  }
}

/**
 * 查账号路线的余额。
 *
 * 顺序：平台 `get_user_summary`（精确）→ 推理域 `/user/balance`（同一 token 也认，
 * 但数字被官方四舍五入到 2 位）。两边都失败就如实返回错误。
 *
 * @param {{ token: string, baseURL?: string, fetchImpl?: Function, timeoutMs?: number }} options
 * @returns {Promise<{ ok: true, balance: object, source: string } | { ok: false, error: string }>}
 */
export async function queryDeepSeekAccountBalance({ token, baseURL = DEEPSEEK_PLATFORM_ORIGIN, fetchImpl, timeoutMs } = {}) {
  const value = typeof token === 'string' ? token.trim() : ''
  if (value.length === 0) {
    return { ok: false, error: '未登录 DeepSeek 账号（拿不到账号 token）' }
  }
  const options = { headers: { 'x-dsh-auth-token': value }, ...(fetchImpl === undefined ? {} : { fetchImpl }), ...(timeoutMs === undefined ? {} : { timeoutMs }) }
  const errors = []
  // ① 平台账号接口（精确余额）
  if (isPlatformOrigin(baseURL)) {
    const platform = await requestJson(DEEPSEEK_PLATFORM_BALANCE_URL, null, options)
    if (platform.ok) {
      const parsed = parseDeepSeekAccountSummary(platform.body)
      if (parsed !== null) return { ok: true, balance: { ...parsed, isAvailable: true }, source: 'account-platform' }
      errors.push('平台余额响应结构不符')
    } else {
      errors.push(describeBalanceFailure(platform, '平台余额'))
    }
  }
  // ② 推理域（同一 token 可用，数字四舍五入到 2 位）
  const inference = await requestJson(DEEPSEEK_BALANCE_URL, null, options)
  if (inference.ok) {
    const parsed = parseDeepSeekBalance(inference.body)
    if (parsed !== null) {
      return { ok: true, balance: { ...parsed, infos: parsed.infos, source: 'account-api' }, source: 'account-api' }
    }
    errors.push('推理域余额响应缺少 balance_infos')
  } else {
    errors.push(describeBalanceFailure(inference, '推理域余额'))
  }
  return { ok: false, error: errors.join('；') || '账号余额查询失败' }
}

/** `platform.deepseek.com` 这类平台源（只允许官方那一台）。 */
function isPlatformOrigin(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return true
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:') return false
    return url.hostname.toLowerCase() === new URL(DEEPSEEK_PLATFORM_ORIGIN).hostname
  } catch {
    return false
  }
}

/** 余额请求失败的统一人话（401/取消失效 → 引导重新登录）。 */
function describeBalanceFailure(result, label) {
  if (result.status === 401 || result.status === 403) return `${label}：登录已失效，请在 DeepSeek 账号里重新登录`
  if (result.transport) return `${label}：网络不可达`
  return `${label}：${`${result.status ?? '?'} ${result.error ?? ''}`.trim()}`
}

/**
 * 查询官方余额。
 *
 * @param {string} baseURL provider 配置里的 baseURL（只在官方域名时才发请求）
 * @param {string} apiKey
 * @returns {Promise<{ ok: true, balance: object } | { ok: false, error: string }>}
 */
export async function queryDeepSeekBalance(baseURL, apiKey, options = {}) {
  if (!isOfficialDeepSeek(baseURL)) {
    return { ok: false, error: '余额查询仅支持官方端点（api.deepseek.com），已拒绝向非官方域名发送 API Key' }
  }
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return { ok: false, error: '未找到 DeepSeek API Key' }
  }
  const result = await requestJson(DEEPSEEK_BALANCE_URL, apiKey.trim(), options)
  if (!result.ok) {
    const reason = result.status === 401 || result.code === 'authentication_error' || result.code === 'INVALID_TOKEN'
      ? 'API Key 无效'
      : result.transport
        ? '网络不可达'
        : `${result.status ?? '?'} ${result.code ?? ''} ${result.error ?? ''}`.trim()
    return { ok: false, error: reason || '余额查询失败' }
  }
  const balance = parseDeepSeekBalance(result.body)
  if (balance === null) return { ok: false, error: '余额响应缺少 balance_infos' }
  return { ok: true, balance: { ...balance, source: 'api-key' } }
}

/**
 * 多把 key 收成一条路线的余额。
 *
 * `isAvailable` 表示「还有没有一把能接着打」。官方的 `is_available` 是**按 key**给的：
 * 其中一把是负的，不该把其余 key 加出来的总额标成「余额不足」。
 * 一把都没查到金额时为 false（调用方同时带上逐把错误，界面显示的是错误而不是这句）。
 *
 * @param {Array<{ amount?: number, currency?: string | null, isAvailable?: boolean,
 *   granted?: number, toppedUp?: number, source?: string | null }>} keys
 */
export function summarizeKeyBalances(keys) {
  const rows = Array.isArray(keys) ? keys : []
  const priced = rows.filter(item => item !== null && typeof item === 'object'
    && typeof item.amount === 'number' && Number.isFinite(item.amount))
  const currency = priced[0]?.currency ?? null
  const sameCurrency = priced.every(item => (item.currency ?? null) === currency)
  const sum = priced.reduce((total, item) => total + item.amount, 0)
  const grantedKnown = sameCurrency && priced.length > 0 && priced.every(item => typeof item.granted === 'number')
  const toppedKnown = sameCurrency && priced.length > 0 && priced.every(item => typeof item.toppedUp === 'number')
  return {
    amount: priced.length === 0 || !sameCurrency ? null : Number(sum.toFixed(6)),
    currency: sameCurrency ? currency : null,
    isAvailable: priced.some(item => item.isAvailable === true),
    granted: grantedKnown ? Number(priced.reduce((total, item) => total + item.granted, 0).toFixed(6)) : null,
    toppedUp: toppedKnown ? Number(priced.reduce((total, item) => total + item.toppedUp, 0).toFixed(6)) : null,
    source: priced[0]?.source ?? null,
    mixedCurrency: priced.length > 0 && !sameCurrency,
  }
}
