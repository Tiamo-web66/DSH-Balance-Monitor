/**
 * 用量账本 + 侧栏数据聚合（纯函数，零依赖，可独立测试）。
 *
 * 这是「今日花了多少」的唯一数据源：宿主包裹 `llm/stream` 捕获每次调用的 usage，
 * 用 lib/pricing.js 在**调用时刻**算出金额（官方价 × 站方倍率 × credits）后落成一条
 * 记录；之后只做加总 —— 依据变更不重算历史（见 pricing.js 文末的硬规定）。
 *
 * 记录里同时留下当时的单价/倍率/依据指纹，所以侧栏能按供应商切换、按依据分组、
 * 把「未定价」与「0 元」分开显示。
 */
import { cacheHitRate, summarizeRecords } from './pricing.js'

export const LEDGER_VERSION = 2
/** 账本保留天数（侧栏只看今日；留几天是为了按日曲线与排错）。 */
export const LEDGER_KEEP_DAYS = 7
/** 单日记录条数上限：一天几百次调用很正常，超过这个数说明有异常循环，丢最旧的。 */
const MAX_RECORDS_PER_DAY = 20_000

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * 本地日历日的 `YYYY-MM-DD`（宿主与浏览器在同一台机器，用本地时区才与用户说的「今日」一致）。
 */
