#!/usr/bin/env node
/**
 * 标定 wbfd（WorkBuddy2API panel）的「积分 = 加权 token × 系数」公式。
 *
 * 为什么需要标定：
 *   lib/pricing.js 的 creditsWeight() 把 input / cacheRead / cacheWrite / output /
 *   reasoning **直接相加**再乘 credits —— 这是个未标定的口径。缓存读的单价通常远低于
 *   未命中（panel 侧注释实测 credit≈0.34(全未命中) vs ≈0.02(命中)），同价相加会系统性
 *   高估。要拿本地 token 统计算「当前会话 / 今日积分」，必须先把系数解出来。
 *
 * 真值从哪来：
 *   wbfd 那台网关就是 E:\项目\workbuddy2api-panel。它每次请求把上游末帧 usage.credit
 *   （真实扣费）连同 prompt/completion/total 与 cache hit/miss 一起写进 JSONL 归档
 *   （internal/reqlog/reqlog.go:64-87，`credit_known` 区分「真 0」与「缺字段」），
 *   `GET /panel/api/request_logs` 用同一个 api_key 就能读 —— 这就是现成的标定样本集。
 *
 * 模型：
 *   credit ≈ a·prompt_miss + b·cache_hit + c·completion
 *   三个未知数，用最小二乘解；输出系数、残差 RMS、R² 与样本数。
 *
 * 注意（research/FEASIBILITY.md §3.4 的坑）：
 *   中转网关会注入固定前缀、静默替换模型、忽略参数，token 计数因此未必干净。
 *   所以 R²/残差必须看：残差大 = 线性模型不成立，那就只能读 panel 的真值，不能拿
 *   本地估算当账。留一部分样本做验证也是同样道理（--holdout）。
 *
 * 只读，不发对话请求。
 *   WBFD_BASE / WBFD_API_KEY / WBFD_HOURS / WBFD_LIMIT / WBFD_MIN_SAMPLES
 * 用法：
 *   node research/calibrate-wbfd-credits.mjs            # 最近 7 天
 *   WBFD_HOURS=24 node research/calibrate-wbfd-credits.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const BASE = (process.env.WBFD_BASE ?? 'http://114.66.62.99:7863').replace(/\/+$/, '')
const HOURS = Number(process.env.WBFD_HOURS ?? 168)
const LIMIT = Math.min(Number(process.env.WBFD_LIMIT ?? 1000), 1000)
const MIN_SAMPLES = Number(process.env.WBFD_MIN_SAMPLES ?? 8)

function loadCredentialRefs() {
  const text = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8')
  const refs = {}
  const block = /^refs:\s*$([\s\S]*?)(?=^\S|\Z)/m.exec(text)
  if (!block) return refs
  for (const line of block[1].split(/\r?\n/)) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(\S+)\s*$/.exec(line)
    if (m) refs[m[1]] = m[2]
  }
  return refs
}

const key = process.env.WBFD_API_KEY ?? loadCredentialRefs().WBFD_API_KEY
if (!key) { console.error('missing WBFD_API_KEY（环境变量或 ~/.dsh/.credentials.yaml refs）'); process.exit(1) }
const auth = { authorization: `Bearer ${key}`, accept: 'application/json' }

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`, { headers: auth, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* keep raw */ }
  if (res.status !== 200 || body === null) {
    throw new Error(`${path} -> HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  return body
}

/** "x0.79" / "0.79" / 0.79 → 0.79；其余 → null（与 lib/pricing.js parseCredits 同口径）。 */
function parseCredits(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const m = value.trim().match(/^[x×]\s*([0-9]*\.?[0-9]+)$/i)
  return m === null ? null : Number(m[1])
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ── 最小二乘（正规方程 + 部分主元高斯消元，3×3 足够） ─────────────────────

/**
 * 解 X·β = y。列满秩时返回 β；某列退化（如全部 cache_hit=0）时返回 null 由调用方降阶。
 * @param {number[][]} X 行主序设计矩阵
 * @param {number[]} y
 */
function lstsq(X, y) {
  const n = X[0]?.length ?? 0
  if (n === 0 || X.length < n) return null
  const A = Array.from({ length: n }, () => new Array(n).fill(0))
  const b = new Array(n).fill(0)
  for (let r = 0; r < X.length; r++) {
    for (let i = 0; i < n; i++) {
      b[i] += X[r][i] * y[r]
      for (let j = 0; j < n; j++) A[i][j] += X[r][i] * X[r][j]
    }
  }
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r
    if (Math.abs(A[pivot][col]) < 1e-9) return null // 列共线/退化
    ;[A[col], A[pivot]] = [A[pivot], A[col]]
    ;[b[col], b[pivot]] = [b[pivot], b[col]]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = A[r][col] / A[col][col]
      if (f === 0) continue
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c]
      b[r] -= f * b[col]
    }
  }
  return b.map((v, i) => v / A[i][i])
}

/** 拟合一条模型：列 [miss, hit, out]，退化时依次去列。 */
function fit(samples) {
  const bases = [
    { names: ['miss', 'hit', 'out'], pick: s => [s.miss, s.hit, s.out] },
    { names: ['in', 'out'], pick: s => [s.miss + s.hit, s.out] },
    { names: ['tok'], pick: s => [s.miss + s.hit + s.out] },
  ]
  for (const basis of bases) {
    const X = samples.map(basis.pick)
    const y = samples.map(s => s.credit)
    const beta = lstsq(X, y)
    if (beta === null) continue
    const mean = y.reduce((a, v) => a + v, 0) / y.length
    let sse = 0
    let sst = 0
    for (let r = 0; r < y.length; r++) {
      const pred = X[r].reduce((a, v, i) => a + v * beta[i], 0)
      sse += (y[r] - pred) ** 2
      sst += (y[r] - mean) ** 2
    }
    return {
      names: basis.names,
      beta,
      rms: Math.sqrt(sse / y.length),
      r2: sst > 0 ? 1 - sse / sst : null,
      n: y.length,
    }
  }
  return null
}

// ── 拉数据 ────────────────────────────────────────────────────────────────

const modelsBody = await getJSON('/v1/models')
const list = Array.isArray(modelsBody?.data) ? modelsBody.data : []
const creditsByModel = new Map()
for (const item of list) {
  const c = parseCredits(item?.credits)
  if (item?.id && c !== null) creditsByModel.set(String(item.id), c)
}
console.log(`[models] ${list.length} 条，其中 ${creditsByModel.size} 条带 credits`)

const to = Math.floor(Date.now() / 1000)
const from = to - HOURS * 3600
const logsBody = await getJSON(`/panel/api/request_logs?limit=${LIMIT}&from=${from}&to=${to}`)
const entries = Array.isArray(logsBody?.entries) ? logsBody.entries : []
console.log(`[logs  ] 归档 ${entries.length} 条（窗口 ${HOURS}h，上限 ${LIMIT}）`)

// ── 分模型聚合 ────────────────────────────────────────────────────────────

const byModel = new Map()
let skipped = 0
for (const e of entries) {
  if (e?.credit_known !== true) { skipped++; continue }
  const model = String(e?.model ?? '').trim()
  const prompt = num(e?.prompt_tokens)
  const completion = num(e?.completion_tokens)
  const hit = num(e?.cache_hit_tokens)
  const miss = e?.cache_miss_tokens !== undefined ? num(e.cache_miss_tokens) : Math.max(prompt - hit, 0)
  if (model === '' || prompt + completion <= 0) { skipped++; continue }
  if (!byModel.has(model)) byModel.set(model, [])
  byModel.get(model).push({ credit: num(e?.credit), miss, hit, out: completion })
}
console.log(`[sample] 可用样本 ${entries.length - skipped} 条，跳过 ${skipped}（无 credit_known / 无 token）\n`)

if (byModel.size === 0) {
  console.error('没有可用样本。检查：归档是否开启（logging.request_archive_enabled）、窗口内是否有真实流量、来源字段是否被关掉。')
  process.exit(2)
}

// ── 输出 ──────────────────────────────────────────────────────────────────

console.log('模型'.padEnd(26), 'n'.padStart(4), 'R²'.padStart(7), '残差RMS'.padStart(11), '  系数（积分/token）')
for (const [model, samples] of [...byModel].sort((a, b) => b[1].length - a[1].length)) {
  const credits = creditsByModel.get(model) ?? null
  const tag = credits === null ? '' : ` credits=x${credits}`
  if (samples.length < MIN_SAMPLES) {
    console.log(model.padEnd(26), String(samples.length).padStart(4), '  样本不足', `(需 ≥${MIN_SAMPLES})${tag}`)
    continue
  }
  const res = fit(samples)
  if (res === null) {
    console.log(model.padEnd(26), String(samples.length).padStart(4), '  无法拟合', tag)
    continue
  }
  const coef = res.names.map((n, i) => `${n}=${res.beta[i].toExponential(4)}`).join(' ')
  console.log(
    model.padEnd(26),
    String(res.n).padStart(4),
    (res.r2 === null ? '  n/a' : res.r2.toFixed(4)).padStart(7),
    res.rms.toExponential(3).padStart(11),
    ` ${coef}${tag}`,
  )
  // 每 1M 加权 token 的积分：用它跟 credits 牌价比，看是否等价于「token × credits」。
  const sumCredit = samples.reduce((a, s) => a + s.credit, 0)
  const sumTok = samples.reduce((a, s) => a + s.miss + s.hit + s.out, 0)
  if (sumTok > 0) {
    console.log(
      ''.padEnd(26), ''.padStart(4), ''.padStart(7), ''.padStart(11),
      `   实测 ${(sumCredit / sumTok * 1e6).toFixed(2)} 积分/1M token`
      + (credits === null ? '' : `（token×credits 口径 = ${(credits * 1e6).toFixed(2)}）`),
    )
  }
}

console.log('\n判读：')
console.log('  R² 接近 1 且残差 ≪ 单次积分 → 线性模型成立，系数可接进本地记账（会话/今日都能离线算）。')
console.log('  残差大或 R² 低 → 网关在 usage 上做了手脚（注入前缀 / 换模型 / 忽略参数），')
console.log('  本地估算不能当账，只能读 panel 的 credit 真值。详见 research/FEASIBILITY.md §3.4。')
