/**
 * 档位解析与计价（纯函数，零依赖，可用任意输入独立测试）。
 *
 * 解决的问题：`本会话` 的费用要和「模型 + 倍率」口径一致，就必须在**每次调用发起的
 * 那个时刻**把档位固定下来，然后一次性算完入账；否则峰谷一过、倍率一变，历史金额
 * 会跟着变（这正是现成费用插件在自定义渠道上算出 ¥0 / 对不上账的根因之一）。
 *
 * 三家档位来源不同，本模块把它们归一成三层，**相乘**而不是互相替代：
 *
 *   金额 = 单位价档位（官方峰谷档，本地算）      ← tierFor()
 *        × 站方账户倍率（含站方峰谷因子，快照+本地算） ← resolveProviderRate()
 *        × 积分倍率（credits 型站，按模型静态）    ← creditsOf()
 *
 * 为什么不能合并成一个窗口表：官方峰谷是「在价表里选两列价之一」（谷价列 / 峰价列），
 * 站方峰谷是「乘在金额上的因子」；语义、时区来源、是否需要网络都不同。详见 README。
 *
 * 三条硬规则：
 *   1. **未定价 ≠ 0**：缺单位价时 costOf() 返回 null，priceCall() 返回 `cost: null`，
 *      界面应显示 `—`，绝不能把「没有价格」渲染成「没花钱」。
 *   2. **窗口一律用 UTC 小时表达**（中国无夏令时，UTC+8 恒定），不引入服务器时区。
 *   3. **依据变更不重算历史**：入账即固化（见文末「历史不可改写」一节），
 *      调价/改窗口/换汇率只影响之后的调用，本模块**不提供**任何重定价入口。
 */

// ── 官方（DeepSeek）峰谷：本地配置，零网络 ────────────────────────────────

/**
 * 高峰时段窗口：UTC 小时，半开区间 `[start, end)`。
 * 默认值对应北京时间 09:00–12:00、14:00–18:00（UTC+8）。数值需按官方现行公告核对。
 */
export const OFFICIAL_PEAK_WINDOWS = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
]

/** 峰谷规则生效时刻：早于此刻的调用不套峰谷档（按基础价）。 */
export const OFFICIAL_PEAK_EFFECTIVE_AT = '2026-08-01T00:00:00Z'

/** 周末全谷价生效时刻：此后北京日历日的周六/周日全天不再区分峰谷。 */
export const OFFICIAL_WEEKEND_OFFPEAK_FROM = '2026-08-22T16:00:00Z'

/** 峰谷时代分界：早于此刻按「峰谷时代之前的基础价」（价表用 `legacyBase` 表达）。 */
export const OFFICIAL_LEGACY_BOUNDARY = '2026-08-16T16:00:00Z'

/**
 * 按谷价处理的北京日历日（法定假期）。**这张表每年要人工更新**：
 * 漏更新会把假日的谷价当峰价算。调休上班的周末仍由周末规则判谷。
 */
export const OFFICIAL_HOLIDAYS = [
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

/** 官方峰谷的默认配置（`state.json` 的 `officialPeak` 就是按这个结构逐字段覆盖它）。 */
export const DEFAULT_OFFICIAL_PEAK = {
  enabled: true,
  effectiveAt: OFFICIAL_PEAK_EFFECTIVE_AT,
  weekendOffPeakFrom: OFFICIAL_WEEKEND_OFFPEAK_FROM,
  legacyBoundary: OFFICIAL_LEGACY_BOUNDARY,
  windows: OFFICIAL_PEAK_WINDOWS,
  holidays: OFFICIAL_HOLIDAYS,
}

/** UTC 小时窗口的合法上界（24 小时制）。 */
const WINDOW_HOUR_MAX = 23
/** 窗口条数上限：给指纹与展示一个有界的大小。 */
const WINDOW_MAX_COUNT = 48
/** 假期日期的文法（北京日历日）。 */
const HOLIDAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isoString(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0 || !Number.isFinite(Date.parse(text))) return null
  return text
}

/**
 * 归一 `state.json` 的 `officialPeak`（**逐字段**覆盖 `DEFAULT_OFFICIAL_PEAK`）。
 *
 * 规则与 `retention` 同一套：字段缺失或非法 → 该字段回落默认值。两个刻意的例外：
 *   - **显式空数组是有效值**：`windows: []` = 永不判峰（全按谷价档）、`holidays: []` = 没有假期；
 *   - 但「给了非空数组却一条都不合法」按打字错处理，回落到默认表 —— 免得一个笔误
 *     把整年的假期静默丢掉（两种情形靠「原数组长度」区分）。
 *
 * @param {unknown} value
 * @returns {typeof DEFAULT_OFFICIAL_PEAK | undefined} 不是普通对象时返回 undefined（= 没配）
 */
export function normalizeOfficialPeak(value) {
  if (!isPlainObject(value)) return undefined

  const rawWindows = value.windows
  const windows = Array.isArray(rawWindows)
    ? rawWindows
        .map(window => ({ start: finiteNumber(window?.start), end: finiteNumber(window?.end) }))
        .filter(window => Number.isInteger(window.start) && Number.isInteger(window.end)
          && window.start >= 0 && window.start <= WINDOW_HOUR_MAX
          && window.end >= 0 && window.end <= WINDOW_HOUR_MAX)
        .slice(0, WINDOW_MAX_COUNT)
    : null

  const rawHolidays = value.holidays
  const holidays = Array.isArray(rawHolidays)
    ? [...new Set(rawHolidays
        .filter(item => typeof item === 'string' && HOLIDAY_PATTERN.test(item.trim()) && Number.isFinite(Date.parse(item.trim())))
        .map(item => item.trim()))].sort()
    : null

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_OFFICIAL_PEAK.enabled,
    effectiveAt: isoString(value.effectiveAt) ?? DEFAULT_OFFICIAL_PEAK.effectiveAt,
    weekendOffPeakFrom: isoString(value.weekendOffPeakFrom) ?? DEFAULT_OFFICIAL_PEAK.weekendOffPeakFrom,
    legacyBoundary: isoString(value.legacyBoundary) ?? DEFAULT_OFFICIAL_PEAK.legacyBoundary,
    windows: windows === null || (windows.length === 0 && rawWindows.length > 0)
      ? DEFAULT_OFFICIAL_PEAK.windows
      : windows,
    holidays: holidays === null || (holidays.length === 0 && rawHolidays.length > 0)
      ? DEFAULT_OFFICIAL_PEAK.holidays
      : holidays,
  }
}

