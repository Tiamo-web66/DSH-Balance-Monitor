# 供应商类型 / 分开计费 —— 实测后的设计分析

调研时间：2026-10-12（UTC）
证据：`research/out/relay-usage-endpoint.json`、`console-contract-walkcoding_top.json`、`console-contract` chunk 原文在 `research/out/wc/`

---

## 0. 先回答你那个假设

> **⚠️ 本节结论已被 §8.2 更正。** 我当时只找到 `/v1/usage`，漏了 `GET /v1/sub2api/billing` —— **倍率确实能直接用 sk- key 查到**，不用反推。下面保留原始推演过程作为记录，最终口径以 §8.2 为准。

> 「sub 可以通过 key 知道当前分组的倍率吧？然后官方价格×倍率就得出消耗的金额。」

**半对，但拿法跟你想的不一样。**

| 你想的路径 | 实测结果 |
|---|---|
| 用 sk- key 调控制台的「分组倍率」接口 | **❌ 401**。三家同款网关都是 `{"code":"INVALID_TOKEN","message":"Invalid token"}` |
| 用 sk- key 调 `/v1/usage`，用站方给的 `actual_cost ÷ cost` 反推有效倍率 | **✅ 200，直接拿到** |

证据一 —— 控制台接口确实存在，但只认登录态：

```
GET https://walkcoding.top/api/v1/groups/rates      Authorization: Bearer sk-5c43…
→ 401 {"code":"INVALID_TOKEN","message":"Invalid token"}
   （同一路径在 st.walkcoding.top / nanshanyougui.xyz 上完全同款响应 → 三家是同一款网关软件）

GET .../api/v1/groups/rates   不带 Authorization
→ 401 {"code":"UNAUTHORIZED","message":"Authorization header is required"}
```

证据二 —— 同一把 key 在模型面上有账单接口：

```
GET https://walkcoding.top/v1/usage    Authorization: Bearer sk-5c43…
→ 200
{
  "balance": 29.92280799, "remaining": 29.92280799,
  "unit": "USD", "planName": "钱包余额", "mode": "unrestricted", "isValid": true,
  "usage": {
    "today": { "requests":131, "cost":9.27827,  "actual_cost":0.8350443, "cache_read_tokens":12929920, … },
    "total": { "requests":4214,"cost":407.324016,"actual_cost":36.65916144,
               "input_tokens":36867802,"output_tokens":3199436,"cache_read_tokens":556159488, … }
  },
  "model_stats": [
    { "model":"grok-4.7","requests":3139,"cost":310.532816,"actual_cost":27.94795344,"account_cost":310.472816, … },
    { "model":"grok-4.6","requests":1075,"cost":96.7912,   "actual_cost":8.711208,    "account_cost":96.7262,    … }
  ]
}
```

`actual_cost ÷ cost`：

| 站 | 账户级 | 逐模型 |
|---|---|---|
| walkcoding.top | 36.65916144 / 407.324016 = **0.09** | grok-4.7 = 0.09，grok-4.6 = 0.09 |
| st.walkcoding.top | 28.905365388 / 240.8780449 = **0.12** | gpt-6-astra / 5.6-sol / 5.5 / 6-sol / 5.6-terra **全部 0.12** |
| nanshanyougui.xyz | 2.16428696 / 21.6428696 = **0.10** | claude-opus-5.5 = 0.10 |

**站内所有模型倍率一致** ⇒ 这个比值就是「你当前分组生效的总倍率」，只是它由站方自己算出来，比你去读 `groups/rates` 更可靠（后者要登录态，而且拿到的是配置值、不是生效值）。

---

## 1. 由此推翻的结论：别自己乘

「官方价格 × 倍率 = 消耗金额」这个公式**能算，但不该由插件算**：

1. 站方已经把 `cost`（按官方价的原价）和 `actual_cost`（真实扣费）**两列都给出来了**。直接对 `actual_cost` 求和就是真实消耗，误差为零。
2. 自己乘一遍反而引入误差：
   - 你得维护一份「官方价格表」，还得和站方 `cost` 的口径一致；
   - 站方 `cost` 里已经把**缓存读/写、峰谷加成、模型替换后的实际后端价**都揉进去了。我从零自己算，只会比它更差。
3. **倍率降级为展示量**：`倍率 = actual_cost / cost`，由数据反推，不参与计费。这比"读倍率→算金额"少一个失败点（读不到倍率就崩），对用户也更有信息量（能直接看到"我实际只付了 9%"）。