export function dayKey(atMs = Date.now()) {
  const date = new Date(Number.isFinite(atMs) ? atMs : Date.now())
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 空账本。 */
export function createLedger() {
  return { version: LEDGER_VERSION, days: {} }
}

/**
 * 读盘时的净化：只认自己写得出的结构，坏数据丢弃而不是让插件起不来。
 */
export function normalizeLedger(parsed) {
  const ledger = createLedger()
  const days = parsed?.days
  if (days === null || typeof days !== 'object' || Array.isArray(days)) return ledger
  for (const [date, day] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (day === null || typeof day !== 'object' || !Array.isArray(day.records)) continue
    const records = day.records.filter(row => row !== null && typeof row === 'object' && Number.isFinite(Number(row.atMs)))
    if (records.length === 0) continue
    ledger.days[date] = { date, records }
  }
  return ledger
}

/** 记一条调用（调用方已用 makeCallRecord 冻结好依据）。 */
export function appendRecord(ledger, record) {
  if (ledger === null || typeof ledger !== 'object' || record === null || typeof record !== 'object') return false
  const atMs = Number(record.atMs)
  if (!Number.isFinite(atMs)) return false
  const date = dayKey(atMs)
  const day = ledger.days[date] ?? (ledger.days[date] = { date, records: [] })
  if (!Array.isArray(day.records)) day.records = []
  day.records.push(record)
  if (day.records.length > MAX_RECORDS_PER_DAY) day.records.splice(0, day.records.length - MAX_RECORDS_PER_DAY)
  return true
}

/** 按保留天数裁剪（`nowMs` 可注入，便于测试）。 */
export function pruneLedger(ledger, { keepDays = LEDGER_KEEP_DAYS, nowMs = Date.now() } = {}) {
  if (ledger === null || typeof ledger !== 'object' || ledger.days === null || typeof ledger.days !== 'object') return 0
  const keep = Math.max(1, Math.min(3650, Math.floor(Number(keepDays) || LEDGER_KEEP_DAYS)))
  const keys = Object.keys(ledger.days).sort()
  let removed = 0
  while (keys.length > keep) {
    const oldest = keys.shift()
    delete ledger.days[oldest]
    removed += 1
  }
  // 未来日期的脏记录（时钟回拨）不删，但不参与「今日」；这里只裁旧日。
  void nowMs
  return removed
}

export function dayRecords(ledger, date = dayKey()) {
  const day = ledger?.days?.[date]
  return Array.isArray(day?.records) ? day.records : []
}

/** 把一组记录聚成「金额 / token 桶 / 命中率 / 未定价条数」。 */
export function summarizeGroup(records) {
  const summary = summarizeRecords(records)
  return {
    calls: summary.calls,
    priced: summary.priced,
    unpriced: summary.unpriced,
    cost: summary.cost,
    usd: summary.usd,
    buckets: summary.buckets,
    tokens: Object.values(summary.buckets).reduce((sum, value) => sum + value, 0),
    hitRate: summary.hitRate,
    basisIds: summary.basisIds,
  }
}

/**
 * 一天的汇总：`total` 是**所有供应商之和**，`providers` 是可按供应商切换的明细。
 * 金额是「官方价 × 站方倍率 × credits」之后的价格（记录里已固化），不是官方原价。
 */
export function summarizeDay(ledger, date = dayKey()) {
  const records = dayRecords(ledger, date)
  const grouped = new Map()
  for (const record of records) {
    const provider = typeof record.provider === 'string' && record.provider.length > 0 ? record.provider : 'unknown'
    const list = grouped.get(provider)
    if (list === undefined) grouped.set(provider, [record])
    else list.push(record)
  }
  const providers = [...grouped.entries()]
    .map(([provider, rows]) => {
      const summary = summarizeGroup(rows)
      const models = new Map()
      for (const row of rows) {
        const model = typeof row.model === 'string' && row.model.length > 0 ? row.model : 'unknown'
        models.set(model, (models.get(model) ?? 0) + (Number.isFinite(Number(row.usd)) ? Number(row.usd) : 0))
      }
      return {
        provider,
        ...summary,
        models: [...models.entries()]
          .map(([model, usd]) => ({ model, usd }))
          .sort((left, right) => right.usd - left.usd),
      }
    })
    .sort((left, right) => (right.usd ?? 0) - (left.usd ?? 0) || left.provider.localeCompare(right.provider))
  return { date, ...summarizeGroup(records), providers }
}

/**
 * 重复计费闸门：包装路由（在一个监听器体内再发起上游 stream）会让**同一次调用**
 * 到达两次，两次 usage 逐位相同。
 *
 * 与参照实现的差别：这里不做包装层 provider id 的重挂，只按
 * `(会话, 模型, 五桶指纹)` 在时间窗内互斥 —— 同一会话里指纹完全相同的两次真实调用
 * 在 10 秒内极少见，而包装重复必然同指纹同窗口。
 */
export function createUsageDeduper({ windowMs = 10_000, maxSessions = 64, maxEntries = 256 } = {}) {
  const sessions = new Map()
  const fingerprint = (model, buckets) => [
    typeof model === 'string' ? model : '',
    count(buckets?.input),
    count(buckets?.output),
    count(buckets?.cacheRead),
    count(buckets?.cacheWrite),
    count(buckets?.reasoning),
  ].join('|')
  const sweep = (entry, now) => {
    for (const [key, at] of entry.seen) {
      if (now - at > windowMs) entry.seen.delete(key)
    }
  }
  return {
    /**
     * @returns {boolean} true = 该记账，false = 判定为重复样本，丢弃
     */
    admit(sessionId, model, buckets, atMs = Date.now()) {
      const now = Number.isFinite(atMs) ? atMs : Date.now()
      const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : ''
      let entry = sessions.get(key)
      if (entry === undefined) {
        // 容量护栏：按最后活动时间淘汰最旧会话，避免长跑进程无限增长。
        if (sessions.size >= maxSessions) {
          let oldestKey = null
          let oldestAt = Infinity
          for (const [candidate, value] of sessions) {
            if (value.lastAt < oldestAt) {
              oldestAt = value.lastAt
              oldestKey = candidate
            }
          }
          if (oldestKey !== null) sessions.delete(oldestKey)
        }
        entry = { seen: new Map(), lastAt: now }
        sessions.set(key, entry)
      }
      entry.lastAt = now
      sweep(entry, now)
      const print = fingerprint(model, buckets)
      if (entry.seen.has(print)) return false
      entry.seen.set(print, now)
      if (entry.seen.size > maxEntries) {
        let oldestPrint = null
        let oldestAt = Infinity
        for (const [candidate, at] of entry.seen) {
          if (at < oldestAt) {
            oldestAt = at
            oldestPrint = candidate
          }
        }
        if (oldestPrint !== null) entry.seen.delete(oldestPrint)
      }
      return true
    },
    /** 调试/测试用：当前跟踪的会话数。 */
    size() {
      return sessions.size
    },
  }
}

/** 显示币种配置（与参照实现同名的四个字段）。 */
export const DEFAULT_DISPLAY = { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2 }

/** 美元金额 → 展示币种金额（USD 直出；CNY 乘汇率，汇率非法按 1）。`null` 原样返回 —— 未定价不是 0。 */export function toDisplay(usd, display = DEFAULT_DISPLAY) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return null
  const code = typeof display?.currency === 'string' ? display.currency.toUpperCase() : 'CNY'
  if (code !== 'CNY') return usd
  const rate = Number(display?.exchangeRate)
  return usd * (Number.isFinite(rate) && rate > 0 ? rate : 1)
}