const DAY_MS = 86400000
/** 北京时间日界：UTC+8（中国无夏令时，恒定）。 */
const BEIJING_OFFSET_MS = 8 * 3600000
/** 峰谷切换点扫描步长与视野（只用于「下一个切换时刻」倒计时，不影响计价）。 */
const SWITCH_STEP_MS = 15 * 60000
const SWITCH_HORIZON_MS = 48 * 3600000

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0) return null
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null
    return Number(text)
  }
  return null
}

function firstNumber(...values) {
  for (const value of values) {
    const number = finiteNumber(value)
    if (number !== null) return number
  }
  return null
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 桶计数：非有限/负数一律按 0（脏值不得污染金额）。 */
function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

// ── 官方峰谷判定 ────────────────────────────────────────────────────────

/** 时刻所属的北京日历日 `YYYY-MM-DD`（先平移 +8h 再读 UTC 日期）。 */
export function beijingDayKey(atMs) {
  if (!Number.isFinite(atMs)) return null
  return new Date(Math.floor((atMs + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10)
}

/**
 * 假期区间（北京的整个日历日，返回 UTC ms）。
 * @returns {{ start: number, end: number, kind: 'holiday' } | null}
 */
export function holidayZoneAt(atMs, config = DEFAULT_OFFICIAL_PEAK) {
  const from = Date.parse(config?.weekendOffPeakFrom ?? '')
  if (!Number.isFinite(atMs) || !Number.isFinite(from) || atMs < from) return null
  const holidays = Array.isArray(config?.holidays) ? config.holidays : []
  const key = beijingDayKey(atMs)
  if (key === null || !holidays.includes(key)) return null
  const day = Math.floor((atMs + BEIJING_OFFSET_MS) / DAY_MS)
  return { start: day * DAY_MS - BEIJING_OFFSET_MS, end: (day + 1) * DAY_MS - BEIJING_OFFSET_MS, kind: 'holiday' }
}

/**
 * 周末全谷区间（北京日历日周六 00:00 起，至周一 00:00；起点不早于新规生效时刻）。
 * @returns {{ start: number, end: number, kind: 'weekend' } | null}
 */
export function weekendZoneAt(atMs, config = DEFAULT_OFFICIAL_PEAK) {
  const from = Date.parse(config?.weekendOffPeakFrom ?? '')
  if (!Number.isFinite(atMs) || !Number.isFinite(from) || atMs < from) return null
  const day = Math.floor((atMs + BEIJING_OFFSET_MS) / DAY_MS)
  const weekday = ((day + 4) % 7 + 7) % 7 // 1970-01-01 是周四；0=周日 … 6=周六
  if (weekday !== 6 && weekday !== 0) return null
  const saturday = weekday === 6 ? day : day - 1
  return {
    start: Math.max(saturday * DAY_MS - BEIJING_OFFSET_MS, from),
    end: (saturday + 2) * DAY_MS - BEIJING_OFFSET_MS,
    kind: 'weekend',
  }
}

/** 谷价区间 = 假期 ?? 周末（两者互斥取先命中的）。 */
export function offPeakZoneAt(atMs, config = DEFAULT_OFFICIAL_PEAK) {
  return holidayZoneAt(atMs, config) ?? weekendZoneAt(atMs, config)
}

/**
 * 该时刻是否处于官方高峰时段。
 *
 * 判定顺序（三层短路，缺一不可）：
 *   ① 假期/周末全谷 → 不是高峰
 *   ② 早于 `effectiveAt` → 不是高峰（新规不改写历史）
 *   ③ 落在某个窗口的 UTC 小时半开区间 `[start, end)` → 高峰
 *
 * @param {number} atMs 调用发起时刻（epoch ms）
 * @param {object} [config] officialPeak 配置
 */
export function isPeakHour(atMs, config = DEFAULT_OFFICIAL_PEAK) {
  if (!Number.isFinite(atMs)) return false
  if (config?.enabled === false) return false
  const windows = Array.isArray(config?.windows) ? config.windows : []
  if (windows.length === 0) return false
  if (offPeakZoneAt(atMs, config) !== null) return false
  const effectiveMs = Date.parse(config?.effectiveAt ?? '')
  if (Number.isFinite(effectiveMs) && atMs < effectiveMs) return false
  const hour = new Date(atMs).getUTCHours()
  return windows.some(window => {
    const start = finiteNumber(window?.start)
    const end = finiteNumber(window?.end)
    if (start === null || end === null || !Number.isInteger(start) || !Number.isInteger(end)) return false
    if (start < end) return hour >= start && hour < end
    return hour >= start || hour < end // 跨午夜窗口（官方配置不会出现，兼容处理）
  })
}

/** 峰谷状态的字符串键（含谷价原因），用于比较「状态是否真的翻转」。 */
function phaseKey(atMs, config) {
  const zone = offPeakZoneAt(atMs, config)
  return `${isPeakHour(atMs, config) ? 'peak' : 'off'}:${zone?.kind ?? '-'}`
}

/**
 * 通用切换点扫描：先按 15 分钟步长朝 direction 找状态翻转的区间，再在区间内二分，
 * 最后按整秒回扫取「第一个已翻转的整秒」。
 *
 * 窗口端点都是整秒（`HH:MM`），所以这个返回值就是精确的切换时刻；正反两个方向
 * 返回的是**同一个**时刻（状态翻转点本身），便于 UI 直接拿来做倒计时。
 */
function scanSwitch(atMs, key, direction = 1) {
  const original = key(atMs)
  let previous = atMs
  for (let step = 1; step * SWITCH_STEP_MS <= SWITCH_HORIZON_MS; step += 1) {
    const probe = atMs + direction * step * SWITCH_STEP_MS
    if (key(probe) === original) {
      previous = probe
      continue
    }
    // 保持不变量：key(before) !== key(after)，二分开区间夹住翻转点
    let before = Math.min(previous, probe)
    let after = Math.max(previous, probe)
    while (after - before > 1000) {
      const middle = Math.floor((before + after) / 2)
      if (key(middle) === key(before)) before = middle
      else after = middle
    }
    // 窗口端点都是整秒，按秒回扫取第一个「已翻转」的整秒 = 精确切换时刻
    for (let second = Math.floor(after / 1000) * 1000 - 2000; second <= after + 1000; second += 1000) {
      if (key(second) !== key(before)) return second
    }
    return after
  }
  return null
}

/**
 * 峰谷相位：当前是否高峰、谷价原因、以及前后两个切换时刻（供倒计时/进度条）。
 * `nextAtMs` 就是「这份档位算到什么时候为止」——计价本身不需要它，
 * 展示层的「下一个价格切换点」和站方快照的过期判断需要。
 */
export function phaseAt(atMs, config = DEFAULT_OFFICIAL_PEAK) {
  if (!Number.isFinite(atMs)) return null
  if (config?.enabled === false) return null
  const windows = Array.isArray(config?.windows) ? config.windows : []
  if (windows.length === 0) return null
  const holiday = holidayZoneAt(atMs, config)
  const weekend = weekendZoneAt(atMs, config)
  const key = candidate => phaseKey(candidate, config)
  const nextAtMs = scanSwitch(atMs, key, 1)
  const prevAtMs = scanSwitch(atMs, key, -1)
  return {
    atMs,
    inPeak: isPeakHour(atMs, config),
    zoneKind: holiday !== null ? 'holiday' : weekend !== null ? 'weekend' : null,
    prevAtMs,
    nextAtMs,
    nextIntoPeak: nextAtMs === null ? null : isPeakHour(nextAtMs, config),
  }
}

// ── 价表档位（官方峰谷 = 选列，不是因子） ────────────────────────────────
/**
 * 接下来 N 个档位切换点（侧栏「峰谷表」一键预览用）。
 *
 * 从当前时刻起反复向前 `scanSwitch`，每次跳过刚找到的那个切换点（+1s，避免原地打转），
 * 因此**不受单次扫描视界限制**：给多少 `limit` 就尽力给满多少个（最多 24 个）。
 * `inPeak: true` 表示「那一刻进入高峰」。工作日大约每天 4 个切换点，周末/法定假日
 * 期间很稀（全谷一直持续到区间结束，48 小时内可能只有 1 个）。
 *
 * @returns {Array<{ atMs: number, inPeak: boolean, zoneKind: string|null }>}
 */
export function upcomingSwitches(atMs = Date.now(), { limit = 6, config = DEFAULT_OFFICIAL_PEAK } = {}) {
  if (!Number.isFinite(atMs)) return []
  if (phaseAt(atMs, config) === null) return []
  const count = Math.max(1, Math.min(24, Math.trunc(Number(limit)) || 6))
  const key = candidate => phaseKey(candidate, config)
  const out = []
  let cursor = atMs
  for (let index = 0; index < count; index += 1) {
    const at = scanSwitch(cursor, key, 1)
    if (at === null) break
    out.push({
      atMs: at,
      inPeak: isPeakHour(at, config),
      zoneKind: holidayZoneAt(at, config) !== null ? 'holiday' : weekendZoneAt(at, config) !== null ? 'weekend' : null,
    })
    cursor = at + 1000
  }
  return out
}

/**
 * 价表条目（单位：`currency` / 1M tokens）。字段与含义：
 *
 * ```
 * {
 *   cacheMiss, cacheHit, output,          // 必填（input / cachedInput 作为别名接受）
 *   cacheWrite?, reasoning?, currency?,   // 可缺省：cacheWrite 缺省按命中价、reasoning 缺省 0
 *   offPeak?: {...}, peak?: {...},        // 峰谷两列（由 phaseAt 选一列覆盖）
 *   legacyBase?: {...},                   // 峰谷时代之前的基础价
 *   longContext?: { aboveInputTokens, cacheMiss, cacheHit, cacheWrite?, output, reasoning? },
 *   rateHistory?: [{ before, ...同上 }],  // 调价历史：取「当时生效」的那一档
 * }
 * ```
 */
export function normalizePriceEntry(entry) {
  if (!isPlainObject(entry)) return null
  const cacheMiss = firstNumber(entry.cacheMiss, entry.input)
  // 命中价缺省 = 未命中价（无缓存折扣的模型就写成两档简写 `{input, output}`）；
  // 未命中价与输出价缺失则**不给价**（宁可不显示，也不拿 0 顶替）。
  const cacheHit = firstNumber(entry.cacheHit, entry.cachedInput) ?? cacheMiss
  const output = firstNumber(entry.output)
  if (cacheMiss === null || cacheHit === null || output === null) return null
  const longContext = isPlainObject(entry.longContext) ? normalizeLongContext(entry.longContext) : null
  return {
    cacheMiss,
    cacheHit,
    output,
    cacheWrite: firstNumber(entry.cacheWrite),
    reasoning: firstNumber(entry.reasoning),
    currency: typeof entry.currency === 'string' ? entry.currency.toUpperCase() : null,
    longContext,
  }
}

/**
 * 长上下文档：只要求给「阈值 + 未命中输入价」，其余按补齐规则回落
 * （命中价缺省 = 未命中价；输出价缺省 = 沿用基础档）。这样 LiteLLM 那种
 * 「只公布超阈值输入价」的条目也能直接用。
 */
function normalizeLongContext(entry) {
  if (!isPlainObject(entry)) return null
  const aboveInputTokens = firstNumber(entry.aboveInputTokens)
  const cacheMiss = firstNumber(entry.cacheMiss, entry.input)
  if (aboveInputTokens === null || cacheMiss === null) return null
  const cacheHit = firstNumber(entry.cacheHit, entry.cachedInput) ?? cacheMiss
  const output = firstNumber(entry.output)
  const reasoning = firstNumber(entry.reasoning)
  return {
    aboveInputTokens,
    cacheMiss,
    cacheHit,
    cacheWrite: firstNumber(entry.cacheWrite),
    ...(output === null ? {} : { output }),
    ...(reasoning === null ? {} : { reasoning }),
  }
}

/**
 * 调价历史：取 `rateHistory` 中「当时生效」的那一档（`before` 是这一档的结束边界）。
 * 语义与官方控制台的调价公告一致：`atMs < before` 且是最早的未到期边界 → 用这一档。
 */
export function priceAt(entry, atMs) {
  if (!isPlainObject(entry) || !Number.isFinite(atMs) || !Array.isArray(entry.rateHistory)) return entry
  let chosen = null
  let boundary = Infinity
  for (const period of entry.rateHistory) {
    if (!isPlainObject(period)) continue
    const until = Date.parse(period.before)
    if (Number.isFinite(until) && atMs < until && until < boundary) {
      chosen = period
      boundary = until
    }
  }
  if (chosen === null) return entry
  const { before: _before, ...rates } = chosen
  return { ...entry, ...rates }
}

/**
 * 在某个时刻取官方单位价档位：调价历史 → 峰/谷列 → 峰谷时代之前的基础价。
 * 返回的是**单位价**（每 1M tokens），不是金额；金额由 costOf() 用真实 token 桶算。
 *
 * @param {object} entry 价表条目
 * @param {number} atMs 调用发起时刻
 * @param {object} [config] officialPeak 配置
 * @returns {object | null} null 表示缺必填单位价（未定价，不是 0）
 */
export function tierFor(entry, atMs, config = DEFAULT_OFFICIAL_PEAK) {
  if (!isPlainObject(entry)) return null
  const history = priceAt(entry, atMs)
  const phase = phaseAt(atMs, config)
  let tier = history
  // source 标的是「这一档实际来自哪一列」，用于界面/审计：没有峰谷两列的条目就是 flat。
  let source = 'flat'
  if (phase?.inPeak === true && isPlainObject(history.peak)) {
    tier = { ...history, ...history.peak }
    source = 'peak'
  } else if (phase?.inPeak === false && isPlainObject(history.offPeak)) {
    tier = { ...history, ...history.offPeak }
    source = 'off-peak'
  }
  const legacyMs = Date.parse(config?.legacyBoundary ?? '')
  if (Number.isFinite(legacyMs) && atMs < legacyMs && isPlainObject(history.legacyBase)) {
    tier = { ...history, ...history.legacyBase }
    source = 'legacy'
  }
  const unit = normalizePriceEntry(tier)
  if (unit === null) return null
  return { ...unit, source, phase }
}

/**
 * 用真实 token 桶算金额（未折算币种、未乘倍率）。
 *
 * 桶是**互斥**的：`input` 是未缓存输入，不含 `cacheRead`/`cacheWrite`；所以必须传
 * 单次调用的桶，聚合后再算无法还原每次请求的上下文档位（长上下文档尤其明显）。
 */
export function costOf(buckets, tier) {
  if (!isPlainObject(tier)) return null
  const input = count(buckets?.input)
  const output = count(buckets?.output)
  const cacheRead = count(buckets?.cacheRead)
  const cacheWrite = count(buckets?.cacheWrite)
  const reasoning = count(buckets?.reasoning)
  let used = tier
  if (tier.longContext && input + cacheRead + cacheWrite > tier.longContext.aboveInputTokens) {
    used = { ...tier, ...tier.longContext }
  }
  const cacheMiss = finiteNumber(used.cacheMiss)
  const cacheHit = finiteNumber(used.cacheHit)
  const outputPrice = finiteNumber(used.output)
  if (cacheMiss === null || cacheHit === null || outputPrice === null) return null
  const cacheWritePrice = finiteNumber(used.cacheWrite) ?? cacheHit
  const reasoningPrice = finiteNumber(used.reasoning) ?? 0
  const weighted = input * cacheMiss
    + output * outputPrice
    + cacheRead * cacheHit
    + cacheWrite * cacheWritePrice
    + reasoning * reasoningPrice
  const cost = weighted / 1_000_000
  return Number.isFinite(cost) ? cost : null
}

// ── 站方（Sub2Api）倍率：快照 + 本地复算峰谷因子 ─────────────────────────

/** `HH:MM` → 当日分钟数；非法返回 null。 */
export function minutesOfDay(value) {
  if (typeof value !== 'string') return null
  const matched = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (matched === null) return null
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (hour > 24 || minute > 59) return null
  return hour * 60 + minute
}

/**
 * 指定 IANA 时区下的当日分钟数（用 `Intl`，Node 内建，不引依赖）。
 * @returns {number | null} 时区名缺失/非法时返回 null（调用方按安全值降级）。
 */
export function wallClockMinutes(timeZone, atMs) {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || !Number.isFinite(atMs)) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(atMs))
    const hour = Number(parts.find(part => part.type === 'hour')?.value)
    const minute = Number(parts.find(part => part.type === 'minute')?.value)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
    return (hour % 24) * 60 + minute // hour12:false 在个别环境给 "24"，取模归一
  } catch {
    return null // 非法时区名
  }
}

