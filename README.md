# dsh-balance-monitor

在 DeepSeek Harness 里把「这些中转站到底花了多少钱」变成能看、能管、能对账的一套东西；另外附带三件顺手的能力：图片模态补全、侧栏「进行中 / 待查看」会话轨道、右栏路径复制。

贯穿全插件的一条硬规定：**金额在调用发起的那一刻算定，之后只加总、不重算**。改价目、改峰谷窗口、换币种、换汇率，都只影响之后的调用，已入账的历史一分不动。

## 功能总览

| 能力 | 在哪 | 说明 |
|---|---|---|
| 供应商类型 | 设置 → 模型 | 每张卡片选 **其他**（默认，什么都不做）/ **Sub2Api**（额度、倍率、按 `官方价 × 生效倍率` 算花费）/ **WorkBuddy**（今日积分，不折成钱、不进金额合计）。`New API` 暂不做 |
| 额度与倍率 | 设置 → 模型 | Sub2Api 站查额度、生效倍率、模型清单；WorkBuddy 站读面板积分 |
| 花费记账 | 后台 | 包裹 `llm/stream`，每次调用按当时的价目 × 倍率 × 积分倍率入账，之后只加总 |
| 费用报表 | 设置 → 余额与费用 | 概览 / 额度 / 用量 / 价格 / 显示 五个分页 |
| 侧栏常驻 | 侧栏底部 | 余额、今日花费、峰谷倒计时；模型花费卡片可开关（峰谷表 / 价格表默认不显示） |
| 进行中 / 待查看会话 | 侧栏工作区顶部 | 待处理与正在跑的会话集中列出；完成未读的会话单独进「待查看」组；折叠的工作区显示运行徽章。**不写 Pin、不重排工作区** |
| 本会话费用 | 会话输入区 | 默认在**输入框下方**，也可换到输入框上方或会话标题栏；给 金额 · 调用数 · token · 命中率 |
| 额度横条 | 输入框上方 | 预算已用 % / 今日 / 峰谷 / 余额，点一下刷新 |
| 右下角角标 | 会话右下 | 今日金额 + 峰谷档位（可带 Top-1 模型） |
| 图片模态补全 | 设置 → 模型 | 给没声明 `input` 的模型补上 `image`，新供应商不用逐个勾 |
| 复制路径 | 右栏「文件」 | 复制当前目录 / 当前文件的绝对路径，不碰文件内容 |

两条官方路线（`deepseek-official` / `deepseek-account`）**没有**「供应商类型」。余额走官方接口；拿 `api.deepseek.com` 去探中转站的 `/v1/usage` 只会 404，所以那一格不渲染。

---

## 一、供应商类型与数据来源

### Sub2Api 型（倍率站）