/** 倒计时文案：`5 小时 3 分` / `3 分钟` / `<1 分钟`。 */
export function formatCountdown(ms, locale = 'zh') {
  const zh = String(locale).toLowerCase().startsWith('zh')
  const total = Number(ms)
  if (!Number.isFinite(total) || total <= 0) return zh ? '<1 分钟' : '<1 min'
  const minutes = Math.floor(total / 60_000)
  if (minutes < 1) return zh ? '<1 分钟' : '<1 min'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours <= 0) return zh ? `${rest} 分钟` : `${rest} min`
  if (rest === 0) return zh ? `${hours} 小时` : `${hours} h`
  return zh ? `${hours} 小时 ${rest} 分` : `${hours} h ${rest} min`
}

/**
 * 组装侧栏数据（纯函数，宿主只负责把 inputs 凑齐）。
 * @param {object} input
 * @param {object} input.ledger 账本
 * @param {string} [input.date] 统计日（默认今日）
 * @param {number} [input.now] 当前时刻（默认 now）
 * @param {object} [input.display] 展示币种配置
 * @param {Array<{provider: string, displayName?: string}>} [input.providers] 全部已配置供应商（供切换器列清单）
 * @param {object|null} [input.balance] DeepSeek 官方余额（**仅官方支持**），其余供应商为 null
 * @param {object|null} [input.peak] 官方峰谷相位：`{ enabled, inPeak, zoneKind, nextAtMs, nextIntoPeak }`
 * @param {string} [input.locale] 文案语言（倒计时用）
 */
export function buildSidebarData({
  ledger,
  date = dayKey(),
  now = Date.now(),
  display = DEFAULT_DISPLAY,
  providers = [],
  balance = null,
  balances = null,
  peak = null,
  locale = 'zh',
} = {}) {
  const day = summarizeDay(ledger, date)
  const known = new Map()
  for (const row of Array.isArray(providers) ? providers : []) {
    if (typeof row?.provider !== 'string' || row.provider.length === 0) continue
    known.set(row.provider, row.displayName ?? row.provider)
  }
  for (const row of day.providers) {
    if (!known.has(row.provider)) known.set(row.provider, row.provider)
  }
  const countdownMs = peak !== null && Number.isFinite(peak.nextAtMs) ? Math.max(0, peak.nextAtMs - now) : null
  return {
    date,
    now,
    display,
    total: {
      calls: day.calls,
      priced: day.priced,
      unpriced: day.unpriced,
      usd: day.usd,
      amount: toDisplay(day.usd, display),
      tokens: day.tokens,
      hitRate: day.hitRate,
    },
    providers: [...known.entries()].map(([provider, displayName]) => {
      const row = day.providers.find(item => item.provider === provider)
      return {
        provider,
        displayName,
        calls: row?.calls ?? 0,
        unpriced: row?.unpriced ?? 0,
        usd: row?.usd ?? 0,
        amount: toDisplay(row?.usd ?? 0, display),
        tokens: row?.tokens ?? 0,
        hitRate: row?.hitRate ?? null,
        models: row?.models ?? [],
      }
    }),
    balance,
    /** 全部官方路线（deepseek-official / deepseek-account）的余额：侧栏点一下就切换。 */
    balances: Array.isArray(balances) ? balances : (balance === null || balance === undefined ? [] : [balance]),
    peak: peak === null ? null : {
      ...peak,
      countdownMs,
      countdown: countdownMs === null ? null : formatCountdown(countdownMs, locale),
    },
    basisIds: day.basisIds,
  }
}