/**
 * 站方峰谷因子。语义与 sub2api `PeakMultiplierAt` 对齐：
 *   - 未启用 → 1
 *   - 窗口按站方 `timezone` 判定（左闭右开），跨天配置非法 → 1（站方自己也会拒绝）
 *   - 时区缺失/非法 → 1（安全降级）
 *   - `multiplier = 0` 合法（高峰免费/折扣）
 */
export function relayPeakFactor(peak, atMs) {
  if (!isPlainObject(peak) || peak.enabled !== true) return 1
  const start = minutesOfDay(peak.start)
  const end = minutesOfDay(peak.end)
  if (start === null || end === null || start === end || end <= start) return 1
  const minutes = wallClockMinutes(peak.timezone, atMs)
  if (minutes === null) return 1
  if (!(minutes >= start && minutes < end)) return 1
  return finiteNumber(peak.multiplier) ?? 1
}

/**
 * 解析某一时刻的站方生效倍率。
 *
 * 公式（站方源码口径）：`effective = resolved × applied_peak_multiplier`，
 * `resolved = 用户专属覆盖 ?? 分组倍率`。所以这里用**本地复算**的峰谷因子，
 * 而不是快照里那个「此刻」的 `applied` —— 历史调用要用它所在时刻的因子。
 *
 * @param {object} snapshot `probeSub2Api()` 的结果，或直接传 `billing`
 * @param {number} atMs 调用发起时刻
 * @returns {{ value: number, basis: 'snapshot' | 'local-peak', applied: number,
 *             peak: boolean, observedAt: string | null, switchAt: number | null } | null}
 *          null 表示拿不到倍率（界面应显示 `—`，不要按 1 处理）
 */