上游项目：[`Wei-Shaw/sub2api`](https://github.com/Wei-Shaw/sub2api)。三个接口都是 sk- Key 可读的只读接口（已实测）：

| 接口 | 拿到什么 |
|---|---|
| `GET {root}/v1/usage` | `mode` / `quota{limit,used,remaining}` / `rate_limits[]` / `subscription{...}` / `balance` / `unit` / `planName` / `usage{today,total}` / `daily_usage[]` / `model_stats[]` |
| `GET {root}/v1/sub2api/billing` | `group_rate_multiplier` / `user_rate_multiplier` / `resolved_rate_multiplier` / `peak_rate_enabled` / `peak_start` / `peak_end` / `peak_rate_multiplier` / `applied_peak_multiplier` / **`effective_rate_multiplier`** / `timezone` |
| `GET {root}/v1/models` | 模型清单 |

`root` 由 provider 的 `baseURL` 归一得到：结尾的 `/v1` 会被剥掉，但 `/api/<name>` 这类子路径挂载不会被截断
（`https://walkcoding.top/v1` → `https://walkcoding.top`；`https://nexus.itssx.com/api/grok45` → 原样）。

**花费怎么算**

```
官方价金额 = /v1/usage 里的 cost        （站方按上游官方价算出来的原价）
花费       = 官方价金额 × effective_rate_multiplier
站方实扣   = /v1/usage 里的 actual_cost  （只用于交叉校验）
```

`cost` 是站方自己给的，所以**插件不需要维护任何价格表**。

用量口径优先级：`usage.total`（累计，权威）→ `usage.today`（部分站不返回 total）→ `model_stats` 求和。
界面会标明当前显示的是「累计 / 今日 / 逐模型合计」，不会混着算。

`乘出来的花费` 与 `站方实扣` 差值超过 2% 时置 `mismatch` 并在界面上标注
（jiuhaoche 实测存在 `effective=1` 而 `actual/cost=1.28` 的口径分歧），**以接口倍率为准，不会被反推值覆盖**。
界面不只标「不一致」，还给**结构化原因**（宿主管算事实、客户端按语言拼句子）：差多少倍、
高还是低、倍率接口是不是报的 1（＝多半不按「官方价 × 倍率」这条公式计费）、
以及逐模型反推倍率的区间（＝站方按模型逐个定价）。

### WorkBuddy 型（积分倍率站）

上游项目：[`Sliverkiss/workbuddy2api`](https://github.com/Sliverkiss/workbuddy2api) 系分支
`workbuddy2api-panel`：把 CodeBuddy 账号包装成 OpenAI 兼容网关，**自带一个 Web 管理面板**。
指纹与数据源（已实测）：

| 接口 | 拿到什么 |
|---|---|
| `GET {base}/v1/usage` | **404** —— 不是 Sub2Api，没有额度接口 |
| `GET {base}/v1/models` | 模型清单，每个模型带 **`credits`** 积分倍率（`"x0.79"`）—— 这是指纹 |
| `GET {origin}/panel/api/usage` | **站方口径**：整个账号池（含所有买家）的积分、缓存命中/未命中 token、逐账号与逐模型分解 |
| `GET {origin}/panel/api/request_logs` | 逐请求归档：**`credit` 真值** + 调用来源 `client_ip` / `user_agent` |

面板与 `/v1/*` **共用同一把 `api_key`**（面板走同一个 `httpauth.VerifyBearer`），所以一把 key 既能对话也能读账。
面板地址取 `baseURL` 的 **origin**（丢掉 `/v1`）。

**两个口径必须分开，不能混**：

- **自身口径**（界面「今日」用的就是这个）：`request_logs` 按 `client_ip` / `user_agent` **包含匹配**过滤后
  求和。默认过滤串是 `deepseek-harness`（DSH 自己的出站 UA 前缀），所以**默认就是「只算我的」**。
  改条件：`POST /plugins/dsh-balance-monitor/credits/filter { provider, userAgent?, clientIp? }`，传空串清掉该项。
- **站方口径**：`panel/api/usage` 的 `totals.credits` 是**站长整个账号池**的量，包含所有买家 ——
  界面只把它当对照显示（「站方全量」），**不当成「我的消耗」**。

三个会**静默算错**的边界，代码里都如实标出来：

1. `request_logs` 的 `limit` 上限 1000 且**没有分页**（对端只取归档尾部最近 N 条）→ 按小时切窗逐个读；
   某窗返回满 1000 条即标记 `truncated`，界面提示「可能漏数」，**不假装完整**。
2. `credit_known` 区分「上游返回了真 0」与「上游没给 credit 字段」→ 后者单独计数（`ownUnknown`），
   **不当 0**，也不当完整。
3. 归档默认只留 7 天（`logging.request_retention_days`）→ 只有「今日」这种窗口可靠。

**积分不是钱**：这类站没有余额接口，也没有可用于换算的基准价，所以积分**既不折算货币、也不并入
任何金额合计**（侧栏的「今日积分」是替换掉那一行的数值，`total.usd` / 模型花费卡片一个字节都不动）。
侧栏的积分块**只读内存缓存、不额外打面板** —— 侧栏是常驻轮询，每次轮询都去问一遍会把探测节奏放大。

### DeepSeek 的两条路线

登录 DeepSeek 账号后，宿主里会有**两个** DeepSeek 供应商，它们是**两份不同的钱**：

| 界面名 | provider id | 认证 | 余额来源（实测） |
|---|---|---|---|
| `DeepSeek` | `deepseek-official` | `Authorization: Bearer`（API Key） | `api.deepseek.com/user/balance` → 例：`-0.01 CNY` |
| `DeepSeek Account` | `deepseek-account` | `x-dsh-auth-token`（宿主 `deepseekAccount` 服务签发） | `platform.deepseek.com/api/v0/users/get_user_summary` → 例：`normal_wallets -0.04` + `bonus_wallets 29.89` = **总额 ¥29.84**（与推理域 `total_balance` 一致） |

- **怎么知道有哪些 key**（两条路一起用）：
  1. **按候选名探测**：宿主凭据服务没有枚举 refs 的接口（`listRecords()` 只覆盖 `records:` 段），
     所以插件用 `credentials.describe(ref)` 逐个问（只回「有没有配 / 来源」，**不读值**）：
     默认扫 `DEEPSEEK_API_KEY`、`DEEPSEEK_API_KEY_2`…`_9` 与 `DEEPSEEK_KEY*`（共 18 个），
     扫描范围可用 `deepseekKeyPrefixes` / `deepseekKeyMaxIndex` 改（设置页「显示 → 密钥扫描」）。
  2. **读凭据文件的引用名**：直接解析 `~/.dsh/.credentials.yaml` 里 `refs:` 段的**键名**
     —— 命名再怪也列得全。**只取键名，值连读都不读**（正则只捕获冒号前的名字，不在结果里）；
     关掉的方式是 `state.json` 的 `scanCredentialsFile: false`，插件就退回纯候选名探测。
- **多把 key**：宿主自己的 DeepSeek API Key 适配器只认一把（`apiKeyEnv` 是单值），想按多把 key 汇总
  就用 `deepseekKeys` 列引用（字符串或 `[{ ref, label }]`）——**侧栏余额 = 各把 key 之和**，
  币种不一致时不显示总额。没填 label 的引用会按名字派生一个短标签（`DEEPSEEK_API_KEY_2` → `API KEY 2`）。
  ⚠️ 这里列出的 key **只用于查余额，不会被宿主拿去发请求**；宿主始终只用 `apiKeyEnv` 那一把。
  如果 `deepseekKeys` 没把 `apiKeyEnv` 列进去，侧栏总额就不会包含宿主真正在用的那把——
  主 key 扣到负数时，总额仍可能看着很高。
- **自动换 key**（默认开，`state.json` 里 `"autoKeySwitch": false` 可关）：只对 **API Key 路线**
  （`deepseek-official`）生效，且 `deepseekKeys` 里至少有一把别的 key。每次 `llm/stream` 真正
  发请求前检查活跃 key：官方 `is_available=false` 或余额 ≤ 0 时，按余额从大到小挑一把可用 key，
  把它的**值写进当前 `apiKeyEnv` 引用**（`credentials.set`）——下一次 `credentials.resolve()`
  立即看到新 key。被换下的 key 如果还有正余额，会先备份到 `DEEPSEEK_API_KEY_REPLACED`，不会丢。
  换完后侧栏明细里对应的 key 标「使用中」，并显示一行「主 key 已自动从 X 切到 Y」。
  如果宿主主 key 不在 `deepseekKeys` 里，明细会单独列一行「主 key · 使用中」——避免把
  7 把备用 key 的合计误当成宿主能用的余额。
  ⚠️ 侧栏点「DeepSeek」只决定**看哪份余额**；会话实际走哪条路线由模型选择器决定。
  自动换 key 只对 `deepseek-official`（API Key 路线）生效，`deepseek-account` 不换。
  如果请求发出后才发现 402/QUOTA（余额检查还没刷新），本次请求仍会失败；插件会把这把
  标成不可用，**下一次请求前**换到有余额的那把。当前请求不会自动重试（宿主没有请求内换 key
  的钩子，插件也不伪造重试）。
- **卡片上的密钥编辑区**：**只渲染在 API Key 路线**（`deepseek-official`）的卡片上。
  账号路线（`deepseek-account`）不吃 key —— 它用宿主 `deepseekAccount` 服务的登录 token，路线本身
  没有 `apiKeyEnv`：候选名一个都推不出来、`/keys` 恒回空列表、`nextRef` 是 `null`（在那个输入框里
  填值点「保存 key」只会拿到 400「没有可用的引用名（候选都占满了）」），所以它不渲染这一块。
  在 API Key 卡片的「添加 key」行里直接填 key → `PUT /keys`
  写进宿主凭据库（顺位引用名，或自己填 `ref` / `label`），每行可删（**主 key 拒绝删**，
  要换请走卡片上方宿主自己的「API 密钥」）。默认**不预取明文**，点行内小眼睛才 `POST /keys/reveal`
  拉一次值；该路由只认「属于这条路线」的引用（别的引用一律 403）。
- 侧栏**余额行点一下就在两条之间切换**（`余额 · DeepSeek ⇄ ¥0.01` → `余额 · DeepSeek Account ⇄ ¥29.64`），
  选择记在 `localStorage['balance-monitor:sidebar-balance']`；只有一条路线时不可点（提示里说明）。
- 账号路线的 token 由宿主服务签发（只有宿主拿得到），插件**不读**磁盘上的凭据值
  （唯一碰 `~/.dsh/.credentials.yaml` 的地方是上面那条「只取键名」）；
  平台端点失败时回落到推理域（同一 token 也认，但金额被官方四舍五入到 2 位），并标注来源
  （`account-platform` / `account-api` / `api-key`）。
- **两条都按官方计价**：不打站方倍率，也不算「未定价」。
- 设置页「概览 → 官方账户余额」把两条并列显示；「刷新余额」两条一起刷（也可指定 `provider`）。

---

## 二、钱是怎么算出来的

「一次调用花了多少钱」必须在**调用发起的那一刻**把档位固定下来再算，否则峰谷一过、
倍率一变，历史金额会跟着变。计价模块把三家来源归一成**三层相乘**（纯函数、零依赖）：

```
金额 = 单位价档位（官方峰谷选列，本地算）      tierFor()
     × 站方账户倍率（含站方峰谷因子，快照 + 本地复算）  resolveProviderRate()
     × 积分倍率（credits 型站，按模型静态）      creditsOf()
```

### 官方峰谷与站方峰谷是两件事

不能合并成一个窗口表：官方峰谷是「在价表里选两列价之一」（谷价列 / 峰价列）；
站方峰谷是「乘在金额上的因子」。两者时区来源、语义、是否需要网络都不同，合并会同时算错两边。

| | DeepSeek 官方（本地手配） | Sub2Api 站方（接口） |
|---|---|---|
| 来源 | 官方公告 → 本地配置 | `/v1/sub2api/billing` 快照 + 本地复算 |
| 时区 | 固定北京时间，窗口用 **UTC 小时**表达 | 站方 `timezone`（IANA 名，`Intl` 判定） |
| 作用位置 | 选价表档位 | 乘到金额上的因子 |
| 附加规则 | 周末全谷、法定调休、生效时刻、调价历史 | 仅订阅型分组、非法/非峰 → 1.0、`multiplier=0` 合法 |
| 网络 | 不需要 | 快照 60s + 峰谷边界刷新 |

官方侧默认值（`DEFAULT_OFFICIAL_PEAK`）—— `state.json` 的 `officialPeak`（或设置页
「显示 → 官方峰谷」）就是按这个结构**逐字段**覆盖它：

```json
{
  "enabled": true,
  "effectiveAt": "2026-08-01T00:00:00Z",
  "weekendOffPeakFrom": "2026-08-22T16:00:00Z",
  "legacyBoundary": "2026-08-16T16:00:00Z",
  "windows": [ { "start": 1, "end": 4 }, { "start": 6, "end": 10 } ],
  "holidays": [ "2026-09-25", "2026-09-26", "2026-09-27" ]
}
```

- `windows` 是 **UTC 小时**、半开区间 `[start, end)`；`{1,4}`+`{6,10}` ＝ 北京 09:00–12:00、14:00–18:00。
  设置页把它写成 `1-4,6-10` 这种紧凑形式，保存前解析回数组（格式/范围不对就不让保存，最多 24 条；
  宿主侧还有一条 48 条的上限做兜底）。
- `holidays` 是北京日历日，**每年要人工更新** —— 设置页「显示 → 官方峰谷」
  的假期输入框（逗号分隔）或 `state.json` 的 `officialPeak.holidays` 都能改。
  只认**真实存在**的日期（`2026-02-30` 这种「格式合法但不存在」的会被剔掉）。调休上班的周末仍按周末判谷。
- `effectiveAt` 之前的调用不套峰谷，`legacyBoundary` 之前按价表的 `legacyBase`（历史正确性）。
- 归一规则（`normalizeOfficialPeak`）：字段缺失/非法 → 该字段回落默认；
  `windows: []`（永不判峰）与 `holidays: []`（没有假期）是有效值；给了非空数组却一条都不合法
  按打字错处理、回落默认。`enabled: false` 或空窗口会让相位块整体消失（侧栏不显示倒计时条）。
- 窗口的两条边界：**跨午夜**（`start > end`，如 `22-2`）合法；**退化窗口**（`start === end`，
  如 `5-5`）当非法丢掉 —— 否则会命中跨午夜兼容分支（`hour >= 5 || hour < 5` 恒真）变成
  **全天高峰价**，是个静默改价的坑。

**展示侧**（都不参与计价，只影响界面）：

| 用途 | 函数 | 挂在哪 |
|---|---|---|
| 倒计时条（细进度 + 剩余时间） | `phaseAt()` | `/sidebar`、`/report` 的 `peak` 块 |
| 「峰谷表」一键预览接下来的切换点 | `upcomingSwitches()`（默认 6 个） | 同上，`peak.upcoming` |
| 跨档提醒（横幅 / 可选系统通知） | 客户端比 `peak.inPeak` + `localStorage` | 侧栏顶部，见 `peakNotify` |

计价本身**不依赖**这些：档位在调用发起时由 `tierFor()` 定死并写进记录，界面怎么算倒计时都不会改动已入账的金额。

### 未定价 ≠ 0

`costOf()` / `priceCall()` 在缺单位价时返回 `null`（`basis: 'unpriced'`），而不是 `0`：
界面必须能把「没有价格」和「没花钱」分开显示（`¥0` 是最糟的默认值）。

```js
const resolved = resolveTier({ provider, model, atMs, snapshot, priceTable })
const call = priceCall({ buckets, tier: resolved.tier, rate: resolved.rate, credits: resolved.credits })
// call.cost === null → 显示 —；否则显示金额 + call.basis（如 'peak×local-peak'）
```

`resolveTier()` 即使算不出金额也会返回倍率、官方相位、credits 和切换点，供界面分开展示。

### 依据变更不重算历史，只影响后续调用

调单价、改峰谷窗口、换汇率/币种、换倍率来源 —— 一律**只对之后的调用生效**；已入账记录
永远按当时的依据保留，插件**不提供**任何回放/重定价入口。

- **入账即固化**：`makeCallRecord()` 把当次的单价（`unit`）、倍率（`rate`）、credits、金额与
  `basisId` 一起写进记录；读历史只走 `summarizeRecords()`，它**不接受价表** ——
  结构上不存在「拿当前表重算旧记录」的代码路径。
- **`basisId = pricingFingerprint(价表 + 官方峰谷配置 + 币种/汇率)`**：换依据后新记录自动带
  新 id，历史可按 id 分组显示「这批是按哪版依据算的」，而不是被悄悄改写。
- **未定价记录**：`cost: null`，token 照计、金额不计；全部未定价时会话金额是 `null`，
  界面显示 `—`（不是 `0`）。
- 与现成实现的关键差别：那边改价表会回放会话日志重定价历史（`recomputeLedgerPricingBasis`
  之类），覆盖不全的会话只能跳过，同一份历史于是出现两套口径；这里选择**不改写**。

### 默认价目表（`lib/price-table.js`，自动生成）

「官方价 × 站方倍率」里的官方价部分，随包带一份默认表：**来源是 dsh-cost-meter（MIT）
的价目快照**，DeepSeek 主表（含 `offPeak`/`peak` 两档、`rateHistory` 调价历史、
`legacyBase` 时代分界价）+ 17 家厂商目录（openai / anthropic / google / xai / z-ai /
moonshot / minimax / alibaba / tencent / xiaomi / … / openrouter）。文件头记着
`sourceHash` 与币种，便于复核。

```bash
# 重新生成（默认读 ~/.dsh/storages/cost-meter/ledger.json 的 config.prices）
node research/import-price-table.mjs [<路径>]
```

查找顺序（**不做静默的跨厂商模糊匹配** —— 那会把 A 家的价套到 B 家上）：

```
① 明确给了 vendorHint → 该厂商目录（精确 → 规范化）
② DeepSeek 主表（精确 → 规范化）
③ 显式 aliases（值可为 "vendor:key" 或 "key"）
④ 各厂商目录：自营优先、聚合渠道（openrouter / opencode-go）最后
⑤ "vendor/model" 尾名匹配（grok-4.7 → x-ai/grok-4.7）
```

「规范化」指把 `.`/`_` 统一成 `-`，所以站点常用的点号写法 `claude-opus-4.6` 能命中
目录里的 `claude-opus-4-6`；站点前缀 `cn:deepseek-v4.1-flash` 会剥掉 `cn:` 再查。
命中后会带回出处（`priceSource.vendor / key / matchedBy / sourceUrl / checkedAt`），
界面可以显示「单价来自谁家」。

两条边界：

- 这张表是**厂商挂牌价**，不是站点价：折扣/加价由站方倍率表达，**不要**往表里塞站点价格。
- 未命中就是未定价：`reason` 区分 `no-price-table` / `model-not-in-table` /
  `incomplete-price-entry`，界面显示 `—` 而不是 `0`。
- 表是**默认值**：`state.json` 的 `priceTable` 可整段覆盖、`aliases` 可增量补充；
  按上面的硬规定，改表只影响之后的调用。

### 价目来源分级与「更新价格表」

价目按**来源等级**分层，默认只吃前三档：

| 等级 | 是什么 | 默认参与计价 | 来源 |
|---|---|---|---|
| `official` | 厂商自有文档域上的挂牌价 | ✅ | `lib/price-table.js`（`research/import-price-table.mjs` 按域名白名单判定） |
| `station` | **站方口径价**：Sub2Api 自己算钱用的那张表 | ✅ | `lib/price-table-station.js`（LiteLLM 价目快照）+ `prices.json`（按钮更新） |
| `manual` | 你手工填的（state.json 的 `priceTable` / `aliases`，或缺 `source` 字段） | ✅ | 你自己 |
| `reseller` | 转售商挂牌价（opencode.ai 那类，含加价/促销） | ❌ 需显式放开 | `lib/price-table.js` 里他的目录 |
| `aggregator` | 聚合目录价（openrouter.ai，含 `:batch`/`:free` 变体） | ❌ 需显式放开 | 同上 |
| `unknown` | 没有来源可判 | ❌ | 同上 |

为什么 `station` 这一档重要：Sub2Api（`Wei-Shaw/sub2api`）的**真实计费**就是用
LiteLLM 的 `model_prices_and_context_window.json` 算的（它仓库里有镜像副本，运行时优先下载最新版；
见其 `backend/internal/service/account_stats_pricing.go`），所以「这张表 × 站方倍率」与站方账单同源。
它**不等于**厂商官方文档价（LiteLLM 目录里也混有渠道条目），因此单列一档、标注 `station`。

**更新按钮**：设置页「余额与费用 → 价格」里的「更新价格表」（侧栏底部那枚 `价格表 · MM-DD ⟳ 更新`
默认不显示，打开 `ui.sidebarTools` 才有）—— 点一下就让宿主去抓最新的站方价目：

```
抓取链（第一个成功即用）：
  1. LiteLLM raw 直链
  2. Sub2Api 的 price-mirror 分支 raw
  3. GitHub API：contents（取 sha）→ git/blobs（base64 正文，支持大文件）
  4. sub2api 仓库里的兜底副本（contents 内联 base64）
```

- 落盘到 `$DSH_HOME/storages/dsh-balance-monitor/prices.json`（与 `state.json` 分开：全量目录几百 KB）；
- **只影响之后的调用**，按钮旁会显示本次收录的模型数；
- 抓取失败会如实显示每一条链路的原因；
- 随包快照（314 个模型、96.6 KB）保证**开箱即用**，重生成：`node research/import-station-prices.mjs`；
- 数据署名：LiteLLM `model_prices_and_context_window.json`（MIT），经 `Wei-Shaw/sub2api` 镜像分发。

### credits 型站的两种读法

这类站 `/v1/usage` 是 404、只有 `/v1/models[].credits`（如 `"x0.11"`），没有余额也没有
「官方价」，所以**折算货币仍然不可能**。两条路，别混：

| 路径 | 何时用 | 可信度 |
|---|---|---|
| **面板真值**（`lib/workbuddy.js`，类型选 `workbuddy`） | 对端是 `workbuddy2api-panel` 系、面板可读 | 真值：`usage.credit` 由站方自己记的逐请求扣费 |
| **纯本地估算**（`creditsWeight()` = 全部桶 × credits） | 面板读不到时的兜底展示 | **相对量，未标定** —— 积分几乎全由缓存未命中贡献，把命中 token 按同价线性加权会系统性高估 |

`creditsWeight()` 之所以只能算相对量，是因为它拿不到「命中单价 / 未命中单价 / 输出单价」这三个数：
面板给出的 `积分/1M token` 是个**混合平均值**，代入自己的命中率会差出数倍
（实测：站均值 99.1% 命中 → 1.0073 积分/1M；同一站自己的负载 98.4% 命中 → 同一批 token 的实际积分高约 44%）。
要把它变成可用的账，得先解出那三个单价 —— 面板的 `credit_by_account` / `credit_by_model`
带 `credits` + `credit_tokens` + `cache_hit_tokens` + `cache_miss_tokens`，样本足够解线性方程。

---

## 三、设置页「余额与费用」

设置 → **余额与费用**（`settings.section`，order 32）一个页面五个分页：

| 分页 | 内容 |
|---|---|
| **概览** | 三张卡：今日 / 本月 / 累计费用（金额 + 调用次数 + 输入/缓存/输出）；今日会话明细表（会话 / 调用 / 输入 / 缓存 / 输出 / 命中率 / 费用）；预算（开关 + 额度 + 周期今日/本月/累计 + 进度条 + 超支预警）；官方账户余额（总余额/赠送/充值/更新于 + 「刷新余额」） |
| **额度** | 逐供应商：类型 / 状态 / 倍率 / 峰谷 / 模型数 / 今日费用 / 备注（余额、套餐、到期时间、错误） |
| **用量** | 累计输入 / 缓存（含缓存写入）/ 输出（含推理）/ 命中率；**26 周每日热力图**；近 60 天柱状；**按模型统计**（今日 / 全部历史双档，费用 / Token / 命中率 / 每美元 token 四种排行）；「历史数据」区（清除 / 导入探测） |
| **价格** | 计价依据指纹；来源等级分布（各等级条数）；**勾选参与计价的来源等级**（推荐组合一键还原）；「更新价格表」按钮；价目元数据（最近更新 / 条数 / 来源地址 / 数据出处） |
| **显示** | **界面**（语言 `auto`/`zh`/`en`、侧栏刷新间隔 10–60 秒、隐藏官方余额 / 隐藏今日消耗、会话明细显示完整 ID、侧栏显示峰谷表/价格表）；币种 / 符号 / 小数位 / 汇率 + 保存；账本保留（明细 / 日汇总天数）+ 独立保存；峰谷提醒（应用内 / 系统通知两个勾选框 + **提前量 1–30 分钟** + **提醒类型** + **弹窗位置** + **预览进入峰/谷**，各自独立保存）；**密钥扫描**（读凭据文件引用名的开关 + 候选前缀 + 序号上限，独立保存）；**访问控制**（Host 白名单，反代 / 自定义域名部署用）；**官方峰谷**（启用开关 + 高峰窗口 `1-4,6-10` + 假期列表，独立保存）；**模型花费卡片**（开关 + 默认展开 / 记住展开 / 显示 Token / 占比条 + 默认周期 + 模型行数 + 卡片位置） |

**本月 / 累计为什么不靠账本**：账本只留最近几天原始记录（默认 7 天，供会话明细），所以另有
`storages/dsh-balance-monitor/days.json` —— 每天把当日总额**覆盖式**写进去（幂等），默认保留 400 天。
两个天数都能在设置页「显示 → 账本保留」里改。报表里的「今日」仍以账本为准，两者相减避免重复计数。

**改配置会发生什么**：`display` / `budget` / `priceSources` / `officialPeak` / 密钥扫描三项
都是白名单写入 `state.json`；改币种、汇率、来源等级或**峰谷窗口/假期**会换掉计价依据指纹（`p1-…`），
**只影响之后的调用**，历史金额一分不动（未定价的调用仍然显示 `—`，不会被画成 0）。
密钥扫描三项不进指纹（它只决定「能发现哪些 key」）。

---

## 四、侧栏

### 底部：余额 / 今日 / 峰谷倒计时

侧栏底部走宿主的 `sidebar.footer.action` 槽位（list / root 作用域），显示：

| 行 | 内容 | 数据来源 |
|---|---|---|
| 余额 | `余额 ¥0.01` | **只有 DeepSeek 官方**有余额接口（`GET https://api.deepseek.com/user/balance`）；其余供应商不显示这一行 |
| 今日 | `今日 ¥0.0000` + 供应商下拉 | 所有供应商**相加**，金额是**倍率之后**的实际花费（不是官方原价） |
| 峰谷条 | 细进度条 + `剩余 5 小时 3 分后进入平价` | 官方峰谷相位（本地窗口 + 周末全谷 + 调休表） |
| 峰谷表 | `峰谷表 · 预览 · 6` → 展开列出接下来的切换点（本地时刻 + `→ 高峰` / `→ 平价` + 相对倒计时） | `upcomingSwitches()`（默认 6 个，最多 24），宿主算好随 `/sidebar` 一起下发 |
| 价格表 | `价格表 · MM-DD ⟳ 更新` → 点一下抓最新站方价目（结果就地报「价目已更新 · N 个模型」） | 宿主 `/prices/update` |

**独占一行**：宿主的 footer 是横向 flex；装了也会注册 footer 的插件（例如 dsh-mobile 的
「移动访问」）后，余额块会换到下一行并占满整行，不再和按钮左右分列；没有别的 footer
插件时同样保持整行。实现见 `ensureSidebarFooterCss()`（用 `:has()` 从
`data-balance-monitor="sidebar"` 反选父容器并打开 `flex-wrap`）。

**窄栏 / 移动端**：宿主给 `sidebar.footer.action` 下发 `wide`。桌面折叠栏或 dsh-mobile 的
56px 抽屉里 `wide=false`，余额块**整块不渲染**（只保留宿主图标和窄栏徽章），避免文字被裁成
碎片；展开侧栏后恢复。轨道本体同样在 `wide=false` 时整段卸掉，不会把「进行中」挤成竖排；
窄栏徽章合并「进行中 + 待查看」——绿色表示只剩待查看，标题写清两类各多少。主会话、标签页和
输入区属于宿主 / dsh-mobile 的移动布局，不在本插件的样式边界内。

**哪几行默认不显示**：最后那两行（`峰谷表` / `价格表`）是**去改配置的入口**，不是用量 ——
默认不渲染，侧栏那点位置留给余额 / 今日 / 峰谷倒计时。同一件事在设置页「余额与费用」里都有：
更新价目在「价格」页；「峰谷表」（接下来 6 个切换点，读 `/report` 的同一份 `peak.upcoming`）在
「显示 → 官方峰谷」下面。要它们常驻侧栏，就在「显示 → 界面」勾上 `ui.sidebarTools`
（打开后那两行连同「价目已更新」结果行一起回来）。

`今日` 的金额来自账本：宿主包裹 `llm/stream`，每次调用用**调用时刻**的档位算出
「官方价 × 站方倍率 × credits」并落成一条记录（`storages/dsh-balance-monitor/ledger.json`），
之后只做加总。三条不猜的规则：

1. **没探到倍率的中转站不按 1 算** —— token 照记、金额留空，侧栏显示「N 笔未定价」；
2. **未定价 ≠ 0** —— 金额为 `null` 时显示 `—`，不画成 `¥0`；
3. **依据变更不重算历史**，所以下拉切换供应商时看到的历史不会因为改价而变。

供应商下拉（`全部` / 各家）只影响**看谁**：选 `全部` 显示各家相加，选某一家显示它的
金额、调用次数、命中率、token 与逐模型明细。选择记在浏览器 `localStorage`。

**模型花费卡片**：可开关；收起时标题行给 Top-1，展开给 Top-N + 占比条；行尾对未定价的调用标 ⚠。
周期可选今日 / 近 90 天，行数 1–10，位置底部或顶部；「记住展开状态」打开时把状态记在浏览器本地。

**轮询与节流**：客户端默认每 **15 秒**拉一次 `GET /sidebar`，间隔在「显示 → 界面」里改
（`ui.refreshSeconds`，10–60 秒，只改取数节奏，不改记账）。宿主对中转站的探测有 **5 分钟冷却**
（不让侧栏的常驻轮询把探测节奏带起来），官方余额 **15s** 缓存（侧栏每 15s 拉一次时，每次轮询都会重新查；
切 key 后会强制刷新一次）。缓存里没有倍率的供应商
在探测发生前一直记「未定价」。

### 工作区顶部：进行中 / 待查看轨道

`sidebar.workspaces` 是 single 槽，插不进列表上方，插件把轨道插在**工作区滚动区上方**，
并给折叠的工作区行打徽章。轨道分两段：**进行中**在上，**待查看**在下。

| 元素 | 行为 |
|---|---|
| 轨道标题 | `进行中 N`（有待处理时是 `N · 待处理 M`）与 `待查看 N`；两段各自折叠/展开，状态分别记在 `localStorage` |
| 进行中行 | 会话标题 + 所属工作区（小字） + 状态点：**待处理**（审批 / 计划审阅 / 提问）在前，其次正在跑或带子代理 |
| 待查看行 | 绿点 + 会话标题 + 所属工作区；只列宿主的**完成未读**（`completionUnread`），不是完成历史 |
| 行数 | 进行中最多 5 行、待查看最多 3 行；超出显示「还有 N 个」，点开可看全 |
| 点击一行 | 打开该会话；若所在工作区折叠着，再点一下工作区行把它展开。待查看行被打开后即已读，自动从组里消失 |
| 折叠工作区徽章 | 状态点 + 数量，**含子工作区里看不见的活会话**；展开后徽章消失（徽章仍只算进行中，不混入待查看） |
| 窄侧栏 | 折叠按钮上的数量徽章 = 进行中 + 待查看；有待处理时用警告色，否则只有待查看时用绿色，其余用蓝色。轨道本体在窄栏不渲染 |
| 空态 | 哪段空就卸哪段；两段都空时整块卸掉，不显示「进行中 0」/「待查看 0」 |
| 搜索中 | 轨道隐藏，不和搜索结果抢位置 |

**待查看 = 完成未读，不是完成历史**：它只镜像宿主 `ui-session` 的 `completionUnread` ——
会话从 `running` 变 `false`、且不是主视图保留的会话时点亮；重新运行、被打开成主视图、
刷新页面都会清掉。所以顶部组刷新后会空，也没有批量已读 / 跨标签同步。要跨刷新保留完成记录，
得插件自己持久化完成事件（另做，不混进这个字段）。

**边界是刻意的**：轨道只是一个**索引**，会话仍留在各自工作区 ——
**不写 Pin、不重排工作区、不自动展开分组**，点工作区标题仍只负责展开/折叠。

---

## 五、会话区：本会话费用 / 额度横条 / 角标

| 区块 | 挂在哪 | 内容 |
|---|---|---|
| 本会话费用 | `conversation.composer.dock`（默认，输入卡片**下面**那条）· 也可选 `conversation.input.dock`（卡片上面）或 `conversation.session.header.actions`（标题栏） | 金额 · 调用数 · token · 命中率（可关）· 未定价条数；`includeSubagent` 打开后算自身 + 子代理 |
| 额度横条 | `conversation.input.dock` | 预算已用 %（没设额度就不显示；≥80% 预警 / ≥100% 超支）/ 今日金额 / 峰谷档位与倒计时 / 官方余额（可关）。点一下刷新 |
| 右下角角标 | `conversation.composer.dock` | 今日金额 + 峰谷档位（可选 Top-1 模型） |

**本会话费用贴哪一边**：宿主 `composer.dock` 是 `display:flex; justify-content:center`
（不是 column flex，块级子元素不会自动拉伸），slot 自己不算列宽就会缩成内容宽并在 dock 里居中，
看着像浮在左下角。现在照宿主自家 dock（`TodoPanel` / `QueueDock`）同一套算法排版：

```
width      = 100% - 2×--dsh-composer-side-clearance - 2×--dsh-composer-dock-inset
max-width  = --dsh-composer-card-max-width - 2×--dsh-composer-dock-inset
margin     = 0 auto      （composer.dock 那处是 0 —— 宿主那条 dock 是 flex，行由拉伸决定宽度）
```

算出来的正文左边正好等于**会话内容列**（消息正文 / 输入卡片正文）的左边，不再贴会话面板左边缘；
变量缺失时回退 `16px / 8px / 952px`（照抄自宿主 `ConversationRoot.module.css`，不改宿主 token）。
「会话标题栏」那处（`position: header`）**不吃**这套列宽 —— 压窄会缩成一小条；额度横条用的是同一套。

**取数节奏**：本会话费用固定 15 秒（会话进行中这个数一直在涨，独立于侧栏轮询是有意的）；
横条与角标跟侧栏轮询（10–60 秒可配）。宿主没给 `sessionId` 就不渲染。

**子代理归属**：`parentSessionId` 由宿主在调用事件里给 —— **没给就只统计本会话**，
并在行尾标「⚠ 宿主未提供子代理归属」，不假装算过（`/session` 的 `subagentSupported` 说的就是这件事）。

---

## 六、图片模态自动补全

手工声明一个中转站供应商时，每个模型条目都没有 `input`，而 pi-ai 对没有 `input` 的条目回落
`DEFAULT_INPUT = ["text"]`（`@deepseek-ai/dsh-llm-pi-ai`），宿主于是**把图片投影成文本占位**发给模型 ——
表现就是「图能拖进去，模型看不见」。中转站的模型基本都是多模态的，缺的只是这一行声明，本插件把它补上：
**新加的供应商不用再逐个模型勾「图片」。**

卡片上的两个控件：

| 控件 | 行为 |
|---|---|
| ☑ 新模型自动补图片（默认**开**） | 打开「设置 → 模型」这个页面时自动检查并补全，不需要点任何东西 |
| 立即补图片 | 手动补一次，**连显式勾成纯文本的模型也一起补** |

**首次打开就会对 auto 开着的供应商补一次**（这是「不用每次手动添加」的代价）。
不想让某家被自动补，就先在 `state.json` 的 `autoImage` 里把它置 `false`（或在卡片上取消勾选）。

补全规则（只有两条，都是刻意的）：

1. **只加不减**：已经声明 `image` 的条目一个字都不动。
2. **显式优先**：`input: ["text"]` 是你明确勾的纯文本模型，**自动**补全会跳过它（卡片上会写「另有 N 个显式纯文本」），
   只有按「立即补图片」才会覆盖 —— 免得插件和你的显式选择来回打架。

写进去的就是 `llm-pi-ai.providers.<id>.models[].input: [text, image]`；卡片上显示
`已声明 / 总数`，补完之后列出这一次补了哪几个模型。

**怎么落盘的（不是自己改 YAML）**：走宿主 `settings` 服务
（`@deepseek-ai/dsh-settings` + `@deepseek-ai/dsh-config-editor`）的
`mutate(ns, ops, expectedRevision)` —— 和内置「设置 → 模型」页保存供应商**同一条路**：

- 只接受落在 schema `.volatile()` 节点下的路径（`llm-pi-ai` 的 `providers` 正是那个节点）；
- 按修订号拒绝过期写入，撞上并发修改（比如你同时在设置页保存）会**重读修订号重试一次**；
- 由 `config-editor` 原子替换 profile patch 并交给 Loader 热重载，**YAML 注释和 `!!js` 表达式都保留**。

宿主没有这个服务（精简组合 / 老版本）时：插件照常只读运行，卡片写明「不支持写入」，不会静默失败。

> ⚠️ 模态声明只是声明，**宿主不会替你校验上游是否真的吃图**（pi-ai README 原话：声明了 image 而网关不支持，
> 会在提示词准入之后被供应商拒绝，图片还留在历史里）。所以某家站如果有纯文本模型，把那张卡片的
> 「自动补图片」关掉即可。要确认某站模型真的支持图片，看它 `/v1/models` 有没有逐模型的 `supports_images`
> （wbfd 这类网关会给），或者直接发一张图试。

开关状态存在 `state.json` 的 `autoImage` 里（只有显式 `false` 才算关）：

```
$DSH_HOME/storages/dsh-balance-monitor/state.json
{ "version": 2, "types": { "wbfd": "sub2api" }, "autoImage": { "pojia-gpt": false } }
```

对应接口（浏览器侧仍只访问同源路由）：

```
GET  /plugins/dsh-balance-monitor/state                        → 顺手补一次（auto 开着的供应商）
POST /plugins/dsh-balance-monitor/vision/auto  { provider, enabled }
POST /plugins/dsh-balance-monitor/vision/apply { provider? }    ← 省略 provider = 全部补一遍
```

---

## 七、右栏「文件」：复制路径

文件栏和打开后的预览各有一颗复制图标，都只写**路径**进剪贴板，不读文件内容。

| 在哪 | 悬停 | 写入剪贴板 |
|---|---|---|
| 文件栏路径右侧（「用其他应用打开」之后） | 复制目录路径 | 当前显示的目录绝对路径 |
| 打开文件后，预览头部最右侧 | 复制文件路径 | 该文件的绝对路径 |

点下去成功会变成对勾，约 1 秒后恢复。剪贴板被拒绝时按钮保持原样，不假装已复制。
没有路径（预览还没拿到宿主绝对路径）时不渲染。英文界面文案是 `Copy directory path` / `Copy file path`。

---

## 八、安装

本插件是标准的 DSH bundle 包，用一个 `cordis.patch.yml` 插一行 host 行。

**在 Harness 里装**：设置 → 插件 → 安装 bundle，目标目录填本仓库的绝对路径。

装完需要重启 `dsh web`（替换已安装包的 JS 模块需要重启才会加载新代码）。
装好之后打开 **设置 → 模型**，每张供应商卡片下方会出现「供应商类型」（两条 DeepSeek 官方路线除外，
它们只有一行口径说明：官方路线没有供应商类型，余额按官方接口查）。

> 不通过 `plugin_manager` 手写 profile 的 `package.json` / `cordis.patch.yml`：那两步由安装动作自己完成。

**一个上游限制（不是本插件的 bug）**

「添加供应商」有 **catalog** 和 **custom（手工声明）** 两个 tab：

| 场景 | 卡片出现吗 |
|---|---|
| 从 catalog 添加供应商 | ✅ 出现 |
| 手工声明的路由**正在输入时** | ❌ 不出现 |
| 手工声明的路由**保存之后** | ✅ 出现 |
| 已保存的供应商行 | ✅ 出现 |

原因是上游只在 catalog 面板里分发 `settings.models.provider-card` 槽位，手工声明的路由在写入 profile 之前
还没有目录行、没有 `settingsNs`，因此没有被分发的键。
**所以：新增中转站时先把 provider 建好并保存，然后在它的卡片里选 `Sub2Api`。**

---

## 九、配置与存储

本插件自己持久化的东西：

```
$DSH_HOME/storages/dsh-balance-monitor/state.json     ← 类型 / 自动补图片 / 展示币种 / 保留期 / 价表覆盖 / WorkBuddy 过滤条件
$DSH_HOME/storages/dsh-balance-monitor/ledger.json    ← 调用账本（按天，含依据指纹；默认保留 7 天）
$DSH_HOME/storages/dsh-balance-monitor/days.json      ← 日汇总（本月/累计用；默认保留 400 天，覆盖式写入）
$DSH_HOME/storages/dsh-balance-monitor/prices.json    ← 站方口径价目（点「更新价格表」后写入）
```

`state.json` 可选字段（都可不写，缺省即默认值）：

```json
{
  "version": 2,
  "types": { "walk-grok": "sub2api", "wbfd": "workbuddy" },
  "creditsFilters": { "wbfd": { "userAgent": "deepseek-harness", "clientIp": "203.0.113.7" } },
  "autoImage": { "pojia-gpt": false },
  "display": { "currency": "CNY", "symbol": "¥", "decimals": 4, "exchangeRate": 7.2 },
  "budget": { "enabled": false, "amount": null, "period": "month" },
  "retention": { "ledgerDays": 7, "rollupDays": 400 },
  "peakNotify": { "enabled": true, "system": false },
  "officialPeak": { "enabled": true, "windows": [{ "start": 1, "end": 4 }], "holidays": ["2026-10-01"] },
  "deepseekKeys": ["DEEPSEEK_API_KEY", { "ref": "DEEPSEEK_API_KEY_2", "label": "第二把" }],
  "deepseekKeyPrefixes": ["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"],
  "deepseekKeyMaxIndex": 9,
  "scanCredentialsFile": false,
  "allowedHosts": ["panel.example.com", "192.168.1.10:3080"],
  "ui": { "locale": "zh", "refreshSeconds": 15, "hideOfficialBalance": true, "hideTodayCost": true, "showSessionId": true, "sidebarTools": true },
  "priceSources": ["official", "station", "manual"],
  "priceTable": { "models": { }, "providers": { }, "aliases": { } }
}
```

- `display`：金额展示币种（账本恒以美元存；CNY 时按 `exchangeRate` 乘回）。
- `budget`：预算额度 + 周期（`today` / `month` / `all`），设置页「概览」可改。
- `retention`：两份文件的保留天数（`ledgerDays` 账本明细 / `rollupDays` 日汇总），设置页「显示」可改；
  两者都能省，允许 `1 – 3650`，且**日汇总不会短于明细**（不合法就各自回落默认）。
  调小**立刻**裁掉超期数据（`POST /config` 时同步裁剪并落盘），调大只影响之后的留存。
- `modelCard`：侧栏模型花费卡片（`enabled` / `defaultExpanded` / `rememberExpanded` / `showTokens` / `showShare` /
  `period`(`today`·`days90`) / `rows`(1–10) / `position`(`bottom`·`top`)），设置页「显示」可改；同一套局部补丁规矩。
  关闭时侧栏 payload 里这块是 `null` —— 宿主也不做聚合。展开状态记在浏览器本地（`rememberExpanded` 打开时）。
- `peakNotify`：峰谷提醒。`enabled` 侧栏横幅 / `system` 系统通知 / `leadMinutes` 提前量（1–30）/
  `type` 提醒哪一侧（`both`·`peak`·`off`）/ `position` 弹窗位置（`corner`·`center`），设置页「显示」可改，同样是局部补丁。
  两位都是**局部覆盖**：只提交一位不会把另一位带掉；两个都关 = 清掉这条配置。默认都关（不弹）。
  判定跟着侧栏轮询走（间隔可配），有两条路径：**提前量**（距切换不足 `leadMinutes` 时提醒，
  同一个切换点只提醒一次，记在本地）；**刚跨过**（切换点在 90s 内才算，页面关着期间跨过的那次只记不报）。
  系统通知需浏览器授权，被拒后应用内横幅照旧。
  设置页「显示」里有「预览进入峰 / 谷」——用真实组件渲染一次，省得等到下一次换档才知道长什么样。
- `officialPeak`：官方峰谷配置，**逐字段**合并到随包默认表，设置页「显示 → 官方峰谷」可改。
  字段缺失或非法 → 该字段回落默认；`windows: []`（永不判峰）与 `holidays: []`（没有假期）是**有效值**，
  但「给了非空数组却一条都不合法」按打字错处理、回落默认（免得一个笔误丢掉整年假期）。
  改它会换计价依据指纹，**只影响之后的调用**。

  > 两条与别的字段不同的规矩：①走 `POST /config` 是**局部补丁** —— 没给的字段沿用**当前生效值**
  > （不是回默认），所以只改假期不会把「已关掉的峰谷」重新打开；`null` 才是「清除自定义、回默认」。
  > ②落盘时只写**与随包默认不同**的字段：设置页点一次保存不会把当版假期表固化进 `state.json`，
  > 以后随包更新假期表在这台机器上照样生效。
- `allowedHosts`：额外允许的 `Host` 列表（`host[:port]`，小写，最多 20 条），设置页「显示 → 访问控制」可改。
  默认空 = **只接受回环地址**（见下一节的 DNS rebinding 防护）；反代 / 自定义域名 / 局域网访问时把主机名写进来。
  它只放宽 `Host` 判据，不影响跨站判据。
- `ui`：界面偏好，设置页「显示 → 界面」可改（`/state`、`/sidebar`、`/report` 三处一起下发，客户端共用一份）：
  `locale`（`auto` = 跟随浏览器 / `zh` / `en`，切换即时生效）、`refreshSeconds`（10–60，侧栏轮询间隔）、
  `hideOfficialBalance` / `hideTodayCost`（对应区块整体不渲染，截屏防泄露）、`showSessionId`（会话明细给全长 ID）、
  `sidebarTools`（侧栏底部那两行「峰谷表 / 价格表」；**默认 false = 不渲染**）。
  与 `officialPeak` 同一套规矩：`/config` 是**局部补丁**（没给的键沿用当前值，`null` 才是清空），
  且只沉淀与默认不同的字段。
- `deepseekKeys`：多把 DeepSeek API Key 的**凭据引用**列表（字符串或 `{ ref, label }`），
  卡片上的密钥编辑区会自动维护它（**只有 API Key 路线有编辑区**，账号路线不渲染）；
  侧栏余额 = 各把之和（币种不一致就不给总额）。
- `autoKeySwitch`：主 key 不可用时自动换到有余额的 key（默认 **开**；只有显式 `false` 才关）。
  只对 API Key 路线生效，且要求 `deepseekKeys` 里至少有一把别的 key；换 key 会写宿主凭据库
  （`credentials.set`），被换下的正余额 key 备份到 `DEEPSEEK_API_KEY_REPLACED`。
- `deepseekKeyPrefixes` / `deepseekKeyMaxIndex`：候选名探测的前缀与序号上限
  （默认 `DEEPSEEK_API_KEY`、`DEEPSEEK_KEY` × `_2…_9`），设置页「显示 → 密钥扫描」可改。
- `scanCredentialsFile`：读 `~/.dsh/.credentials.yaml` 里 `refs:` 段的**键名**（不读值）来补全候选名。
  只有显式 `false` 才关（关掉就退回纯候选名探测）；默认开。
- `creditsFilters`：WorkBuddy 型站的自身口径过滤条件（`userAgent` / `clientIp`），`/credits/filter` 可改。
- `priceSources`：允许参与计价的来源等级；不写就是 `official + station + manual`。
- `priceTable`：整段覆盖默认价表；不写就用随包的默认表（官方快照 + 站方快照）。
- `ledger.json` / `days.json` / `prices.json`：账本 / 日汇总 / 站方价目；账本**只加总不重算**。

**探测结果只放内存**（余额 15s 缓存），不落盘：账号余额/花费不在磁盘上留副本。

API Key 对外的**只读**痕迹只有 `hasKey: true/false`。两条例外要说清楚：
`GET /keys` 只回「引用名 + 配没配」（**不含值**）；`POST /keys` 会把你在卡片上填的 key
写进宿主凭据库（`credentials.set`），`POST /keys/reveal`（点卡片上的小眼睛才走）会把某个
引用的**明文**回给界面。也就是说「key 不落盘、不进响应体」这句只对**探测流程**成立，
密钥编辑区这条路是显式写入/读取宿主凭据库的。

类型与自动补图片开关都**不写进 pi-ai 的 provider 配置**。上游的 provider profile schema 是
`z.object(...)`（非 strict），往里面塞自定义字段能否存活没有验证过；本插件把自己的状态放在自己的存储里、
按 provider id 索引，绕开这一点。（反过来，补图片写的 `models[].input` 是 pi-ai **自己的字段**，
走的是 `settings.mutate`，和内置设置页同一条路。）

---

## 十、宿主路由与安全边界

浏览器侧跨域取不到中转站接口（实测 `GET /v1/sub2api/billing` 带 `Origin` 也不返回
`Access-Control-Allow-Origin`，`OPTIONS` 直接 403），所以**所有出网请求都在宿主侧做**，
客户端只访问宿主自带 webserver 上的**同源**路由：

```
GET    /plugins/dsh-balance-monitor/state                  → { ok, state }
POST   /plugins/dsh-balance-monitor/history/clear { confirm: "clear-all-history" }
                                                           → 清空明细与日汇总（不带确认串则 400，且不动任何数据）
POST   /plugins/dsh-balance-monitor/history/import
                                                           → 导入安装前历史的能力探测（不做回放）
GET    /plugins/dsh-balance-monitor/session?sessionId=…&includeSubagent=0|1
                                                           → 该会话今日用量（自身 / 子代理 / 合计）
GET    /plugins/dsh-balance-monitor/sidebar                → { ok, data }（余额/今日/峰谷相位）
POST   /plugins/dsh-balance-monitor/type    { provider, type }
POST   /plugins/dsh-balance-monitor/refresh { provider? }
POST   /plugins/dsh-balance-monitor/credits/filter { provider, userAgent?, clientIp? }
POST   /plugins/dsh-balance-monitor/vision/auto  { provider, enabled }
POST   /plugins/dsh-balance-monitor/vision/apply { provider? }
GET    /plugins/dsh-balance-monitor/report                 → { ok, data }（设置页「余额与费用」整页数据）
POST   /plugins/dsh-balance-monitor/config { display?, budget?, retention?, peakNotify?, priceSources?,
                                             officialPeak?, scanCredentialsFile?, deepseekKeyPrefixes?,
                                             deepseekKeyMaxIndex?, deepseekKeys?, allowedHosts?, ui? }
                                                           → 白名单写入并回传新指纹
POST   /plugins/dsh-balance-monitor/balance/refresh { provider? } → 强制刷新官方余额（两条路线）
GET    /plugins/dsh-balance-monitor/prices                 → 价目状态（来源/条数/更新时间）
POST   /plugins/dsh-balance-monitor/prices/update          → 抓取站方价目并落盘
GET    /plugins/dsh-balance-monitor/keys?provider=<id>     → { ok, data }（引用名 + 配没配，**不含值**）
PUT    /plugins/dsh-balance-monitor/keys { provider, value, ref?, label? } → 写入宿主凭据库
DELETE /plugins/dsh-balance-monitor/keys { provider, ref } → 删掉一把（主 key 拒绝删）
POST   /plugins/dsh-balance-monitor/keys/reveal { provider, ref } → 回**明文**（只认属于该路线的引用）
GET    /plugins/dsh-balance-monitor/                        → 一张说明页（调试用）
```

### 跨站拦截面

这个 webserver 本身不鉴权（宿主不管认证），所以「本机任意进程」挡不住、也没打算挡
（它能直接读凭据文件）。要挡的是**任意网页**：一个简单请求（无预检）就能把 POST 打进来，
让插件替你删 key / 写 key / 改类型 / 触发抓取。拦住分两层：

**第一层：`Host` 白名单（所有方法都查）—— 挡 DNS rebinding**

rebinding 攻击里，恶意页所在域名先解析到攻击者服务器（投递页面），随后改解析到 `127.0.0.1`，
浏览器于是把 `fetch('/plugins/…')` 打到本机宿主上 —— 对浏览器来说这是**同源**请求，于是
`Sec-Fetch-Site: same-origin`、`Origin` 与 `Host` 全是攻击者域名，跟合法请求**逐字节相同**，
跨站那几条判据一条都不会命中。唯一能区分的就是 `Host`：

| 情况 | 处理 |
|---|---|
| `Host` 去端口后是回环（`127.0.0.0/8`、`localhost`、`[::1]`） | 放行 |
| `Host` 不带（HTTP/1.0、脚本、测试桩） | 放行（浏览器一定会带，所以不给浏览器留口子） |
| 其它 → 在 `allowedHosts` 里显式列过 | 放行 |
| 其它 → 没列过 | `403`，错误信息里带上该 host 与怎么加白名单 |

**第二层：状态变更路由（`POST` / `PUT` / `DELETE` / `PATCH`）—— 挡跨站请求**

| 级别 | 判据 | 响应 | 挡的是什么 |
|---|---|---|---|
| ① 有 `Sec-Fetch-Site`（现代浏览器必有） | 不是 `same-origin` / `none` | `403` | 跨站请求（含同站子域）；这个头由浏览器写，页内脚本改不了 |
| ② 没有该头（老浏览器） | `Origin` 存在且与 `Host` 不同源（含字面量 `null`） | `403` | 跨源请求 / 沙箱 iframe / `file://` |
| 补充（两级都要过） | `content-type` 存在但不是 `application/json` | `415` | HTML 表单、`no-cors` fetch |

第②级为什么只在没有 `Sec-Fetch-Site` 时跑：`Origin` 是浏览器按**页面 URL**填的，而 `Host`
在反向代理后面可能被改写（nginx `proxy_pass` 的默认行为就是把 Host 写成上游地址）。
那种部署下「页面同源、Host 却是 `127.0.0.1:3080`」是正常现象，无条件比对会把插件自己的 UI
全挡掉（所有写操作 403）。两级都过不了只剩「老浏览器 + 反代改写 Host」，那种环境请让反代
保留原始 `Host`。

三个头**都不带**时放行（`curl`、脚本、老客户端）—— 那不是浏览器发起的跨站请求，拦它只会把
命令行用法挡在门外。GET 不过第二层（它不该有副作用），但**要过第一层**（否则余额/花费能被
rebinding 读走）。所以从脚本调这些路由时，**带上 `content-type: application/json`** 最稳妥。

没有用 typert/remote：那条路要求把客户端从 TS 源码构建出 `$mount` 产物，本插件手写客户端模块、零构建步骤。

> 该路由没有鉴权（宿主 webserver 本身不管认证），但只监听回环地址。除了 `keys/reveal`
> 那一条**（点小眼睛才请求，且只认属于该路线的引用）**，其余响应都不含密钥，
> 只有派生出来的额度/倍率/花费数字。请求体上限 16 KiB。

### 零 `@deepseek-ai/*` 依赖

插件不 import 任何 DSH 运行时包，只用 node 内建模块。

原因不是洁癖：profile 下的 `@deepseek-ai/*` 全是**断链 junction**（实测 251 个目标全部不存在，
只有宿主进程自己的模块图能解析它们），依赖它就得赌宿主的 loader 是否也接管动态 `import()`。
现在唯一的凭据依赖被消掉了 —— `credentialRef(v)` 的实现是

```js
function credentialRef(value) { if (!isCredentialRefName(value)) throw ...; return brandString(value) }
function brandString(value) { return value }   // brand 只存在于编译期
```

所以运行时它就是个原字符串。插件自己按同一文法（`/^[A-Za-z_][A-Za-z0-9_]*$/`）校验后，
直接把字符串交给 `ctx.credentials.resolve()`，与调 `credentialRef()` **完全等价**
（有测试锁住这一点：断言凭据服务收到的是裸字符串 `WALK_GROK_API_KEY`）。

同理，请求侧也做了硬加固，而不是依赖声明式的 `dshhub.permissions.network`
（该字段在 121 MB 的 `app.asar` 里出现 0 次，**没有任何运行时强制**）：

- `redirect: 'manual'` + 显式拒绝 3xx —— 防止 `Authorization` 头被带到重定向目标主机
- 响应体上限 512 KiB，流式计字节、不信 `Content-Length`（SPA 回落页可能有几十 KB）
- HTTPS 之外一律不发；出网只可能是 `baseURL` 推导出的端点 —— Sub2Api 型是 `/v1/usage`、
  `/v1/sub2api/billing`、`/v1/models`；WorkBuddy 型是 `/v1/usage`（判指纹）、`/v1/models`、
  以及**同一 origin 下**的 `/panel/api/usage`、`/panel/api/request_logs`（面板地址由 `baseURL`
  取 origin 得到，不接受额外主机；未选这两类时不发任何站方请求）

---

## 十一、开发与验证

```bash
NODE="C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"

# ── 门槛：全部不出网（11 套）──────────────────────────────────────────
npm test                # = npm run test:offline
# 单独跑某一套：
$NODE test/pricing.test.mjs          # 档位与计价纯函数：官方峰谷（含未来切换点）、officialPeak 归一与假期回环校验、站方倍率复算、credits、未定价语义、价表命中、来源等级策略
$NODE test/litellm-prices.test.mjs   # 站方口径价目（fetch 全部打桩）：字段映射、渠道条目过滤、长上下文档、抓取链四种形态、合并位置
$NODE test/credentials-refs.test.mjs # 凭据引用名：refs 段解析、只看名字不读值
$NODE test/usage-ledger.test.mjs     # 用量账本 + 侧栏/报表聚合：按天/供应商/会话/模型加总、日汇总幂等与裁剪、保留期归一、预算占比、三级金额不重复计数、账本落后时的兜底
$NODE test/balance.test.mjs          # DeepSeek 官方余额（fetch 全部打桩）：域名白名单、金额解析、两条路线、错误形态
$NODE test/sub2api.test.mjs --offline # Sub2Api 适配器纯函数：解析、花费、口径分歧的结构化原因、溢出的数值字符串
$NODE test/workbuddy.test.mjs        # WorkBuddy 适配器（fetch 全打桩）：指纹判定、面板用量解析、归档窗口切分、credit 缺失不按 0 计
$NODE test/vision.test.mjs           # 模态补全纯函数
$NODE test/host.test.mjs             # host 半身：假 ctx + 打桩 fetch，驱动全部同源路由 + 跨站与 Host 拦截面 + 界面偏好 + 账本损坏 + 手工喂假流验证记账
$NODE test/client-page.test.mjs      # 客户端半身：假 React + 迷你 DOM 把设置页五个分页、侧栏块和「进行中 / 待查看」两段轨道真的渲染一遍
$NODE test/running-live.test.mjs     # 进行中 / 待查看轨道的纯推导：待处理优先、完成未读分区、子代理计数、折叠工作区含后代计数

# ── 联网：真实站，**不是门槛**（要能连上那 4 家站）──────────────────────
npm run test:net           # 严格：任一站不可达即退出码 1
npm run test:net:lenient   #  纯传输层不可达（DNS/TLS/超时）降级为 SKIP，只对断言失败退出 1
npm run test:all           # 离线 + 严格联网
```

**联网用例的失败分两类，别混**：断言失败（倍率被站方改了、模型清单空了）才是代码/口径问题；
传输层不可达是环境问题，`--allow-unreachable` 会把它降成 `SKIP` 并在汇总里标出来。
所以**别把 `npm test` 换成联网版**：离线那套才是唯一稳定的回归门槛。

`test/host.test.mjs` 里的假 settings 服务**照 `@deepseek-ai/dsh-settings` 的真实契约搭**：
`describe()` 返回带修订号的描述符、`mutate(ns, ops, expected)` 按 `applyPathOp` 的路径语义落值并在修订号对不上时抛
`SETTINGS_CONFLICT`。这样「补图片」写出去的 op 形状（`providers.<id>.models.<n>.input`，下标是十进制字符串）
在测试里就被真语义卡住了，而不是按想象测的。

`test/sub2api.test.mjs` 的联网用例会断言各站已知倍率（walkcoding `0.09`、st.walkcoding `0.12`、
nanshanyougui `0.10`、jiuhaoche `1`），倍率被站方改过会直接失败——这是刻意的：

```
walk-grok  → 倍率=0.09  官方价=407.324016  按倍率=36.6592  站方实扣=36.65916144
walk-gpt   → 倍率=0.12  官方价=240.8780449 按倍率=28.9054  站方实扣=28.905365388
nanshanyougui → 倍率=0.1 官方价=21.6428696 按倍率=2.1643   站方实扣=2.16428696
jiuhaoche  → 倍率=1     官方价=0.005074   按倍率=0.0051   站方实扣=0.006494  ← mismatch 告警（×1.28，倍率接口报 1）
```

### 代码结构

```
lib/sub2api.js        适配器核心：归一 baseURL、解析两个接口（+ 模型清单的 credits）、算花费。零依赖、可用任意 fetchImpl 测
lib/pricing.js        档位与计价：官方峰谷本地判定 + officialPeak 归一、站方倍率复算、credits、三层相乘、未定价语义、入账即固化（纯函数、零依赖）
lib/price-table.js         默认价目表（**自动生成，勿手改**）：DeepSeek 主表 + 17 家厂商目录 + 别名，每条带来源等级
lib/price-table-station.js 站方口径价目快照（**自动生成，勿手改**）：LiteLLM 价目（Sub2Api 就是用它算钱的）
lib/litellm-prices.js      站方价目：抓取链（raw → 镜像 → GitHub API blobs）、字段转换、长上下文档、合并
lib/usage-ledger.js        用量账本 + 侧栏/报表聚合：按天/按供应商/按会话/按模型加总、日汇总（本月/累计）、预算占比（纯函数、零依赖）
lib/billing-stream.js `llm/stream` 计费包裹：usage 捕获、嵌套只记一次、提前中断关流（零依赖）
lib/balance.js        DeepSeek 两条路线的余额：API Key（domain 白名单）与账号（平台 get_user_summary + 推理域兜底）
lib/vision.js         模态补全纯函数：判定 image 声明状态、算缺口、生成 settings.mutate 的路径 op
lib/workbuddy.js      WorkBuddy / 积分型适配器：面板地址归一、指纹判定、站方用量解析、归档按窗口求和（零依赖，可用任意 fetchImpl 测）
lib/running-live.js   侧栏进行中 / 待查看轨道的纯推导：活会话筛选、完成未读分区、待处理优先、子代理计数、折叠工作区含后代计数
lib/index.js          host 半身：枚举供应商、探测、补模态、包裹 llm/stream 记账、注册同源路由、状态变更路由的跨站拦截面
lib/client.js         客户端半身：手写模块，只 require('react')，注册设置卡片、侧栏底部、进行中 / 待查看轨道、设置页、输入区三块、右栏复制按钮等槽位
lib/credentials-refs.js 凭据文件里 `refs:` 段的**键名**解析（只取名字、不读值；失败即空，不抛）
test/*.mjs            十一套用例（离线门槛）：pricing / litellm-prices / credentials-refs / usage-ledger / balance / vision / running-live（纯函数）+ sub2api（纯函数 + 真实站联网）+ workbuddy（纯函数，fetch 全打桩）+ host（离线驱动路由、拦截面、账本损坏与假流）+ client-page（假 React + 迷你 DOM 真渲染）
research/             选型阶段的调研与实测报告（FEASIBILITY.md、DESIGN-provider-types.md）+ 两个价表导入器 + 四个探测脚本
```

---

## 十二、已知限制

按「硬限制（站方/上游决定，改不了）」与「未做（能补，还没补）」分开列，**不粉饰**。

### 硬限制

1. **只认 Sub2Api 计费口径**。`New API` / `one-api` 系**没有适配器**（选「其他」即完全不碰）——
   `research/relay-endpoint-map-newapi-oneapi.md` 里已有接口清单与源码级结论，落地还差一个适配器。
2. **积分倍率型站折算不出钱** —— 但**积分本身能读**。这类站 `/v1/usage` 是 404、
   只有 `/v1/models[].credits`（如 `"x0.11"`），既无余额也无「官方价」，所以**换货币仍然不可能**
   （要站点未公开的基准价，本模块**不猜**）。`workbuddy` 类型走它自带面板的
   `/panel/api/usage` 与 `/panel/api/request_logs`（同一把 key）读**今日积分**。
   注意两点限制：面板归档只留 7 天、单次上限 1000 条无分页；`creditsWeight()` 那条纯本地估算
   路径**没有标定过**，只作兜底展示，不要拿它当账（积分几乎全由缓存未命中贡献，按总量线性加权会系统性高估）。
3. **余额只有 DeepSeek 两条路线有接口**。中转站没有余额端点 → 侧栏不显示那一行，
   官方余额也只在 `api.deepseek.com` 域名上查（白名单，防 key 被送到别处）。
4. **多 key 的发现面仍不完整**。候选名扫描（默认 18 个）＋ `~/.dsh/.credentials.yaml` 的
   `refs:` 键名已经覆盖绝大多数命名；但**键名不在该文件里、也不符合候选前缀**的引用
   依然列不出来，只能靠 `state.json` 的 `deepseekKeys` 手填。另外凭据文件格式变了（非块状写法）就
   退回纯候选名探测，插件不抛错。
5. **`official` 价目只有 20 条**（DeepSeek 主表 4 + 厂商文档 16），其余 557 条落在
   `reseller` / `aggregator` / `unknown` 三档，默认**不参与计价**。没命中的模型就是未定价。
6. **峰谷提醒的判定跟着侧栏轮询走（间隔可配 10–60 秒）**。有两条路径：**提前量**（距切换不足
   `leadMinutes` 时提醒，同一个切换点只提醒一次）与**刚跨过**（切换点在 90 秒内才算）。
   所以：切换点最多晚一个轮询周期才提示；页面没开着就不会提醒（下次打开只记不报，不补报几小时前的换档）；
   系统通知要浏览器授权（被拒就只剩横幅）。要做秒级提醒得在宿主侧挂定时器，本插件不这么做。
7. **手工新增供应商时卡片不显示** —— 上游槽位分发时机所致，见「安装」。
8. **`GET /state` 会阻塞到本轮探测完成 + 补模态写盘完成**（首次约 1–2 秒，之后命中缓存），没做流式推送。
9. **拦截面只挡浏览器**：`Host` 白名单与 `Sec-Fetch-Site` / `Origin` /
   `content-type` 都靠浏览器自己带的头，所以本机脚本、`curl`（不带这些头）照样能打这些路由。
   想连本地进程也挡住，得让宿主 webserver 支持鉴权 —— 那不在本插件的能力范围内。
10. **账本文件坏掉时明细必丢**：`ledger.json` 读不出来（截断 / 权限 / 被占用）会按空账本启动，
    这时插件**留 warn、不覆盖 `days.json`**、并在报告的 `totals.today` 上标 `ledgerStale: true` ——
    金额（今日 / 本月 / 累计）来自日汇总，仍然对；但**今日会话 / 按模型 / 逐供应商明细**是真的没了
    （它们只存在账本里）。修好文件或等新调用进来就恢复。
11. **第三方额度体系不做**（Coding Plan 查询、自定义 Provider 余额端点、OpenCode Go 额度、
    外部用量快照、Token Plan 用量统计）—— 要引入 Cookie / AK-SK 签名等新凭据面，安全边界与现在不同。
    额度横条因此**没有「订阅额度」类 chip**，给的是预算已用 %、今日金额、峰谷档位与倒计时、官方余额。

### 未做（能补，还没补）

12. **并发按单进程假设**：写入只有防抖 + `tmp` 写 + `rename` 原子替换，**没有跨进程文件锁**。
    同一台机器跑两个宿主实例同时记账，理论上会互相覆盖。
13. **界面文案**跟在 `ui.locale` 后面（`auto` 用浏览器语言 / `zh` / `en` 固定），**没有接宿主的 locale 服务** ——
    宿主换语言不会自动改这里，得在设置页「显示 → 界面」里选。（接错 API 会把整张卡片打崩，所以先用防御式探测。）
14. **补图片只补「没声明过」的模型**：显式勾成纯文本的模型要靠「立即补图片」或手动勾。
    自动补全的触发点是「设置 → 模型」页面渲染出本插件的卡片（也就是 `/state` 被访问）——
    不开这个页面时不会后台定时扫。写盘失败会进入 30s 冷却，不会每次请求都撞同一堵墙。
15. **60s 缓存**：手动「刷新」立即生效；自动刷新最坏滞后 60s。
16. **峰谷「窗口 / 假期」没有填错时的二次确认**：界面只做格式与范围校验（`1-4,6-10`、起止不同、
    最多 24 条），把 `1-4` 写成 `1-14` 这种「格式合法但语义不对」的值会照收 —— 值本身是合法配置，
    插件不替用户判断意图。
17. **无 `sessionId` 的调用不去重**：宿主内部调用不一定带会话 id，那种情况一律放行（宁可多记一次
    也不漏账）。代价是「包装路由同一次调用到达两次」在这种调用上**可能**被记两次 —— 两害相权取其轻。
18. **界面全部验证跑在假渲染器上**，**没有在真实 `dsh web` 实例里跑过** ——
    `test/client-page.test.mjs` 是一份手写的迷你 React 桩（按组件身份存 hook 状态、
    按 deps 浅比较决定要不要重跑 effect），它能挡住逻辑回归，但挡不住「真实宿主槽位把 props 传成什么样」
    这类问题。装上以后请按下一节的手点清单过一遍。
19. **「包含子代理」依赖宿主给归属信息**：`/session` 的 `subagentSupported` 只有在账本里存在
    `parentSessionId` 时才为真。宿主不在调用事件里带父会话 id（或老账本），就只统计本会话 ——
    界面行尾会标「⚠ 宿主未提供子代理归属」，不假装算过。
20. **两处客户端渲染没有用例**：①「三个区块同时关掉 → 都不渲染」②「按模型统计的折叠态」。
    原因是假渲染器里已挂载实例读到的是上一次取数的快照（focus 重取不生效），断言会拿到旧档；
    测试文件原位注明了原因，没有写假绿断言。开关语义由 host 用例覆盖。
21. **会话费用的取数节奏固定 15 秒**（横条与角标则跟侧栏轮询，10–60 秒可配）。会话进行中这个数
    一直在涨，独立于侧栏轮询是有意的；想更密就得改源码里的 `SESSION_TTL_MS`。
22. **「导入安装前历史」只做能力探测**，不做回放 / 重定价。唯一可能的来源是宿主会话日志
    （`~/.dsh/sessions/<项目>/<会话>/session.jsonl.zstd`），实测是**分帧 zstd**、且没有公开的用量字段 schema
    （Node v24 的 `zstdDecompressSync` 只解得出会话头一行）。更重要的是：**回放会推翻**
    「依据在入账时冻结、之后只加总，不重算历史」这条硬规定 —— 一旦按当前价表回推旧调用，
    历史金额就会随改价变动，与官方账单对不上时也说不清是谁的问题。所以这里宁可不做，
    也不给出一个会漂的金额。
23. **「待查看」是完成未读提醒，不是完成历史**：宿主 `completionUnread` 是客户端内存态，
    会话重新运行 / 被打开成主视图 / 刷新页面都会清掉；所以顶部组刷新后会空，也没有
    批量已读或跨标签 / 跨窗口同步。要跨刷新保留完成记录，得插件自己持久化完成事件，
    不能只靠这个字段。

---

## 十三、装到真宿主机后的手点清单

这个插件的**全部自动化验证跑在假宿主 / 假渲染器上**（见上一节第 18 条），所以装上以后请按这份清单
过一遍。每条约 20 秒，共 5 分钟；任何一条不符就是「假渲染器没盖到的真实槽位问题」，值得回报。

**准备**：把本目录装进一个 profile 的 `node_modules`（或在 profile 里 `pnpm add <本目录>`），
重启 `dsh web`，确认左侧设置导航里出现「余额与费用」。

| # | 到哪看 | 期望 |
|---|---|---|
| 1 | 左侧栏底部 | 余额 / 今日 / 峰谷倒计时条都在；今日行旁边的供应商下拉能切。**「峰谷表」与「价格表」这两行默认不该出现**（设置页「显示 → 界面」勾上「侧栏显示峰谷表 / 价格表」才会回来） |
| 2 | 设置 → 余额与费用 → 概览 | 三张卡（今日 / 本月 / 累计）有金额与调用数；今日会话表有 `会话 / 调用 / 输入 / 缓存 / 输出 / 命中率 / 费用` 七列 |
| 3 | 概览 → 官方账户余额 | 点「刷新」出金额；多把 key 时余额行可点开明细 |
| 4 | 额度 | 供应商表列出已配置的站；「类型」列可改 |
| 5 | 用量 | 「Token 用量统计」有一格格 **26 周热力图**（悬停出当天明细）；展开「按模型统计」切换**今日 / 全部历史**与**四种排行**，顺序真的会变 |
| 6 | 价格 | 各来源等级条数 + 「更新价格表」按钮；点完有出处与时间 |
| 7 | 显示 → 界面 | 把语言切到 `English`：**整页立刻变英文**（不用刷新）；切回 `自动` 回中文 |
| 8 | 显示 → 界面 | 刷新间隔改 10 秒 → 侧栏取数变密（观察网络面板或今日金额更新频率） |
| 9 | 显示 → 界面 | 勾「隐藏官方余额」→ 侧栏余额行与概览余额段**同时消失**；「隐藏今日消耗」→ 今日行与今日卡消失；勾「侧栏显示峰谷表 / 价格表」→ 侧栏底部**当场**多出那两行（不勾就没有） |
| 10 | 显示 → 官方峰谷 | 段末那张「峰谷表」列着接下来 6 个切换点（本地时刻 + `→ 高峰` / `→ 平价` + 倒计时）；关掉「启用峰谷档」并保存后，那张表写「峰谷没有开启」而不是留空 |
| 11 | 显示 → 峰谷提醒 | 点「预览进入峰 / 谷」→ **设置页当场**弹出浮层（带「预览」字样）；位置选「屏幕中心」后重预览，浮层居中 |
| 12 | 显示 → 模型花费卡片 | 打开后侧栏出现卡片；收起时标题行给 Top-1；改「模型行数 / 卡片位置 / 周期」立刻反映 |
| 13 | 输入框区域 | 打开「额度横条」→ 输入框上方出现 `预算 x% · 今日 · 峰谷 · 余额` 一排 chip，点一下会刷新；**这排 chip 与下一行的左边，跟输入卡片的正文对齐**（贴的是会话内容列，不是会话面板最左边缘） |
| 14 | 输入框区域 | 打开「本会话费用」（位置默认「输入框下方」）→ **输入卡片下面那条**出现「本会话 ¥… ｜ N 次 ｜ … tok ｜ 命中 …」，**左边与输入卡片正文对齐**；改「显示位置 → 输入框上方」后换到卡片上方那条、变成居中；再改「会话标题栏」后换到标题栏，那处**不缩**成卡片宽 |
| 15 | 侧栏工作区顶部 | 有会话在跑时出现「进行中」轨道；最多 5 行，超出有「还有 N 个」；点一行能打开那个会话。下方若还有完成未读，会另起「待查看」段 |
| 16 | 折叠一个工作区 | 该工作区行右侧出现状态点 + 数量；展开后徽章消失；折叠着点轨道里的会话，能打开并顺手把工作区展开 |
| 17 | 对话一次 | 发一条消息，**本会话费用与今日金额都要涨**（最多慢 15 秒）；侧栏「今日」同步 |
| 18 | 峰谷提醒 | 若正好接近切换点（提前量内），侧栏弹浮层；否则点「预览」验证样式即可 |
| 19 | 显示 → 历史数据 | 点「导入安装前历史」→ 显示扫描到几份日志 + 原因；点「清除全部历史」→ 先出现「再点一次确认清空」，点第二下才清，并回显清了多少天/多少条 |
| 20 | 清空后 | 概览三张卡归零、今日会话表为空、热力图空 —— 再发一条消息，从零开始涨（不是回到旧数） |
| 21 | 设置 → 模型 → DeepSeek 卡片 | 密钥区只列**这条路线自己的引用**（`DEEPSEEK_API_KEY` / `_2`…），别家供应商的引用名一个都不出现；「保存 key」不被卡片边缘切、窄宽度下换行；「主 key（宿主正在用）」与 key 值各占一行不叠字；一把 key 都没有时明确写着「这个供应商还没有可用的密钥引用」 |
| 22 | 右栏「文件」 | 路径右侧有复制图标，悬停「复制目录路径」，点一下剪贴板是**当前目录**的绝对路径。点进一个文件后，预览头部最右侧另有一颗，悬停「复制文件路径」，剪贴板是**该文件**的绝对路径（不是文件内容） |
| 23 | 侧栏工作区顶部（待查看） | 让一个会话在后台跑完后切到别的会话：顶部出现「待查看 N」和绿点，最多 3 行；折叠/展开只影响这一段。点一行能打开并展开所属工作区，打开后该行和绿点一起消失。待审批 / 正在跑 / 带运行中子代理的会话只留在「进行中」，不能两段都出现。刷新页面后待查看段消失（预期，不是 bug） |
| 24 | 窄侧栏 / 移动端抽屉 | 收起侧栏或 dsh-mobile 抽屉：余额块和轨道都不出现，左上角徽章显示「进行中 + 待查看」合计数；只有待查看时徽章为绿色。展开后余额块与两段轨道恢复。不应出现竖排的「进行中」或被裁的文字 |

> 第 17 条最关键：它验证的是「宿主真实调用事件 → 记账 → 三个界面」这条完整链路，
> 这条链路在假宿主里是靠手工喂假流模拟的。

---

## License

MIT。