// ───────────────────────── 长期日汇总（本月 / 累计） ─────────────────────────
//
// 账本只留最近 LEDGER_KEEP_DAYS 天的原始记录（供「今日会话」这类明细），
// 而设置页要显示「本月 / 累计」——所以每天把当日汇总**覆盖式**写进一份很小的
// 日汇总文件（`days[YYYY-MM-DD] = 当日总额`，不含明细）。覆盖式写入天然幂等：
// 同一天记账多少次，结果都一样。

export const ROLLUP_VERSION = 1
export const ROLLUP_KEEP_DAYS = 400

/** 保留期上限（10 年）：够长，同时挡住手填离谱值把账本留成无限增长。 */
export const KEEP_DAYS_MAX = 3650
/** 保留期默认值：明细 7 天（侧栏只看今日，留几天是为了按日曲线与排错）+ 日汇总 400 天。 */
export const DEFAULT_RETENTION = Object.freeze({ ledgerDays: LEDGER_KEEP_DAYS, rollupDays: ROLLUP_KEEP_DAYS })

/**
 * 归一保留期配置（`state.json` 的 `retention`，两个键都可省）。
 *
 * - `rollupDays` 强制 ≥ `ledgerDays`：日汇总比明细还短的话，「本月 / 累计」会在明细还在的
 *   日子里就已经缺数据，而且**看不出来**缺（数字只是偏小）。
 * - 两个键都没给（含空对象）→ `undefined`，表示「没配，用默认」；非法值各自回落默认。
 * - 允许 1..`KEEP_DAYS_MAX` 的整数（数字或数字串，与 `budget.amount` 同一套取数规矩）。
 */
export function normalizeRetention(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if (raw.ledgerDays === undefined && raw.rollupDays === undefined) return undefined
  const days = (value, fallback) => {
    const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN)
    return Number.isInteger(numeric) && numeric >= 1 && numeric <= KEEP_DAYS_MAX ? numeric : fallback
  }
  const ledgerDays = days(raw.ledgerDays, LEDGER_KEEP_DAYS)
  const rollupDays = Math.max(ledgerDays, days(raw.rollupDays, ROLLUP_KEEP_DAYS))
  return { ledgerDays, rollupDays }
}

export function createRollup() {
  return { version: ROLLUP_VERSION, days: {} }
}

export function normalizeRollup(parsed) {
  const rollup = createRollup()
  const days = parsed?.days
  if (days === null || typeof days !== 'object' || Array.isArray(days)) return rollup
  for (const [date, totals] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (totals === null || typeof totals !== 'object') continue
    const usd = Number(totals.usd)
    rollup.days[date] = {
      date,
      calls: Math.max(0, Math.trunc(Number(totals.calls) || 0)),
      priced: Math.max(0, Math.trunc(Number(totals.priced) || 0)),
      unpriced: Math.max(0, Math.trunc(Number(totals.unpriced) || 0)),
      usd: Number.isFinite(usd) ? usd : 0,
      tokens: {
        input: Math.max(0, Math.trunc(Number(totals.tokens?.input) || 0)),
        output: Math.max(0, Math.trunc(Number(totals.tokens?.output) || 0)),
        cacheRead: Math.max(0, Math.trunc(Number(totals.tokens?.cacheRead) || 0)),
        cacheWrite: Math.max(0, Math.trunc(Number(totals.tokens?.cacheWrite) || 0)),
        reasoning: Math.max(0, Math.trunc(Number(totals.tokens?.reasoning) || 0)),
      },
    }
  }
  return rollup
}