export function resolveProviderRate(snapshot, atMs = Date.now()) {
  const billing = isPlainObject(snapshot?.billing) ? snapshot.billing : snapshot
  if (!isPlainObject(billing)) return null
  const resolved = firstNumber(billing.userRate, billing.resolvedRate, billing.groupRate)
  const observedAt = typeof billing.observedAt === 'string' ? billing.observedAt : null
  if (resolved === null) {
    const effective = firstNumber(billing.effectiveRate)
    if (effective === null) return null
    return { value: effective, basis: 'snapshot', applied: 1, peak: false, observedAt, switchAt: null }
  }
  const peak = isPlainObject(billing.peak) ? billing.peak : null
  if (peak === null || peak.enabled !== true) {
    return { value: resolved, basis: 'snapshot', applied: 1, peak: false, observedAt, switchAt: null }
  }
  const applied = relayPeakFactor(peak, atMs)
  return {
    value: resolved * applied,
    basis: 'local-peak',
    applied,
    peak: true,
    observedAt,
    switchAt: nextRelaySwitchAt(peak, atMs),
  }
}

/** 站方窗口的下一个切换时刻（本地算，用于判断快照何时必须重取）。 */
export function nextRelaySwitchAt(peak, atMs) {
  if (!isPlainObject(peak) || peak.enabled !== true) return null
  if (!Number.isFinite(atMs)) return null
  return scanSwitch(atMs, candidate => relayPeakFactor(peak, candidate), 1)
}