**唯一必须自己算的是 DeepSeek 官方**——因为官方只给余额快照，不给任何用量接口（见 `FEASIBILITY.md` §1）。所以要"分开计费"，分开的其实是这两类：

- **需要本地计价**：DeepSeek 官方（token × 峰谷价）
- **站方自己报账**：所有中转站（读它报的 `actual_cost` / `quota.used`）

---

## 2. 指纹 → 数据源 对照（**分类口径已被 §8 修正，以 §8 为准**）

| 类型 | 指纹（探一次就能判） | 余额 | 消耗 | 倍率 | 实测样本 |
|---|---|---|---|---|---|
| **DeepSeek 官方** | host `api.deepseek.com` | `GET /user/balance` → `balance_infos[].total_balance` | ❌ 无接口；平台登录态链路有 `total_costs` | 无（自己按峰谷价算） | ✅ 已实测 |
| **New API 系**（原版 one-api/new-api） | `GET /api/status` 200 且含 `quota_per_unit`；`GET /api/pricing` 200 且含 `group_ratio` | `/dashboard/billing/subscription`（sk- 可读，但 `*_limit_usd` 是**总额度**不是余额） | `/dashboard/billing/usage`；new-api 另有 `/api/usage/token/` 给原始 quota 整数 | `/api/pricing` 的 `group_ratio`（**免鉴权**，但本批 6 家一个都没有） | ⚠️ 这 6 家里**一家都不是**，仅源码级结论 |
| **钱包余额型**（我建议就用这个名字，替代含糊的 "Sub"） | `GET /v1/usage` 200 且 `mode=unrestricted` + `planName` 存在 | ✅ `balance` / `remaining` + `unit` | ✅ `usage.total.actual_cost`，且 `usage.today` / `daily_usage[]` 可做日曲线 | ✅ `actual_cost/cost`，且 `model_stats[]` 给逐模型 | ✅ walkcoding.top / st.walkcoding.top / nanshanyougui.xyz **三家同款**，一个适配器通吃 |
| **订阅配额型** | `GET /v1/usage` 200 且 `mode=quota_limited` + `quota.limit` 存在 | ✅ `quota.remaining` + `unit` | ✅ `quota.used` / `quota.limit`（百分比） | ✅（同法） | ✅ jiuhaoche（`expires_at: 2027-02-10`，剩 122 天，套餐 5644.84 USD 已用 99.75%） |
| **WorkBuddy / 积分倍率型** | `/v1/usage` 404，但 `/v1/models` 每模型带 `credits` | ❌ 无 | ✅ **已落地**：同一把 key 读它自带面板的 `/panel/api/usage`（站方全量）与 `/panel/api/request_logs`（按 `client_ip`/`user_agent` 过滤 = 自身口径）；真值 `usage.credit` 逐请求落归档 | ✅ 直接读：`credits: "x0.79"` | ✅ wbfd（114.66.62.99:7863），实现见 `lib/workbuddy.js` / README 第一节 |

> 关于 "New"：你列表里有它，但这批 6 家**没有一家是原版 New API**——`/api/status`、`/api/pricing`、`/api/ratio_config` 全线 404/400。所以 New 型适配器只能按源码契约先写，等你给出真正跑 New API 的站再验。

---

## 3. 建议：类型选择器留作"覆盖"，默认让插件自动指纹判定

你的方案是「添加供应商时选类型」。我建议改成 **自动判定 + 手动覆盖**：

```
探测顺序（每一步都只读，一次就够）
  1) host == api.deepseek.com                        → deepseek-official
  2) GET {base}/v1/usage
       200 且 mode=quota_limited / 有 quota.limit     → sub-quota     （订阅配额型）
       200 且 mode=unrestricted / 有 planName         → wallet        （钱包余额型）
       401/404                                        → 下一步
  3) GET {base}/v1/models （带 key）
       200 且模型对象含 credits                        → credit-rate   （WorkBuddy 型）
  4) GET {origin}/api/status （免鉴权）
       200 且含 quota_per_unit                         → newapi
  5) 全不中                                            → unknown（回落到「手填端点 + extract 表达式」）
```

理由：探一次 `/v1/usage` 比让用户判断「我这站算哪种」准确得多——**用户根本分不清**「钱包余额型」和「订阅配额型」，而且同一款软件的不同部署可能一个是充值钱包、一个是套餐（jiuhaoche 就是后者）。手动覆盖仍然保留，用于自动探测被墙/被改的情况。