/**
 * 把账本里某一天的汇总写进日汇总（覆盖式，幂等）。
 *
 * ⚠️ 桶要从 `day.buckets` 读：`summarizeDay()` 返回的 `tokens` 是**当日 token 总数**
 * （数字），不是桶对象。早先按 `tokens` 展开会把桶写成 `{}`，等于每次启动/每次看报表
 * 都把「本月 / 累计 token」清零。这里两种形状都认，但永远存 5 桶对象。
 */
export function applyRollupDay(rollup, date, day) {
  if (rollup === null || typeof rollup !== 'object' || rollup.days === null || typeof rollup.days !== 'object') return rollup
  const buckets = bucketObject(day?.buckets ?? day?.tokens)
  rollup.days[date] = {
    date,
    calls: Math.max(0, Math.trunc(Number(day?.calls) || 0)),
    priced: Math.max(0, Math.trunc(Number(day?.priced) || 0)),
    unpriced: Math.max(0, Math.trunc(Number(day?.unpriced) || 0)),
    usd: Number.isFinite(Number(day?.usd)) ? Number(day.usd) : 0,
    tokens: buckets,
  }
  return rollup
}

/** 归一成 5 桶对象：认桶对象本身，也认缺省（数字 / undefined 一律当作全 0）。 */
function bucketObject(source) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const key of Object.keys(out)) out[key] = count(source[key])
  }
  return out
}

/**
 * 增量累加一条记录到当日汇总（O(1) 记账）。
 *
 * 与 `applyRollupDay` 的关系：两者结果一致，但 `applyRollupDay` 要重扫当日全部记录
 * （当日 3000 条时约 0.5 ms/次，一天下来是平方级），所以**记账路径**用这个增量版，
 * 启动与 `/report` 用覆盖版兜底对齐（自愈）。
 */
export function addRecordToRollupDay(rollup, date, record) {
  if (rollup === null || typeof rollup !== 'object' || rollup.days === null || typeof rollup.days !== 'object') return rollup
  if (record === null || typeof record !== 'object') return rollup
  const day = rollup.days[date] ?? (rollup.days[date] = {
    date,
    calls: 0,
    priced: 0,
    unpriced: 0,
    usd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  })
  day.calls += 1
  // 与 summarizeRecords 同一判据：`cost` 是有限数才算「有价」（未定价是 null）
  const value = finiteCost(record.cost)
  if (value === null) {
    day.unpriced += 1
  } else {
    day.priced += 1
    day.usd += finiteCost(record.usd) ?? value
  }
  for (const key of Object.keys(day.tokens)) day.tokens[key] += count(record.buckets?.[key])
  return rollup
}

/** `cost` 判据：只认有限数字（`null` = 未定价）。 */
function finiteCost(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return null
}

/** 记录是否有价（与记录汇总口径一致）。 */
function isPriced(record) {
  return finiteCost(record?.cost) !== null
}

/** 按保留天数裁剪（保留含 `date` 在内的最近 keepDays 天）。 */
export function pruneRollup(rollup, { date = dayKey(), keepDays = ROLLUP_KEEP_DAYS } = {}) {
  if (rollup === null || typeof rollup !== 'object' || rollup.days === null || typeof rollup.days !== 'object') return 0
  const keep = Math.max(1, Math.min(3650, Math.trunc(keepDays) || ROLLUP_KEEP_DAYS))
  const from = dayKey(Date.parse(`${date}T00:00:00Z`) - (keep - 1) * 86_400_000)
  let removed = 0
  for (const key of Object.keys(rollup.days)) {
    if (key < from) {
      delete rollup.days[key]
      removed += 1
    }
  }
  return removed
}