// ── 积分倍率型站（credits）：按模型静态 ──────────────────────────────────

/** `"x0.79"` / `"0.79"` / `0.79` → 0.79；脏值 → null。 */
export function parseCredits(value) {
  const number = finiteNumber(value)
  if (number !== null) return number
  if (typeof value !== 'string') return null
  const matched = value.trim().match(/^[x×]\s*([0-9]*\.?[0-9]+)$/i)
  return matched === null ? null : Number(matched[1])
}

/** 模型 id 归一：去空白、小写。 */
export function normalizeModelId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** 去掉命名空间前缀（`cn:deepseek-v4.1-flash` → `deepseek-v4.1-flash`）。 */
export function stripIdNamespace(value) {
  const id = normalizeModelId(value)
  const at = id.lastIndexOf(':')
  return at > 0 && at < id.length - 1 ? id.slice(at + 1) : id
}

/**
 * 从 `/v1/models` 清单里取该模型的 `credits`（积分倍率）。
 * 精确 id 优先，其次忽略命名空间前缀（`cn:` / `openai:` 之类）。
 */
export function creditsOf(models, modelId) {
  const list = Array.isArray(models) ? models : []
  const wanted = normalizeModelId(modelId)
  if (wanted.length === 0) return null
  const bare = stripIdNamespace(wanted)
  let fallback = null
  for (const item of list) {
    const id = normalizeModelId(item?.id)
    if (id.length === 0) continue
    const credits = parseCredits(item?.credits)
    if (credits === null) continue
    if (id === wanted) return credits
    if (fallback === null && stripIdNamespace(id) === bare) fallback = credits
  }
  return fallback
}

/**
 * 积分型站的**相对量**：加权 token 数 × credits。
 * 该类型站没有余额/用量接口，「官方价」也无从获得，所以只能产出相对量；
 * 换算出货币需要站点未公开的基准价，本模块**不猜**。
 */
export function creditsWeight(buckets, credits) {
  const value = finiteNumber(credits) ?? 1
  const tokens = count(buckets?.input) + count(buckets?.cacheRead)
    + count(buckets?.cacheWrite) + count(buckets?.output) + count(buckets?.reasoning)
  return tokens * value
}

// ── 价表查找 ─────────────────────────────────────────────────────────────

/**
 * 在价表里找模型的条目。
 * 查找顺序：精确 id → 忽略命名空间 → `table.aliases`（显式别名表，值为价表内的键）。
 * `table` 既可以是 `{ models: {...}, aliases }`，也可以直接是 `{ '<id>': entry }`。
 */
export function findPriceEntry(table, modelId) {
  return findPriceEntryDetailed(table, modelId)?.entry ?? null
}

/** 聚合渠道目录：可以命中，但排在自营厂商之后（避免被聚合价顶掉厂商价）。 */
export const AGGREGATOR_VENDORS = ['openrouter', 'opencode-go']

/**
 * 价格来源等级。**默认按官方价 + 站方口径价计价**：
 *   - `official` 厂商自有文档域（由 `research/import-price-table.mjs` 的白名单判定）
 *   - `station`  **站方口径价**：Sub2Api / LiteLLM 价目（中转站就是用它算钱的）
 *   - `manual`   你手工填的（state.json 的 priceTable / aliases 里的条目，或缺 `source` 字段）
 *   - `reseller` 转售商挂牌价（opencode.ai 这类；含加价/促销，档位也可能不同）
 *   - `aggregator` 聚合目录价（openrouter.ai；还有 `:batch`/`:free` 变体）
 *   - `unknown`  没有来源可判
 *
 * 为什么默认排除 reseller/aggregator：那两类都不是厂商或站方口径的价（实测 15 家
 * 「厂商目录」里 65% 指向转售商），拿它当官方价会系统性算偏，而且看不出来。
 */