顺带：这套指纹识别的开销 = **1 次请求**，且和后面每次刷新的请求完全重叠（刷新本来就要打 `/v1/usage`），不额外增加流量。

---

## 4. 前端契约是怎么拿到的（可复跑）

不走路径猜测：读这家站**公开的**控制台前端，接口名就写在它自己的 JS 里。

```bash
node research/probe-console-contract.mjs https://walkcoding.top
```

从 `assets/groups-*.js`（251B，全文如下）拿到真·分组倍率接口：

```js
async function e(){const{data:a}=await t.get("/groups/available");return a}
async function r(){const{data:a}=await t.get("/groups/rates");return a||{}}
const n={getAvailable:e,getUserGroupRates:r};
```

从 `assets/peak-rate-*.js`（279B，全文）拿到**分组级峰谷**的定义——这跟 DeepSeek 官方的错峰是两套东西：

```js
function r(a){return!!(a!=null&&a.peak_rate_enabled&&a.peak_start&&a.peak_end)}
function t(a){return a?`UTC${a}`:""}
function o(a,e){if(!r(a)||!a)return"";const n=`${a.peak_start}-${a.peak_end} ×${a.peak_rate_multiplier??1}`;return e?`${n} (${e})`:n}
export{o as f,r as h,t as s};
```

即分组对象带 `peak_rate_enabled / peak_start / peak_end / peak_rate_multiplier`，控制台按 `UTC{start}-{end} ×{multiplier}` 展示。

**对"谷峰"功能的影响**：要分两层做，不能混为一谈。

| 层 | 数据源 | 怎么拿 |
|---|---|---|
| DeepSeek 官方错峰 | 官方定价页（正文一段话） | 本地算：峰=UTC 01–04、06–10 周一至五（不含中国法定节假日），谷=其余；谷=峰×50%。节假日表自带 |
| 中转站自己的峰谷倍率 | 站方分组配置或实测 | `peak_rate_*` 要登录态；**但可以反推**：逐日算 `actual_cost/cost`，如果逐日比值出现阶跃，那个时段就是该站的峰时段、阶跃幅度就是 `peak_rate_multiplier` |

第三类**实测反推**是白捡的：`daily_usage[]` 每天一条，逐日算比值就能看出峰谷结构，不需要登录态，也不受站方改配置影响。

---

## 5. 两个必须处理的坑

1. **同账户多入口会重复计数。** `walkcoding.top` 与 `st.walkcoding.top` 返回**同一个 `balance = 29.92280799`** —— 同一账户的两个前端。插件若把它们当两个供应商各自统计"已花"，用户看到的会是双倍。→ 需要用 `balance` + `usage.total` 指纹去重，或在 UI 上标注"检测到同账户"。
2. **`daily_usage` 求和 ≠ `usage.total`。** walk-grok 的 `daily_usage` 覆盖 11 天、`usage.total` 覆盖 4214 次请求全部；我用日表求和算出的倍率是 0.09（恰好一致），但 walk-gpt 日表只有 6 天、求和算出 0.12 与 `usage.total` 恰好也一致——**这是运气**。任何合计口径都必须优先用 `usage.total`，日表只用于画曲线。

---

## 6. 顺带解决的一个遗留疑点

`FEASIBILITY.md` 里挂着的「jiuhaoche 的 `quota_per_unit` 未核实」，现在核实了：

```
GET /v1/usage        → quota.remaining = 14.022035  USD,  quota.used = 5630.813665  USD
GET /api/user/self   → quota           = 7014265,          used_quota   = 2815403585
5630.813665 × 500000 = 2 815 406 832.5   vs  2 815 403 585   → 差 3247，正是我在两次读取之间那次测试调用扣掉的量
14.022035   × 500000 = 7 011 017.5       vs  7 014 265       → 差 3247 同量级（时间偏移）
⇒ 该站 1 USD = 500000 quota，与 one-api/new-api 默认口径一致，**已证实**
```

同时 jiuhaoche 的 `usage.today` 也给了 `cost: 0.005074` / `actual_cost: 0.006494` → 今日有效倍率 **1.28（加价）**，与前面三家的 0.09/0.10/0.12（折扣）方向相反。**不同站的倍率符号都可能不同，别在 UI 上写死"倍率越高越贵"这类文案。**

---

## 7. 结论摘要