/** 汇总日汇总里的若干天（`prefix` 按月前缀过滤，或 `from`/`to` 按区间过滤）。 */
export function summarizeRollup(rollup, { prefix = null, from = null, to = null } = {}) {
  const totals = {
    days: 0,
    calls: 0,
    priced: 0,
    unpriced: 0,
    usd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  }
  const days = rollup?.days
  if (days === null || typeof days !== 'object') return totals
  let since = null
  for (const [date, day] of Object.entries(days)) {
    if (prefix !== null && !date.startsWith(prefix)) continue
    if (from !== null && date < from) continue
    if (to !== null && date > to) continue
    totals.calls += day.calls
    totals.priced += day.priced
    totals.unpriced += day.unpriced
    totals.usd += day.usd
    for (const key of Object.keys(totals.tokens)) totals.tokens[key] += day.tokens[key] ?? 0
    // 「有记录的天数」才算一天：启动时会给今天写一条空汇总，不能把它算进「累计 N 天」
    if (day.calls > 0) {
      totals.days += 1
      if (since === null || date < since) since = date
    }
  }
  totals.since = since
  totals.hitRate = cacheHitRate(totals.tokens)
  return totals
}

/** 按会话聚合某一天的调用（设置页的「今日会话」表）。 */
export function summarizeSessions(ledger, date = dayKey(), { limit = 50 } = {}) {
  const records = dayRecords(ledger, date)
  const bySession = new Map()
  for (const record of records) {
    const id = typeof record.sessionId === 'string' && record.sessionId.length > 0 ? record.sessionId : '(未标会话)'
    let row = bySession.get(id)
    if (row === undefined) {
      row = {
        sessionId: id,
        calls: 0,
        priced: 0,
        unpriced: 0,
        usd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        models: new Map(),
        firstAtMs: null,
        lastAtMs: null,
      }
      bySession.set(id, row)
    }
    row.calls += 1
    if (isPriced(record)) {
      row.usd += finiteCost(record.usd) ?? finiteCost(record.cost) ?? 0
      row.priced += 1
    } else {
      row.unpriced += 1
    }
    for (const key of Object.keys(row.tokens)) row.tokens[key] += count(record.buckets?.[key])
    const model = typeof record.model === 'string' && record.model.length > 0 ? record.model : '(未知模型)'
    row.models.set(model, (row.models.get(model) ?? 0) + 1)
    if (row.firstAtMs === null || record.atMs < row.firstAtMs) row.firstAtMs = record.atMs
    if (row.lastAtMs === null || record.atMs > row.lastAtMs) row.lastAtMs = record.atMs
  }
  return [...bySession.values()]
    .map(row => ({
      ...row,
      tokens: { ...row.tokens, total: row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite },
      hitRate: cacheHitRate(row.tokens),
      models: [...row.models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([model, calls]) => ({ model, calls })),
    }))
    .sort((a, b) => (b.usd - a.usd) || (b.calls - a.calls) || String(a.sessionId).localeCompare(String(b.sessionId)))
    .slice(0, Math.max(1, Math.trunc(limit) || 50))
}

/**
 * 组装设置页「费用」报表（纯函数）。
 *
 * 金额一律走 `toDisplay`：未定价的 `null` 不会被画成 0。
 * @param {object} input
 */