export const PRICE_SOURCES = ['official', 'station', 'manual', 'reseller', 'aggregator', 'unknown']
export const DEFAULT_PRICE_SOURCES = ['official', 'station', 'manual']

/** 条目来源等级：显式 `source` 不在枚举里、或没有 `source` 字段 → 视为手工填写。 */
export function entrySource(entry) {
  const source = entry?.source
  return typeof source === 'string' && PRICE_SOURCES.includes(source) ? source : 'manual'
}

/**
 * 跨命名体系的规范化：小写、`.`/`_` 一律写成 `-`（`claude-opus-4.6` ↔ `claude-opus-4-6`）。
 * 只用于「找不到精确键时的第二次匹配」，不参与任何计算。
 */
export function canonModelId(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[._]+/g, '-').replace(/-{2,}/g, '-')
    : ''
}

/** `vendor/model` 结构的尾名（`x-ai/grok-4.7` → `grok-4.7`）。 */
export function tailModelId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  const at = id.lastIndexOf('/')
  return at >= 0 ? id.slice(at + 1) : id
}

/**
 * 带**出处**的查找：返回命中的厂商目录、键与匹配方式（供界面/审计显示「这个单价是按谁家的」）。
 *
 * 顺序（前面优先）：
 *   ① 明确给了 `vendor` → 该厂商目录（精确 → 规范化）
 *   ② `table.models`（DeepSeek 主表：精确 → 规范化）
 *   ③ `table.aliases`（显式别名；值可为 `vendor:key` 或 `key`）
 *   ④ 各厂商目录，**自营厂商优先、聚合渠道（openrouter / opencode-go）最后**：精确 → 规范化
 *   ⑤ `vendor/model` 尾名匹配（同一个模型在不同聚合商下写法不同时兜底）
 *
 * 命中即返回第一个结果：供应商目录之间可能重复同名模型（如 `gpt-5.6-sol` 同时在 openai
 * 与 opencode-go），此时按上面的顺序取，并在返回值里给出 `vendor`，
 * **不做静默的跨厂商模糊匹配**（那会把 A 家的价套到 B 家上）。
 *
 * @returns {{ entry: object, vendor: string, key: string, matchedBy: string } | null}
 */
export function findPriceEntryDetailed(table, modelId, { vendor = null, allowSources = DEFAULT_PRICE_SOURCES } = {}) {
  if (!isPlainObject(table)) return null
  const wanted = normalizeModelId(modelId)
  if (wanted.length === 0) return null
  const models = isPlainObject(table.models) ? table.models : null
  const providers = isPlainObject(table.providers) ? table.providers : null
  const bare = stripIdNamespace(wanted)
  const wantedCanon = canonModelId(bare)
  const allowed = Array.isArray(allowSources) && allowSources.length > 0 ? allowSources : DEFAULT_PRICE_SOURCES
  const isAllowed = entry => allowed.includes(entrySource(entry))

  const scan = (catalog, catalogVendor) => {
    if (!isPlainObject(catalog)) return null
    // 来源被排除的条目连键都不参与匹配：不让「转售价」顶掉「没有官方价」这个事实。
    const keys = Object.keys(catalog).filter(key => isAllowed(catalog[key]))
    const exact = keys.find(key => normalizeModelId(key) === wanted || normalizeModelId(key) === bare)
    if (exact !== undefined) return { entry: catalog[exact], vendor: catalogVendor, key: exact, matchedBy: 'exact', source: entrySource(catalog[exact]) }
    const canonical = keys.find(key => canonModelId(stripIdNamespace(key)) === wantedCanon)
    if (canonical !== undefined) return { entry: catalog[canonical], vendor: catalogVendor, key: canonical, matchedBy: 'canonical', source: entrySource(catalog[canonical]) }
    return null
  }

  // ① 明确的厂商提示
  if (typeof vendor === 'string' && vendor.length > 0 && providers !== null) {
    const hit = scan(providers[normalizeModelId(vendor)], normalizeModelId(vendor))
    if (hit !== null) return hit
  }
  // ② DeepSeek 主表（也支持「直接就是一张 id→条目 的表」这种简写）
  const mainTable = models ?? (providers === null && isPlainObject(table) ? table : null)
  if (mainTable !== null) {
    const hit = scan(mainTable, models === null ? 'inline' : 'deepseek')
    if (hit !== null) return hit
  }
  // ③ 显式别名
  const aliases = isPlainObject(table.aliases) ? table.aliases : null
  const aliasTarget = aliases === null ? undefined : (aliases[wanted] ?? aliases[bare])
  if (typeof aliasTarget === 'string' && aliasTarget.length > 0) {
    const colon = aliasTarget.indexOf(':')
    if (colon > 0 && providers !== null) {
      const hit = scan(providers[normalizeModelId(aliasTarget.slice(0, colon))], normalizeModelId(aliasTarget.slice(0, colon)))
      if (hit !== null) return { ...hit, matchedBy: 'alias' }
    }
    if (mainTable !== null && Object.hasOwn(mainTable, aliasTarget)) {
      return { entry: mainTable[aliasTarget], vendor: models === null ? 'inline' : 'deepseek', key: aliasTarget, matchedBy: 'alias' }
    }
  }
  // ④ 厂商目录（自营优先）
  if (providers !== null) {
    const vendors = Object.keys(providers)
    const ordered = [
      ...vendors.filter(name => !AGGREGATOR_VENDORS.includes(name)),
      ...vendors.filter(name => AGGREGATOR_VENDORS.includes(name)),
    ]
    for (const name of ordered) {
      const hit = scan(providers[name], name)
      if (hit !== null) return hit
    }
  }
  // ⑤ `vendor/model` 尾名兜底
  if (providers !== null) {
    const tail = canonModelId(tailModelId(bare))
    if (tail.length > 0) {
      for (const name of Object.keys(providers)) {
        const catalog = providers[name]
        if (!isPlainObject(catalog)) continue
        const key = Object.keys(catalog).find(candidate => canonModelId(tailModelId(candidate)) === tail && isAllowed(catalog[candidate]))
        if (key !== undefined) return { entry: catalog[key], vendor: name, key, matchedBy: 'tail', source: entrySource(catalog[key]) }
      }
    }
  }
  return null
}