1. **倍率 sk- key 能直接读**：`GET /v1/sub2api/billing` → `effective_rate_multiplier`，还附带 `group_rate_multiplier` / `resolved_rate_multiplier` / `user_rate_multiplier` / `peak_*` 的完整分解（详见 §8.2）。控制台的 `/api/v1/groups/rates` 才要 JWT，但已经用不上了。
2. **不要自算中转站消耗**：站方给了 `actual_cost`，直接读。自算的公式（官方价 × 倍率）只在 **DeepSeek 官方**那一条链路需要。
3. **最终就是 3 个适配器**：`Sub2Api` / `DeepSeek官方` / `WorkBuddy`（原方案里的 `New` 已按你的决定去掉）。
   - Sub2Api：`/v1/usage`（余额+消耗）+ `/v1/sub2api/billing`（倍率），两条都是 sk- key
   - DeepSeek官方：`/user/balance`（API key）+ 平台 `get_user_summary`（登录态，能给 `total_costs`）
   - WorkBuddy：`/v1/models` 的 `credits` 倍率；无余额接口
4. **峰谷分两层**：DeepSeek 官方错峰本地算；sub2api 的峰谷直接读 `peak_*` / `applied_peak_multiplier`，并用采样曲线反推做兜底。
5. **类型自动判定比手选可靠**：探一次 `/v1/usage` + `/v1/sub2api/billing` 就能读出 `mode`/`planName`/`quota`/倍率，用户分不清自己是钱包还是套餐（jiuhaoche 就是套餐）。选择器留作覆盖。

---

## 8. Sub2Api 源码级核实（`Wei-Shaw/sub2api` @ `9591136`）

上一轮我把实测到的「钱包余额型」和「订阅配额型」当成两个**类型**，**这是错的**：它们是**同一个 sub2api 的两种 `mode`**，由 `apiKey.Quota > 0 || apiKey.HasRateLimits()` 在运行时决定。所以按你的枚举，只要 **3 个适配器**：

```
Sub2Api · DeepSeek官方 · WorkBuddy
```

已验证：walkcoding.top / st.walkcoding.top / nanshanyougui.xyz / jiuhaoche（`quota_limited` 那份）**全部跑的是 sub2api**。

### 8.1 余额：能查 ✅

```go
// backend/internal/server/routes/gateway.go:210
gateway.GET("/usage", h.Gateway.Usage)
```

```go
// backend/internal/handler/gateway_handler.go:1585
// Usage handles getting account balance and usage statistics for CC Switch integration
// GET /v1/usage
// Two modes:
//   - quota_limited: API Key has quota or rate limits configured. Returns key-level limits/usage.
//   - unrestricted:  No key-level limits. Returns subscription or wallet balance info.
```

鉴权 = **API key**（`GetAPIKeyFromContext`），即 sk- key。响应分支（逐字段核对过实现）：

| mode | 触发条件 | 返回 |
|---|---|---|
| `quota_limited` | `apiKey.Quota > 0` 或 `HasRateLimits()` | `quota{limit,used,remaining,unit:"USD"}`、`rate_limits[]{window:5h/1d/7d,limit,used,remaining,window_start,reset_at}`、`expires_at`、`days_until_expiry` |
| `unrestricted` → 订阅分支 | 分组是订阅类型 | `subscription{daily/weekly/monthly_usage_usd, daily/weekly/monthly_limit_usd, weekly_window_start, expires_at}` + `remaining` |
| `unrestricted` → 钱包分支 | 其他 | `balance`、`remaining`、`unit:"USD"`、`planName:"钱包余额"` |

两种 mode 都还会带：`usage{today,total}`、`daily_usage[]`、`model_stats[]`。

可用 query（`parseUsageDateRange`）：`days`（1–90）、`start_date` / `end_date`（默认近 30 天）。
`model_stats[]` 字段：`model, requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost, actual_cost, account_cost`。

> 这个接口是**为 CC Switch 生态准备的余额查询口**，等于事实标准。插件照它做，兼容面最大。

### 8.2 倍率：**能直接查** ✅（`/v1/sub2api/billing`）

> **更正**：本文档早前版本写过「倍率 key 面读不到，只能反推」——**那是错的**。sub2api 有一个专门的、key 可读的倍率接口，我漏了它。以下为源码 + 实测双重确认。

```go
// backend/internal/handler/gateway_key_billing.go:33-35
// KeyBillingInfo returns the token billing multiplier effective for the authenticated API key.
// GET /v1/sub2api/billing
func (h *GatewayHandler) KeyBillingInfo(c *gin.Context) {
```