export function buildReport({
  ledger,
  rollup = createRollup(),
  date = dayKey(),
  now = Date.now(),
  display = DEFAULT_DISPLAY,
  budget = null,
  providers = [],
  quotas = [],
  balance = null,
  balances = null,
  peak = null,
  prices = null,
  models = [],
  sessionLimit = 50,
  trendDays = 60,
  locale = 'zh',
  retention = DEFAULT_RETENTION,
} = {}) {
  const day = summarizeDay(ledger, date)
  // `day.buckets` 才是 5 桶对象；`day.tokens` 是**当日 token 总数**（数字）。
  // 这两个名字太容易混，所以这里显式起个别名，后面一律用它。
  const dayBuckets = day.buckets
  const monthPrefix = date.slice(0, 7)
  const monthRollup = summarizeRollup(rollup, { prefix: monthPrefix })
  const allRollup = summarizeRollup(rollup)
  // 今日以账本原始记录为准；日汇总里已有今天的快照（可能落后几秒），所以只补**差额**，
  // 不能整个再加一遍（否则今日会被算两次）。
  const today = rollup?.days?.[date] ?? null
  const extra = {
    usd: day.usd - (today?.usd ?? 0),
    calls: day.calls - (today?.calls ?? 0),
    unpriced: day.unpriced - (today?.unpriced ?? 0),
    tokens: subtractTokens(dayBuckets, today?.tokens ?? null),
  }
  const month = {
    usd: monthRollup.usd + extra.usd,
    calls: monthRollup.calls + extra.calls,
    tokens: addTokens(monthRollup.tokens, extra.tokens),
    unpriced: monthRollup.unpriced + extra.unpriced,
    days: monthRollup.days,
    since: monthRollup.since,
  }
  const all = {
    usd: allRollup.usd + extra.usd,
    calls: allRollup.calls + extra.calls,
    tokens: addTokens(allRollup.tokens, extra.tokens),
    unpriced: allRollup.unpriced + extra.unpriced,
    days: allRollup.days,
    since: allRollup.since,
  }
  const todayUsd = day.usd
  month.hitRate = cacheHitRate(month.tokens)
  all.hitRate = cacheHitRate(all.tokens)

  const budgetConfig = budget === null ? null : {
    enabled: budget.enabled === true,
    amount: optionalAmount(budget.amount),
    currency: typeof budget.currency === 'string' ? budget.currency : display.currency,
    period: ['today', 'month', 'all'].includes(budget.period) ? budget.period : 'month',
  }
  const usedUsd = budgetConfig === null ? 0
    : budgetConfig.period === 'today' ? todayUsd
      : budgetConfig.period === 'month' ? month.usd : all.usd
  const usedAmount = toDisplay(usedUsd, display)
  const budgetBlock = budgetConfig === null ? null : {
    ...budgetConfig,
    usedUsd,
    usedAmount,
    // 占比必须在**同一币种**里算：额度是展示币种的金额，所以用 usedAmount 除，
    // 不能拿账本的美元金额去除人民币额度（那会差一个汇率）。
    ratio: budgetConfig.amount === null || budgetConfig.amount <= 0 ? null : usedAmount / budgetConfig.amount,
  }

  const providerRows = (Array.isArray(providers) ? providers : []).map(row => {
    const hit = day.providers.find(item => item.provider === row.provider)
    return {
      provider: row.provider,
      displayName: row.displayName ?? row.provider,
      calls: hit?.calls ?? 0,
      priced: hit?.priced ?? 0,
      unpriced: hit?.unpriced ?? 0,
      usd: hit?.usd ?? 0,
      amount: toDisplay(hit?.usd ?? 0, display),
      tokens: hit?.tokens ?? 0,
      hitRate: hit?.hitRate ?? null,
    }
  })
  const providerByKey = new Map(providerRows.map(row => [row.provider, row]))
  const countdownMs = peak !== null && Number.isFinite(peak.nextAtMs) ? Math.max(0, peak.nextAtMs - now) : null
  return {
    date,
    now,
    display,
    totals: {
      today: {
        usd: todayUsd,
        amount: toDisplay(todayUsd, display),
        calls: day.calls,
        priced: day.priced,
        unpriced: day.unpriced,
        tokens: { ...dayBuckets, total: dayBuckets.input + dayBuckets.output + dayBuckets.cacheRead + dayBuckets.cacheWrite },
        hitRate: day.hitRate,
      },
      month: { usd: month.usd, amount: toDisplay(month.usd, display), calls: month.calls, unpriced: month.unpriced, days: month.days, since: month.since, tokens: month.tokens, hitRate: month.hitRate },
      all: { usd: all.usd, amount: toDisplay(all.usd, display), calls: all.calls, unpriced: all.unpriced, days: all.days, since: all.since, tokens: all.tokens, hitRate: all.hitRate },
    },
    sessions: summarizeSessions(ledger, date, { limit: sessionLimit }),
    budget: budgetBlock,
    providers: providerRows,
    models: summarizeModels(ledger, date).map(row => ({
      ...row,
      amount: toDisplay(row.usd, display),
    })),
    quotas: (Array.isArray(quotas) ? quotas : []).map(row => ({
      // 先铺今日金额/未定价，再让额度行自己的字段覆盖（provider/displayName/type/status…）
      ...(providerByKey.get(row.provider) ?? { calls: 0, priced: 0, unpriced: 0, usd: 0, amount: toDisplay(0, display), tokens: 0, hitRate: null }),
      ...row,
    })),
    balance,
    /** 全部官方路线的余额（概览页逐条列出） */
    balances: Array.isArray(balances) ? balances : (balance === null || balance === undefined ? [] : [balance]),
    peak: peak === null ? null : {
      ...peak,
      countdownMs,
      countdown: countdownMs === null ? null : formatCountdown(countdownMs, locale),
    },
    prices,
    trend: trendOf(rollup, date, trendDays).map(row => ({ ...row, amount: toDisplay(row.usd, display) })),
    basisIds: day.basisIds,
    /** 当前生效的保留期（设置页「显示」分页拿它回填输入框）。 */
    retention,
  }
}