/** 价表里有哪些厂商目录（供界面列清单 / 调试）。 */
export function catalogVendors(table) {
  const providers = isPlainObject(table?.providers) ? table.providers : null
  return providers === null ? [] : Object.keys(providers)
}

// ── 统一入口 ─────────────────────────────────────────────────────────────

/**
 * 解析一次调用要用到的全部档位信息（**不产生金额**，便于 UI 分开展示「倍率 / 相位 / 是否已定价」）。
 *
 * @param {object} input
 * @param {string} [input.provider] provider id
 * @param {string} [input.model] 请求模型 id
 * @param {number} [input.atMs] 调用发起时刻（默认 now；必须传请求发起时刻，不是完成时刻）
 * @param {object} [input.snapshot] `probeSub2Api()` 结果（拿站方倍率与 credits 清单）
 * @param {object} [input.priceTable] 官方价表（缺省 = 没有官方价表 → 未定价）
 * @param {object} [input.officialPeak] officialPeak 配置（默认 DEFAULT_OFFICIAL_PEAK）
 * @param {number} [input.credits] 直接给积分倍率（覆盖从 models 推断）
 */
export function resolveTier({
  provider = null,
  model = null,
  atMs = Date.now(),
  snapshot = null,
  priceTable = null,
  vendorHint = null,
  allowSources = DEFAULT_PRICE_SOURCES,
  officialPeak = DEFAULT_OFFICIAL_PEAK,
  credits,
} = {}) {
  const rate = resolveProviderRate(snapshot, atMs)
  const sources = Array.isArray(allowSources) && allowSources.length > 0 ? allowSources : DEFAULT_PRICE_SOURCES
  const hit = findPriceEntryDetailed(priceTable, model, { vendor: vendorHint, allowSources: sources })
  const tier = hit === null ? null : tierFor(hit.entry, atMs, officialPeak)
  const phase = phaseAt(atMs, officialPeak)
  const creditValue = credits === undefined ? creditsOf(snapshot?.models, model) : credits
  const priced = tier !== null
  // 只在「被来源策略挡掉」时才多查一次：用于把「没有价格」和「有价但不是官方来源」分开报。
  const blocked = !priced && priceTable !== null && hit === null
    ? findPriceEntryDetailed(priceTable, model, { vendor: vendorHint, allowSources: PRICE_SOURCES })
    : null
  return {
    provider,
    model,
    atMs,
    tier,
    phase,
    rate,
    credits: finiteNumber(creditValue),
    priced,
    /** 命中出处：界面显示「单价来自谁家、是不是官方来源」，审计用（未命中为 null）。 */
    priceSource: hit === null ? null : {
      vendor: hit.vendor,
      key: hit.key,
      matchedBy: hit.matchedBy,
      source: hit.source,
      sourceUrl: typeof hit.entry?.sourceUrl === 'string' ? hit.entry.sourceUrl : null,
      checkedAt: typeof hit.entry?.checkedAt === 'string' ? hit.entry.checkedAt : null,
      note: typeof hit.entry?.notes === 'string' ? hit.entry.notes : null,
    },
    /** 仅当「有价目条目、但来源等级被策略排除」时给出，供界面提示（如「只有转售价」）。 */
    blockedSource: blocked === null ? null : { vendor: blocked.vendor, key: blocked.key, source: blocked.source },
    /** 未定价时给界面用的原因（不要把未定价画成 ¥0）。 */
    reason: priced
      ? null
      : priceTable === null
        ? 'no-price-table'
        : hit !== null
          ? 'incomplete-price-entry'
          : blocked !== null ? 'blocked-source' : 'model-not-in-table',
    /** 该时刻的档位摘要：峰/谷、站方窗口下个切换点、快照观测时刻。 */
    switches: { officialNextAtMs: phase?.nextAtMs ?? null, relayNextAtMs: rate?.switchAt ?? null },
  }
}

/**
 * 算一次调用的金额（三层相乘）。
 *
 * @returns {{ cost: number | null, usd: number | null, basis: string, parts: object }}
 *          `cost === null` 表示**未定价**（缺单位价），不是 0。
 */
export function priceCall({
  buckets = null,
  tier = null,
  rate = null,
  credits = null,
  currency = null,
  exchangeRate = null,
} = {}) {
  const base = costOf(buckets, tier)
  if (base === null) return { cost: null, usd: null, basis: 'unpriced', parts: { base: null } }
  const rateValue = finiteNumber(rate?.value) ?? 1
  const creditValue = finiteNumber(credits) ?? 1
  const cost = base * rateValue * creditValue
  const unitCurrency = (typeof currency === 'string' && currency.length > 0
    ? currency
    : tier?.currency ?? 'USD').toUpperCase()
  const basis = [
    tier?.source ?? 'flat',
    rate?.basis ?? null,
    creditValue !== 1 ? 'credits' : null,
  ].filter(part => part !== null).join('×')
  return {
    cost,
    usd: toUsd(cost, unitCurrency, exchangeRate),
    basis,
    parts: { base, rate: rateValue, credits: creditValue, currency: unitCurrency },
  }
}

/**
 * 币种归一为美元：`CNY` 价表按展示汇率除算（汇率非法按 1，避免 NaN 污染账本）。
 * 账本恒以美元存储，展示时再乘回汇率 —— 这样换展示币种不改历史金额。
 */
export function toUsd(amount, currency, exchangeRate) {
  const value = finiteNumber(amount)
  if (value === null) return null
  const code = typeof currency === 'string' ? currency.toUpperCase() : 'USD'
  if (code !== 'CNY') return value
  const rate = finiteNumber(exchangeRate)
  return value / (rate !== null && rate > 0 ? rate : 1)
}

// ── 历史不可改写：入账时冻结依据 ─────────────────────────────────────────

