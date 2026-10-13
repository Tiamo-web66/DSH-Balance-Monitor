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

/**
 * 本地日历的加减天（`date` 是 `YYYY-MM-DD`）。
 *
 * **不能用 `Date.parse(date + 'T00:00:00Z') - n * 86400000`**：那算的是 UTC 午夜，却又要用
 * 本地日历的 `dayKey()` 格式化成日期串 —— 在**负偏移时区**（America/*）整体偏一天：
 * 热力图看不到今天、「近 90 天」把今天排除、保留期多留一天（UTC+ 时区会蒙对，所以极易漏测）。
 * 这里全程走本地日历（`setDate` 会正确处理跨月/跨年/夏令时），与 `dayKey()` 同一个日历。
 */
export function addDays(date, count) {
  const [year, month, day] = String(date).split('-').map(Number)
  const base = new Date(year, (month ?? 1) - 1, day ?? 1)
  if (!Number.isFinite(base.getTime())) return String(date)
  base.setDate(base.getDate() + Math.trunc(count))
  return dayKey(base.getTime())
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
 * 判据只有一条：`(会话, 模型, 五桶指纹)` 在 `windowMs` 内只放行一次。
 *
 * ⚠️ **这是刻意的 tradeoff，代价是同指纹的「真实」调用会少记一笔**（不是 bug）：
 * 闸门看不到「这次到达是包装重复还是碰巧参数相同的第二次真调用」，两者在记录里
 * 逐位不可区分；按「同会话 + 同模型 + 五桶完全相同 + 10 秒内」去判，真实调用需要
 * 连秒级时间窗和 token 数都撞上才误判（正常多轮对话的桶不可能一样），而包装路由
 * 的重复投递**必然**同指纹同窗口 —— 命中率高得多，所以选了这一侧。
 * 反过来说：判据一旦不够严（窗口拉长、指纹放松），少账就会变多。
 *
 * 与参照实现的差别：这里不做包装层 provider id 的重挂，只做上面的指纹互斥。
 * 窗口 `windowMs` 默认 10 秒是**沿用原值、按经验估的**（包装重复投递在毫秒级到数秒级、
 * 一次调用到下游返回通常远小于 10 秒），没有实测数据支持收得更短，所以没收窄；
 * 要动它先补用例（`test/usage-ledger.test.mjs` 里那条「去重窗口钉住」会先红）。
 *
 * **没带 sessionId 的调用一律放行**（不去重）：宿主内部调用不一定给会话 id，把它们
 * 归进同一个桶会漏计真实调用（宁可多记一次，也不要少账）。这条是上面 tradeoff 的例外，
 * 因为内部调用的指纹确实可能是「同模型 + 同 token 数」，撞的概率远高于普通对话。
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
     * 清空去重记忆。清空历史时调用：否则「清空前 10 秒内刚记过的调用」在清空后
     * 重复到达时会被判定为样本重复丢掉 —— 刚清完就开始丢账，最容易让人以为清坏了解。
     */
    reset() {
      sessions.clear()
    },
    /**
     * @returns {boolean} true = 该记账，false = 判定为重复样本，丢弃
     */
    admit(sessionId, model, buckets, atMs = Date.now()) {
      const now = Number.isFinite(atMs) ? atMs : Date.now()
      // **没有会话 id 就不去重**：宿主内部调用不一定带 sessionId，若把它们都塞进同一个
      // 空串桶，同一模型 + 同 token 数的两次**真实**调用会被当成重复样本丢掉一笔
      // （实测 4 笔调用记成 3 笔）。这条与上面的闸门是两套判据：带会话的调用接受
      // 「同指纹 10 秒内算重复」的少账代价（见 createUsageDeduper 的注释），
      // 不带会话的调用一律放行 —— 宁可多记一次也不要漏账。
      if (typeof sessionId !== 'string' || sessionId.length === 0) return true
      const key = sessionId
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
/**
 * 侧栏「模型花费卡片」的数据：按周期取 Top-N 模型 + 该周期总额（份额按总额算）。
 *
 * 两个周期走**同一套口径**：今日用账本明细的按模型 map，近 90 天用日汇总聚合 ——
 * 两边都是 `accumulateRow` 出来的形状（计数 / 金额 / 5 桶），所以格式化只有一份。
 */
export function buildModelCard({ ledger, rollup = null, date = dayKey(), display = DEFAULT_DISPLAY, config = {} } = {}) {
  // 解构里的 `config = {}` 只是**默认值**：只在「没传这个键」时生效，显式传 `config: null`
  // （配置被清空 / 侧栏配置还没写下来的常见形状）会原样进来，下一行读 `config.rows` 就是
  // `Cannot read properties of null (reading 'rows')`。这里归一，`null` 与不传等价。
  config = config ?? {}
  const limit = Math.max(1, Math.min(10, Math.trunc(Number(config.rows)) || 5))
  const period = config.period === 'days90' ? 'days90' : 'today'
  const from = period === 'days90' ? addDays(date, -89) : date
  const models = period === 'today' ? summarizeDayModels(ledger, date) : summarizeRollupModels(rollup, { from })
  const totals = period === 'today' ? summarizeDay(ledger, date) : summarizeRollup(rollup, { from })
  const rows = Object.entries(models).map(([key, row]) => {
    const separator = key.indexOf(':')
    const tokensTotal = row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite
    return {
      key,
      provider: separator > 0 ? key.slice(0, separator) : 'unknown',
      model: separator > 0 ? key.slice(separator + 1) : key,
      calls: row.calls,
      unpriced: row.unpriced,
      usd: row.usd,
      amount: toDisplay(row.usd, display),
      tokens: tokensTotal,
      hitRate: cacheHitRate(row.tokens),
    }
  }).sort((a, b) => (b.usd - a.usd) || (b.tokens - a.tokens) || a.key.localeCompare(b.key))
  /**
   * 总额：**未定价 ≠ 0** —— 有调用却一条都没定价时是 `null`（界面显示 `—`）。
   *
   * 两个周期的总量来源不同：今日是 `summarizeDay()`（全未定价时 `usd` 已经是 `null`），
   * 近 90 天是 `summarizeRollup()`（金额按日汇总的数字相加，全未定价的日子存的是 `0`）。
   * 不在这里归一，同一份数据就会出现「今日 — / 近 90 天 0」两种口径，而「没有价」
   * 被渲染成「没花钱」正是这个账本从 pricing.js 起就要避免的事。
   *
   * 判据用 `priced`（有价记录条数）而不是 `usd > 0`：真实存在 0 元的调用
   * （0 价档 / 全 0 桶），那种情况 `priced > 0`，必须照旧显示 `0` 而不是 `—`。
   * `usd > 0` 那半个条件是防呆：手写或旧版的日汇总行可能缺 `priced`，
   * 此时不能凭一个缺失字段把已经算出来的金额抹成 `null`。
   */
  const totalUsd = Number(totals.priced) > 0 || Number(totals.usd) > 0 ? (totals.usd ?? null) : null
  return {
    period,
    from,
    /** 模型总数（不是给出去的行数）——「收起摘要」要报它。 */
    models: rows.length,
    /**
     * Top-N 行。字段名刻意不叫 `rows`：配置里那个 `rows` 是**要显示几行**（数字），
     * 同名会让「配置」和「数据」在同一个对象里打架（侧栏 payload 是把两者摊平的）。
     */
    items: rows.slice(0, limit).map(row => ({
      ...row,
      /** 占该周期总额的比例（总额为 0 时是 null，不是 0 —— 「没有价」和「占比 0%」不是一回事）。 */
      share: totalUsd > 0 ? Math.min(1, row.usd / totalUsd) : null,
    })),
    total: {
      usd: totalUsd,
      amount: toDisplay(totalUsd, display),
      calls: totals.calls,
      unpriced: totals.unpriced,
    },
  }
}

/**
 * 预算进度（设置页「概览」与侧栏/输入区横条**共用同一套规则**）。
 *
 * 占比必须在**同一币种**里算：额度是展示币种的金额，所以拿 `toDisplay(usedUsd)` 去除，
 * 不能拿账本的美元金额去除人民币额度（那会差一个汇率）。`amount <= 0` 时占比是 `null`
 * （不是 0 —— 「没设额度」和「已用 0%」不是一回事）。
 */
export function budgetProgress({ budget, display = DEFAULT_DISPLAY, todayUsd = 0, monthUsd = 0, allUsd = 0 } = {}) {
  if (budget === null || budget === undefined) return null
  const config = {
    enabled: budget.enabled === true,
    amount: optionalAmount(budget.amount),
    currency: typeof budget.currency === 'string' ? budget.currency : display.currency,
    period: ['today', 'month', 'all'].includes(budget.period) ? budget.period : 'month',
  }
  const usedUsd = config.period === 'today' ? todayUsd : config.period === 'month' ? monthUsd : allUsd
  const usedAmount = toDisplay(usedUsd, display)
  return {
    ...config,
    usedUsd,
    usedAmount,
    ratio: usedAmount === null || config.amount === null || config.amount <= 0 ? null : usedAmount / config.amount,
  }
}

export function buildSidebarData({
  ledger,
  rollup = null,
  date = dayKey(),
  now = Date.now(),
  display = DEFAULT_DISPLAY,
  providers = [],
  balance = null,
  balances = null,
  peak = null,
  locale = 'zh',
  /** 模型花费卡片配置（`null` / `enabled: false` = 不给这块数据）。 */
  modelCard = null,
  /** 预算配置（横条那格「预算已用 %」用它；与设置页概览同一套规则）。 */
  budget = null,
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
    /** 模型花费卡片：关掉时是 `null`（客户端因此不渲染，也不用白算聚合）。配置与数据摊在一起。 */
    modelCard: modelCard === null || modelCard.enabled !== true
      ? null
      : { ...modelCard, ...buildModelCard({ ledger, rollup, date, display, config: modelCard }) },
    /**
     * 预算进度（输入区横条那一格）：与设置页概览**同一套规则**。
     * 月度 / 累计要读日汇总 —— 这也是账本明细之外的来源。
     */
    budget: budgetProgress({
      budget,
      display,
      todayUsd: day.usd,
      monthUsd: summarizeRollup(rollup, { prefix: date.slice(0, 7) }).usd,
      allUsd: summarizeRollup(rollup).usd,
    }),
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
      tokens: bucketObject(totals.tokens),
      // 老文件没有 models（0.8.0 才加）：当成空 map，历史那天只是「没有按模型明细」
      models: normalizeModelMap(totals.models),
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
 *
 * `models` 是「按模型」明细（`provider:model` → 计数 / 金额 / 5 桶）。不传就沿用旧的
 * （`undefined` = 这次调用不掌握模型信息，不该把已有明细抹掉；传 `{}` 才是明确清空）。
 */
export function applyRollupDay(rollup, date, day, models = undefined) {
  if (rollup === null || typeof rollup !== 'object' || rollup.days === null || typeof rollup.days !== 'object') return rollup
  const buckets = bucketObject(day?.buckets ?? day?.tokens)
  const previous = rollup.days[date]
  const nextModels = models === undefined
    ? (previous?.models ?? {})
    : normalizeModelMap(models)
  rollup.days[date] = {
    date,
    calls: Math.max(0, Math.trunc(Number(day?.calls) || 0)),
    priced: Math.max(0, Math.trunc(Number(day?.priced) || 0)),
    unpriced: Math.max(0, Math.trunc(Number(day?.unpriced) || 0)),
    usd: Number.isFinite(Number(day?.usd)) ? Number(day.usd) : 0,
    tokens: buckets,
    models: nextModels,
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

/** 一行「计数 / 金额 / 5 桶」的空壳（日汇总与按模型明细共用）。 */
function emptyRow() {
  return { calls: 0, priced: 0, unpriced: 0, usd: 0, tokens: bucketObject(null) }
}

/**
 * 把一条记录累加进一行。
 *
 * **日汇总与「按模型」明细走同一条累加路径** —— 两边各写一份口径迟早会漂（比如
 * 「cost 是有限数才算有价」这种判据漏改一处，就会出现「总额有价、模型行未定价」）。
 */
function accumulateRow(row, record) {
  row.calls += 1
  const value = finiteCost(record.cost)
  if (value === null) {
    row.unpriced += 1
  } else {
    row.priced += 1
    row.usd += finiteCost(record.usd) ?? value
  }
  for (const key of Object.keys(row.tokens)) row.tokens[key] += count(record.buckets?.[key])
  return row
}

/** 记录归属的模型键：`provider:model`（两边都可能缺，用 `unknown` 兜底）。 */
export function modelKeyOf(record) {
  const provider = typeof record?.provider === 'string' && record.provider.length > 0 ? record.provider : 'unknown'
  const model = typeof record?.model === 'string' && record.model.length > 0 ? record.model : 'unknown'
  return `${provider}:${model}`
}

/** 把一组记录聚成「按模型」的 map（`provider:model` → 计数 / 金额 / 5 桶）。 */
export function summarizeModelMap(records) {
  const out = {}
  for (const record of records) {
    const key = modelKeyOf(record)
    accumulateRow(out[key] ?? (out[key] = emptyRow()), record)
  }
  return out
}

/** 某一天「按模型」的 map（从账本记录重算，覆盖式对齐用）。 */
export function summarizeDayModels(ledger, date = dayKey()) {
  return summarizeModelMap(dayRecords(ledger, date))
}

/** 从磁盘/请求里来的「按模型」map 的归一（坏键 / 坏值一律丢，不抛）。 */
function normalizeModelMap(source) {
  const out = {}
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return out
  for (const [key, row] of Object.entries(source)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) continue
    if (row === null || typeof row !== 'object') continue
    const usd = Number(row.usd)
    out[key] = {
      calls: Math.max(0, Math.trunc(Number(row.calls) || 0)),
      priced: Math.max(0, Math.trunc(Number(row.priced) || 0)),
      unpriced: Math.max(0, Math.trunc(Number(row.unpriced) || 0)),
      usd: Number.isFinite(usd) ? usd : 0,
      tokens: bucketObject(row.tokens),
    }
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
  const day = rollup.days[date] ?? (rollup.days[date] = { date, ...emptyRow() })
  accumulateRow(day, record)
  // 同一套累加口径再走一遍「按模型」那一层（两处口径必须一致，见 accumulateRow 注释）
  const models = day.models ?? (day.models = {})
  const key = modelKeyOf(record)
  accumulateRow(models[key] ?? (models[key] = emptyRow()), record)
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
  const from = addDays(date, -(keep - 1))
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

/**
 * 某个会话某一日的用量（「本会话费用」那块：输入区下方 / 会话标题栏）。
 *
 * `includeSubagent` 打开时把**父会话 id 指向它**的调用也算进来。归属信息来自记录上的
 * `parentSessionId` —— 只有宿主在调用事件里给了才有（老记录、或宿主不给，都没有），
 * 所以返回里带 `subagentSupported`：界面据此决定要不要展示这一档、要不要提示
 * 「宿主没给归属信息」，而不是假装算过（算没算得出来，用户要能看出来）。
 */
export function summarizeSession(ledger, {
  sessionId,
  date = dayKey(),
  includeSubagent = false,
  display = DEFAULT_DISPLAY,
  limit = 5,
} = {}) {
  const id = typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null
  if (id === null) return null
  const records = dayRecords(ledger, date)
  const selfRows = []
  const childRows = []
  for (const record of records) {
    if (record.sessionId === id) selfRows.push(record)
    else if (includeSubagent === true && record.parentSessionId === id) childRows.push(record)
  }
  const top = Math.max(1, Math.trunc(limit) || 5)
  const block = rows => {
    const summary = summarizeGroup(rows)
    const tokens = { ...summary.buckets, total: Object.values(summary.buckets).reduce((sum, value) => sum + value, 0) }
    const models = Object.entries(summarizeModelMap(rows))
      .map(([key, row]) => {
        const separator = key.indexOf(':')
        return {
          key,
          provider: separator > 0 ? key.slice(0, separator) : 'unknown',
          model: separator > 0 ? key.slice(separator + 1) : key,
          calls: row.calls,
          usd: row.usd,
          amount: toDisplay(row.usd, display),
        }
      })
      .sort((a, b) => (b.usd - a.usd) || a.key.localeCompare(b.key))
      .slice(0, top)
    return {
      calls: summary.calls,
      priced: summary.priced,
      unpriced: summary.unpriced,
      usd: summary.usd ?? 0,
      amount: toDisplay(summary.usd ?? 0, display),
      /** 全部未定价时是 `null`（不是 0）—— 界面据此显示 `—`。 */
      cost: summary.cost === null ? null : toDisplay(summary.cost, display),
      tokens,
      hitRate: summary.hitRate,
      models,
    }
  }
  const self = block(selfRows)
  const children = block(childRows)
  const total = block([...selfRows, ...childRows])
  const stamps = [...selfRows, ...childRows].map(row => Number(row.atMs)).filter(Number.isFinite)
  return {
    sessionId: id,
    date,
    includeSubagent: includeSubagent === true,
    /** 账本里有没有任何一条带 `parentSessionId` —— 没有就说明宿主不给归属信息。 */
    subagentSupported: records.some(record => typeof record.parentSessionId === 'string' && record.parentSessionId.length > 0),
    self,
    /** 归属到本会话的子代理调用（`includeSubagent` 关着时是空的）。 */
    children,
    total,
    firstAtMs: stamps.length === 0 ? null : Math.min(...stamps),
    lastAtMs: stamps.length === 0 ? null : Math.max(...stamps),
  }
}

/**
 * 把日汇总里的「按模型」明细跨天聚起来（`provider:model` → 计数 / 金额 / 5 桶 / 天数）。
 *
 * 数据来源是 `days.json`（保留期默认 400 天），所以这里能出**全历史**的按模型统计 ——
 * 而账本明细只有几天的保留期。代价是：老文件（0.8.0 之前写下的那些天）没有 models 字段，
 * 那部分历史在这张表里是缺的（`daysMissingModels` 会如实报出来，不假装有）。
 */
export function summarizeRollupModels(rollup, { from = null } = {}) {
  const out = {}
  const days = rollup?.days ?? {}
  for (const [date, day] of Object.entries(days)) {
    if (from !== null && date < from) continue
    for (const [key, row] of Object.entries(day.models ?? {})) {
      const target = out[key] ?? (out[key] = { ...emptyRow(), days: 0 })
      target.calls += Math.max(0, Math.trunc(Number(row.calls) || 0))
      target.priced += Math.max(0, Math.trunc(Number(row.priced) || 0))
      target.unpriced += Math.max(0, Math.trunc(Number(row.unpriced) || 0))
      target.usd += Number.isFinite(Number(row.usd)) ? Number(row.usd) : 0
      for (const bucket of Object.keys(target.tokens)) target.tokens[bucket] += count(row.tokens?.[bucket])
      target.days += 1
    }
  }
  return out
}

/** 日汇总覆盖到但**没有**按模型明细的天数（0.8.0 之前写的旧数据；用来如实报告缺口）。 */
export function rollupDaysMissingModels(rollup) {
  let missing = 0
  for (const day of Object.values(rollup?.days ?? {})) {
    if ((day?.calls ?? 0) > 0 && Object.keys(day?.models ?? {}).length === 0) missing += 1
  }
  return missing
}

/**
 * 近 `days` 天的逐日用量（热力图用）：**补齐空天**，客户端直接按顺序铺格子就行。
 *
 * 补齐而不是只给有数据的天：热力图要按「周 × 7 天」排版，缺天会让整块错位。
 */
export function rollupDailySeries(rollup, { date = dayKey(), days = 182 } = {}) {
  const count = Math.max(1, Math.min(3650, Math.trunc(days) || 182))
  const out = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const key = addDays(date, -offset)
    const day = rollup?.days?.[key]
    const tokens = day?.tokens ?? {}
    out.push({
      date: key,
      calls: day?.calls ?? 0,
      usd: day?.usd ?? 0,
      tokens: (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0),
    })
  }
  return out
}

/** 按会话聚合某一天的调用（设置页的「今日会话」表）。 */export function summarizeSessions(ledger, date = dayKey(), { limit = 50 } = {}) {
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
  /** 热力图天数：26 周（与参照实现同宽）。 */
  heatmapDays = 182,
  /** 全历史「按模型」表最多给几行（客户端还有四种排行，多给点）。 */
  modelHistoryLimit = 80,
  locale = 'zh',
  retention = DEFAULT_RETENTION,
  notify = { enabled: false, system: false },
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
  /**
   * 账本比日汇总快照**少**（正常情况下差额非负）只有几种可能：账本文件坏了/被清了、
   * 或者单日记录数撞上了 `MAX_RECORDS_PER_DAY` 上限。
   *
   * 这时不能照原样做减法：`day.usd - today.usd` 会变成负数，把「本月 / 累计」**反减**
   * 一次，今日还会显示成 ¥0。所以以日汇总快照为准（它是覆盖式写入的、更完整的一份）。
   */
  const ledgerBehind = day.calls < (today?.calls ?? 0)
  const extra = ledgerBehind
    ? { usd: 0, calls: 0, unpriced: 0, tokens: bucketObject(null) }
    : {
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
  // 今日视图：账本为准；账本落后时退回日汇总快照（别显示成 0）
  const todayUsd = ledgerBehind && today !== null ? today.usd : day.usd
  const todayBuckets = ledgerBehind && today !== null ? bucketObject(today.tokens) : dayBuckets
  month.hitRate = cacheHitRate(month.tokens)
  all.hitRate = cacheHitRate(all.tokens)

  // 预算进度：与侧栏横条共用同一套规则（budgetProgress），避免两处算法漂
  const budgetBlock = budgetProgress({ budget, display, todayUsd, monthUsd: month.usd, allUsd: all.usd })
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
  // ── 全历史「按模型」（日汇总口径）：四种排行需要的字段都在这里算好 ──
  const modelHistory = summarizeRollupModels(rollup)
  const modelHistoryRows = Object.entries(modelHistory).map(([key, row]) => {
    const separator = key.indexOf(':')
    const provider = separator > 0 ? key.slice(0, separator) : 'unknown'
    const model = separator > 0 ? key.slice(separator + 1) : key
    const tokensTotal = row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite
    return {
      key,
      provider,
      model,
      calls: row.calls,
      priced: row.priced,
      unpriced: row.unpriced,
      days: row.days,
      usd: row.usd,
      amount: toDisplay(row.usd, display),
      tokens: { ...row.tokens, total: tokensTotal },
      // 命中率**统一调账本那侧的函数**：早先这里自己算「缓存读取 /（缓存读取 + 输入）」，
      // 与账本的 cacheHitRate()（分母还含缓存写入）不一致，同一页会出现 20.0% vs 33.3% 两个数。
      hitRate: cacheHitRate(row.tokens),
      /** 每美元拿到多少 token（越大越划算）。 */
      perUsd: row.usd > 0 && tokensTotal > 0 ? tokensTotal / row.usd : null,
    }
  }).sort((a, b) => (b.usd - a.usd) || (b.tokens.total - a.tokens.total) || a.key.localeCompare(b.key))
  const modelsMissing = rollupDaysMissingModels(rollup)
  const modelsSince = allRollup.since
  const modelsDays = allRollup.days
  const countdownMs = peak !== null && Number.isFinite(peak.nextAtMs) ? Math.max(0, peak.nextAtMs - now) : null
  return {
    date,
    now,
    display,
    totals: {
      today: {
        usd: todayUsd,
        amount: toDisplay(todayUsd, display),
        calls: ledgerBehind && today !== null ? (today.calls ?? 0) : day.calls,
        priced: ledgerBehind && today !== null ? (today.priced ?? 0) : day.priced,
        unpriced: ledgerBehind && today !== null ? (today.unpriced ?? 0) : day.unpriced,
        tokens: { ...todayBuckets, total: todayBuckets.input + todayBuckets.output + todayBuckets.cacheRead + todayBuckets.cacheWrite },
        hitRate: ledgerBehind && today !== null ? cacheHitRate(todayBuckets) : day.hitRate,
        /** 明细（会话 / 供应商 / 模型）来自账本；它为 true 时那些表会是空的，总额来自日汇总。 */
        ...(ledgerBehind ? { ledgerStale: true } : {}),
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
    /**
     * 近 26 周的逐日用量（热力图）：**补齐空天**，客户端按周 × 7 铺格子即可。
     * 数据来自日汇总（保留期默认 400 天），所以能看到比账本明细更远的历史。
     */
    heatmap: rollupDailySeries(rollup, { date, days: heatmapDays }).map(row => ({ ...row, amount: toDisplay(row.usd, display) })),
    /**
     * 按模型统计的**全历史**（日汇总口径，比账本明细的保留期长得多）。
     * 排序在宿主侧按金额降序给一份默认顺序，客户端切换「费用 / Token / 命中率 / 每美元 token」时自行重排。
     */
    modelsHistory: {
      since: modelsSince,
      days: modelsDays,
      /** 有记录但没有按模型明细的天数（0.8.0 之前写入的旧数据），如实报缺口。 */
      daysMissingModels: modelsMissing,
      total: modelHistoryRows.length,
      rows: modelHistoryRows.slice(0, modelHistoryLimit),
    },
    basisIds: day.basisIds,
    /** 当前生效的保留期（设置页「显示」分页拿它回填输入框）。 */
    retention,
    /** 峰谷提醒开关（同一分页的两个勾选框）。 */
    notify,
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