/** 按模型聚合某一天的调用（设置页「用量」表）。 */
export function summarizeModels(ledger, date = dayKey(), { limit = 60 } = {}) {
  const records = dayRecords(ledger, date)
  const byModel = new Map()
  for (const record of records) {
    const key = `${record.provider ?? '?'}\u0000${record.model ?? '(未知模型)'}`
    let row = byModel.get(key)
    if (row === undefined) {
      row = {
        provider: record.provider ?? null,
        model: typeof record.model === 'string' && record.model.length > 0 ? record.model : '(未知模型)',
        calls: 0,
        priced: 0,
        unpriced: 0,
        usd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      }
      byModel.set(key, row)
    }
    row.calls += 1
    if (isPriced(record)) {
      row.usd += finiteCost(record.usd) ?? finiteCost(record.cost) ?? 0
      row.priced += 1
    } else {
      row.unpriced += 1
    }
    for (const bucket of Object.keys(row.tokens)) row.tokens[bucket] += count(record.buckets?.[bucket])
  }
  return [...byModel.values()]
    .map(row => ({
      ...row,
      tokens: { ...row.tokens, total: row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite },
      hitRate: cacheHitRate(row.tokens),
    }))
    .sort((a, b) => (b.usd - a.usd) || (b.calls - a.calls))
    .slice(0, Math.max(1, Math.trunc(limit) || 60))
}

function trendOf(rollup, date, limit) {  const days = rollup?.days
  if (days === null || typeof days !== 'object') return []
  return Object.values(days)
    .filter(row => row.date <= date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-Math.max(1, Math.trunc(limit) || 60))
    .map(row => ({ date: row.date, usd: row.usd, calls: row.calls }))
}

/** 两个 token 桶集合相加（键固定，多余键忽略）。 */
function addTokens(left, right) {
  const out = {}
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
    out[key] = (left?.[key] ?? 0) + (right?.[key] ?? 0)
  }
  out.total = out.input + out.output + out.cacheRead + out.cacheWrite
  return out
}

/** 两个 token 桶集合相减（用于「今日差额」：不小于 0）。 */
function subtractTokens(left, right) {
  const out = {}
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
    out[key] = Math.max(0, (left?.[key] ?? 0) - (right?.[key] ?? 0))
  }
  out.total = out.input + out.output + out.cacheRead + out.cacheWrite
  return out
}

/** 预算额度：`null` / 空串 / 非数字都算「没填」，**不能**被 `Number(null)=0` 变成 0。 */
function optionalAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? number : null
  }
  return null
}