```go
// backend/internal/server/middleware/api_key_auth.go:168-172
billingInfoRequest := c.Request.URL.Path == "/v1/sub2api/billing"
skipBilling := c.Request.URL.Path == "/v1/usage" || billingInfoRequest || isAsyncImageTaskRead(...)
```

即：只鉴权、**不计费**、`Cache-Control: no-store`。鉴权就是 sk- key。

实测（同一把 key，与 `/v1/usage` 完全一致）：

| 站 | `group_rate_multiplier` | `resolved_rate_multiplier` | `peak_rate_enabled` | `effective_rate_multiplier` |
|---|---|---|---|---|
| walkcoding.top | 0.09 | 0.09 | false | **0.09** |
| st.walkcoding.top | 0.12 | 0.12 | false | **0.12** |
| nanshanyougui.xyz | 0.10 | 0.10 | false | **0.10** |
| jiuhaoche | 1 | 1 | false | **1** |

原始响应：

```json
{"object":"sub2api.key_billing","schema_version":1,"billing_scope":"token",
 "group_rate_multiplier":0.09,"resolved_rate_multiplier":0.09,
 "peak_rate_enabled":false,"effective_rate_multiplier":0.09,
 "observed_at":"2026-10-12T13:48:37.361999438Z"}
```

字段语义（`keyBillingInfoResponse` 全量 + `buildKeyBillingInfo` 实现）：

| 字段 | 含义 |
|---|---|
| `object` | 固定 `"sub2api.key_billing"` |
| `schema_version` | 当前 `1` |
| `billing_scope` | 固定 `"token"`（token 级计费） |
| `group_rate_multiplier` | `Group.RateMultiplier` —— 该 key 所属分组的倍率 |
| `user_rate_multiplier` | **仅当**用户专属倍率覆盖了分组倍率时才出现（`omitempty`） |
| `resolved_rate_multiplier` | 解析后倍率 = 用户专属覆盖 ?? 分组倍率 |
| `peak_rate_enabled` | 分组高峰倍率是否启用 |
| `peak_start` / `peak_end` / `peak_rate_multiplier` / `applied_peak_multiplier` | **仅 `peak_rate_enabled=true` 时出现**；`applied` 是"此刻"的峰谷因子 |
| `effective_rate_multiplier` | **最终生效倍率 = `resolved_rate_multiplier × applied_peak_multiplier`** ← 这才是该乘进价格的数 |
| `timezone` | 仅 peak 开启时出现（`timezone.Location()`，高峰窗口按此判定） |
| `observed_at` | UTC 时间戳 |

错误形态：

| 状态 | code | 场景 |
|---|---|---|
| 401 | `authentication_error` | key 无效/缺失 |
| 404 | `not_found_error` | `RunModeSimple` 下不支持 |
| 403 | `permission_error` | key 未绑定分组 |
| 500 | `api_error` | 其它 |

**与 admin 面的关系**：sub2api 自己探测上游账单时，打的**就是**这个路径 ——

```go
// backend/internal/service/upstream_billing_probe.go:659
probeURL := buildOpenAIEndpointURL(normalizedBaseURL, "/v1/sub2api/billing")
```

探测回来的快照存进上游账号的 `extra.upstream_billing_probe`，并可自动回写 `accounts.rate_multiplier`（开关 `upstream_billing_rate_sync_enabled`，上限 `100.0`）。运维面读它用：

- `GET /api/v1/admin/accounts/upstream-billing-rates` —— **上游倍率**快照列表
- `POST /api/v1/admin/accounts/:id/upstream-billing-probe` —— 手动探一次
- `GET /api/v1/admin/groups/:id/rate-multipliers` —— 分组倍率配置
- `GET /api/v1/admin/accounts/:id/balance` —— 上游账号余额

这些走 `adminAuth`，凭据是 **`x-api-key: <admin-api-key>`** 或管理员 JWT（`admin_auth.go:26`），**不是用户 sk- key**。所以「上游倍率」和「本站生效倍率」是两把不同的钥匙。

### 8.2.1 一个必须记下的口径分歧

jiuhaoche 上 `effective_rate_multiplier = 1`，但同一时刻 `/v1/usage` 的 `usage.today` 给出 `cost=0.005074 / actual_cost=0.006494`（比值 **1.28**）。两者对不上。

样本只有 2 次极小请求（合计 0.005 美元量级），无法断定是"该站 `cost` 用了不同的上游价表"还是"小额舍入噪声"。

**插件规则：以 `/v1/sub2api/billing` 的 `effective_rate_multiplier` 为准（权威、直接、无歧义）；`actual_cost/cost` 只做交叉校验，差值超阈值时告警而不是覆盖。**