/**
 * **硬规定：价格依据的任何变更都不重算历史，只影响之后的调用。**
 *
 * 为什么必须这样：
 *   - 重算历史的口径会让「昨天看到的金额」今天变样，用户无法对账；而且它要求回放
 *     会话日志，覆盖不全的会话只能跳过，反而造成两套口径并存。
 *   - 这里选择**入账即固化**：调用发起那一刻的单价、倍率、credits 与结果一起写进
 *     记录，之后读历史只做加总 —— **结构上不存在**「拿当前表重算旧记录」的代码路径。
 *
 * 代价与对策：历史里可能留着按旧依据算出的金额。对策是给每条记录打 `basisId`
 * （价表 + 峰谷配置 + 汇率/币种的指纹），换依据后新记录自然带新 id，界面可以按 id
 * 分组显示「这批是按哪版依据算的」，而不是偷偷改写它们。
 */

/** 稳定序列化：对象键排序、忽略 undefined（供指纹使用，不是通用 JSON 工具）。 */
export function stableStringify(value, depth = 0) {
  if (depth > 12) return '"[deep]"'
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? 'null' : encoded
  }
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item, depth + 1)).join(',')}]`
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key], depth + 1)}`).join(',')}}`
}

function fnv1aHex(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 当前计价依据的指纹（价表 + 来源等级策略 + 官方峰谷配置 + 币种/汇率）。
 *
 * 用途只有一个：**标注**每条记录是按哪版依据算的，以及判断「现在是否该开新一批」。
 * 它**不用于**、也不得用于触发历史重算。
 *
 * @returns {string} 形如 `p1-3f2a1b9c`；不可序列化时返回 `p1-unknown`
 */
export function pricingFingerprint({
  priceTable = null,
  priceSources = null,
  officialPeak = null,
  exchangeRate = null,
  pricingCurrency = null,
} = {}) {
  try {
    const payload = stableStringify({ priceTable, priceSources, officialPeak, exchangeRate, pricingCurrency })
    return `p1-${fnv1aHex(payload)}`
  } catch {
    return 'p1-unknown'
  }
}

/** 会话命中率：`cacheRead / (input + cacheRead + cacheWrite)`，与宿主 stock 口径一致。 */
export function cacheHitRate(buckets) {
  const denominator = count(buckets?.input) + count(buckets?.cacheRead) + count(buckets?.cacheWrite)
  if (denominator <= 0) return null
  return count(buckets?.cacheRead) / denominator
}

/**
 * 生成一条**冻结依据**的调用记录：把入账当时的单价、倍率、credits、结果与依据指纹
 * 一起存下来。之后无论价表/倍率/配置怎么变，这条记录都读得回来，也不需要重算。
 *
 * @param {object} input
 * @param {number} input.atMs 调用发起时刻
 * @param {string} [input.provider] provider id
 * @param {string} [input.model] 调用的模型 id（按响应/实际路由，不是请求里写的那个）
 * @param {object} input.buckets 五桶 token
 * @param {object} [input.resolved] `resolveTier()` 的结果（提供单价/倍率/credits）
 * @param {object} [input.call] 已算好的 `priceCall()` 结果（省略则按 resolved 现算）
 * @param {string} [input.basisId] `pricingFingerprint()` 的结果
 * @param {number} [input.exchangeRate] 币种折算汇率
 */
export function makeCallRecord({
  atMs = null,
  provider = null,
  model = null,
  sessionId = null,
  buckets = null,
  resolved = null,
  call = null,
  basisId = null,
  exchangeRate = null,
} = {}) {
  const tier = resolved?.tier ?? null
  const rate = resolved?.rate ?? null
  const credits = finiteNumber(resolved?.credits)
  const priced = call ?? priceCall({
    buckets,
    tier,
    rate,
    credits,
    currency: tier?.currency ?? null,
    exchangeRate,
  })
  return {
    atMs: Number.isFinite(atMs) ? atMs : null,
    provider,
    model,
    /** 会话 id：设置页的「今日会话」明细要按它分组（老记录可能没有）。 */
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
    buckets: {
      input: count(buckets?.input),
      output: count(buckets?.output),
      cacheRead: count(buckets?.cacheRead),
      cacheWrite: count(buckets?.cacheWrite),
      reasoning: count(buckets?.reasoning),
    },
    /** 入账当时的单价快照（每 1M tokens，未乘倍率）。 */
    unit: tier === null ? null : {
      cacheMiss: tier.cacheMiss,
      cacheHit: tier.cacheHit,
      cacheWrite: tier.cacheWrite,
      output: tier.output,
      reasoning: tier.reasoning,
      source: tier.source ?? null,
    },
    /** 入账当时的倍率快照。 */
    rate: rate === null ? null : { value: rate.value, basis: rate.basis, applied: rate.applied ?? 1 },
    credits,
    cost: priced.cost,
    usd: priced.usd,
    currency: priced.parts?.currency ?? null,
    basis: priced.basis,
    basisId: typeof basisId === 'string' && basisId.length > 0 ? basisId : null,
  }
}

/**
 * 读历史：**只做加总** —— 不接受价表，也不接触任何当前配置。
 *
 * 未定价（`cost === null`）的记录 token 照计、金额不计入；全部未定价时 `cost` 为
 * `null`（不是 0），界面据此显示 `—`。
 */
export function summarizeRecords(records) {
  const list = Array.isArray(records) ? records.filter(row => isPlainObject(row)) : []
  const buckets = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  let cost = null
  let usd = null
  let priced = 0
  const basisIds = new Set()
  for (const row of list) {
    for (const key of Object.keys(buckets)) buckets[key] += count(row.buckets?.[key])
    const value = finiteNumber(row.cost)
    if (value === null) continue // 未定价：token 计数保留，金额不计
    priced += 1
    cost = (cost ?? 0) + value
    usd = (usd ?? 0) + (finiteNumber(row.usd) ?? value)
    if (typeof row.basisId === 'string' && row.basisId.length > 0) basisIds.add(row.basisId)
  }
  return {
    calls: list.length,
    priced,
    unpriced: list.length - priced,
    buckets,
    hitRate: cacheHitRate(buckets),
    cost,
    usd,
    basisIds: [...basisIds].sort(),
  }
}