**顺带记下**：用户面还有一条 `GET /api/v1/groups/rates`（`GetUserGroupRates`），挂在 JWT 组下，实测 sk- key 得 401 `INVALID_TOKEN` —— 但这条**已经用不上了**，`/v1/sub2api/billing` 给的信息更全。

```go
// backend/internal/server/routes/user.go
authenticated.Use(gin.HandlerFunc(jwtAuth))   // ← 整个组要登录态
groups.GET("/rates", h.APIKey.GetUserGroupRates)
```

`PeakMultiplierAt` 的精确语义（`service/group.go:315`，源码注释原文）——**这是峰谷监控的关键，`/v1/sub2api/billing` 的 `applied_peak_multiplier` 就是它算出来的**：

- **只对订阅类型分组生效**（`!g.IsSubscriptionType()` → 直接返回 `1.0`）
- 区间左闭右开 `[PeakStart, PeakEnd)`，**仅当日区间，不支持跨天**（`22:00-02:00` 会被 `ValidatePeakRateConfig` 拒绝）
- 时刻按 **全局系统时区** `timezone.Location()` 判定（`/v1/sub2api/billing` 在 peak 开启时会把该时区名回给客户端）
- 未启用 / 配置非法 / 非高峰 → 返回 **`1.0`**（安全降级）
- `multiplier = 0` 合法（高峰计费为 0，可做折扣/免费）
- 校验：`enabled = true` 时**仅允许订阅类型分组**

计费链：`api_key_auth_cache.go:126` — 「token 计费倍率额外乘以 PeakRateMultiplier」，即

```
effective_rate_multiplier = resolved_rate_multiplier × applied_peak_multiplier
                          = (用户专属覆盖 ?? 分组倍率) × PeakMultiplierAt(now)
```

**所以峰谷有两条独立来源，插件应该两条都用**：

1. **接口直读**（首选）：`peak_rate_enabled` / `peak_start` / `peak_end` / `peak_rate_multiplier` / `applied_peak_multiplier` / `timezone` + 每次轮询更新的 `observed_at`
2. **曲线反推**（兜底）：把 `effective_rate_multiplier` 按 15/30 分钟采样存下来，出现阶跃的时段就是高峰窗口、阶跃幅度就是 `peak_rate_multiplier`。这条对**只给 sk- key 的站**依然成立，且标准/钱包分组恒为 1.0（因为 `PeakMultiplierAt` 对非订阅分组直接返回 1），能干净地排除干扰。

### 8.3 顺带：sub2api 自己也用官方余额接口查上游

```go
// backend/internal/service/cn_provider_balance_service.go:23
//   - DeepSeek：GET https://api.deepseek.com/user/balance (Bearer)
//               → balance_infos[].total_balance + is_available
```

与 `FEASIBILITY.md` §1.1 的官方链路设计完全一致，说明这个口径是行业惯例，不是我们臆造。

### 8.4 对插件的影响

1. **Sub2Api 一个适配器搞定两种形态**：拉 `/v1/usage` → 按 `mode` 分支渲染（额度窗口 vs 钱包余额），不需要用户选。
2. **倍率一次请求直读**：`GET /v1/sub2api/billing` → `effective_rate_multiplier`，且能拆出「分组倍率 / 用户专属覆盖 / 峰谷因子」三层给用户看。**不要再用 `actual_cost/cost` 当主口径**，只做交叉校验。
3. **峰谷有两条独立来源**：首选接口直读 `peak_*` + `applied_peak_multiplier` + `timezone`；兜底用 `effective_rate_multiplier` 的时序采样反推阶跃。两条都不需要登录态。
4. **对 Sub2Api 的两个请求都很轻**：`/v1/sub2api/billing` 不计费、`Cache-Control: no-store`，`/v1/usage` 也只读。但要注意面板限流（`panelRateLimiter`）与网关限流，轮询间隔别低于 60s。
5. **不要碰** `dashboard/billing/*`（那是 one-api/new-api 的路，sub2api 上会回落成前端 HTML，实测 5 家全中）；也不要碰 `/api/v1/groups/rates`（JWT 专用）。
6. **可选运维增强**：若用户提供 `x-api-key: <admin-api-key>`，还能读上游倍率快照（`/api/v1/admin/accounts/upstream-billing-rates`）与上游账号余额（`/api/v1/admin/accounts/:id/balance`）。这是独立档位，不影响主流程。
