# dsh-balance-monitor

DeepSeek Harness 插件：在**设置 → 模型**的每张供应商卡片里加一个「供应商类型」配置项。

- **其他**（默认）：什么都不做，与原行为完全一致。
- **Sub2Api**：用该供应商自己的 API Key 查询**额度 / 倍率 / 模型**，并按 `官方价 × 生效倍率` 算出**花费**。

只支持 Sub2Api 一种中转站类型（按用户决定，`New API` 类型暂不做）。

### 0.7.0 改了什么（本轮收口）

| 项 | 之前 | 现在 |
|---|---|---|
| `officialPeak` | 只在代码里注释「可存进 state.json」，`loadStore()` **根本不读**它 → 改峰谷窗口/假期只能改源码 | 真的接通了：`state.json` 或设置页「显示 → 官方峰谷」都能改（逐字段覆盖 + 打字错保护），并进计价依据指纹 |
| 状态变更路由 | 只靠「监听回环」当防护；任意网页的简单 POST 能删 key / 改类型 / 触发抓取 | 加跨站拦截面：`Sec-Fetch-Site` / `Origin` / `content-type` 三条判据（见第五节） |
| 密钥扫描配置 | 后端认 `scanCredentialsFile` / `deepseekKeyPrefixes` / `deepseekKeyMaxIndex`，**前端没入口** | 设置页「显示 → 密钥扫描」补齐三个控件（含格式校验与回填） |
| 多 key 明细 | 手填的引用没有 label → 侧栏只剩裸引用名 | 按名字派生短标签（`DEEPSEEK_API_KEY_2` → `API KEY 2`），卡片填的 label 仍优先 |
| `mismatch` 告警 | 只说「与站方实扣不一致」，不给原因 | 宿主给结构化原因（差多少倍 / 方向 / 倍率是否报 1 / 逐模型反推区间），客户端按语言拼句子 |
| README | 路由表缺 `/keys`（四条方法）与 `/keys/reveal`；字段表缺 5 个键；「API Key 从不进响应体」与实现矛盾 | 补齐路由表与字段表，安全表述改成事实描述 |
| 测试门槛 | 离线 289 用例 | 离线 **322** 用例（新增 officialPeak 归一、跨站拦截面、label 派生、mismatch 原因、密钥扫描配置） |

---

## 一、它查什么

上游项目：[`Wei-Shaw/sub2api`](https://github.com/Wei-Shaw/sub2api)。三个接口都是 sk- Key 可读的只读接口（已实测）：

| 接口 | 拿到什么 |
|---|---|
| `GET {root}/v1/usage` | `mode` / `quota{limit,used,remaining}` / `rate_limits[]` / `subscription{...}` / `balance` / `unit` / `planName` / `usage{today,total}` / `daily_usage[]` / `model_stats[]` |
| `GET {root}/v1/sub2api/billing` | `group_rate_multiplier` / `user_rate_multiplier` / `resolved_rate_multiplier` / `peak_rate_enabled` / `peak_start` / `peak_end` / `peak_rate_multiplier` / `applied_peak_multiplier` / **`effective_rate_multiplier`** / `timezone` |
| `GET {root}/v1/models` | 模型清单 |

`root` 由 provider 的 `baseURL` 归一得到：结尾的 `/v1` 会被剥掉，但 `/api/<name>` 这类子路径挂载不会被截断
（`https://walkcoding.top/v1` → `https://walkcoding.top`；`https://nexus.itssx.com/api/grok45` → 原样）。

### 花费怎么算

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
0.7.0 起不只标「不一致」，还给出**结构化原因**（宿主管算事实、客户端按语言拼句子）：差多少倍、
高还是低、倍率接口是不是报的 1（＝多半不按「官方价 × 倍率」这条公式计费）、
以及逐模型反推倍率的区间（＝站方按模型逐个定价）。

### DeepSeek 的**两条路线**（0.6.0 新增：余额可点击切换）

登录 DeepSeek 账号后，宿主里会有**两个** DeepSeek 供应商，它们是**两份不同的钱**：

| 界面名 | provider id | 认证 | 余额来源（实测） |
|---|---|---|---|
| `DeepSeek` | `deepseek-official` | `Authorization: Bearer`（API Key） | `api.deepseek.com/user/balance` → 例：`-0.01 CNY` |
| `DeepSeek Account` | `deepseek-account` | `x-dsh-auth-token`（宿主 `deepseekAccount` 服务签发） | `platform.deepseek.com/api/v0/users/get_user_summary` → 例：`normal_wallets -0.0433720200000000` · `bonus_wallets 0` |

- **怎么知道有哪些 key**（两条路一起用）：
  1. **按候选名探测**：宿主凭据服务没有枚举 refs 的接口（`listRecords()` 只覆盖 `records:` 段），
     所以插件用 `credentials.describe(ref)` 逐个问（只回「有没有配 / 来源」，**不读值**）：
     默认扫 `DEEPSEEK_API_KEY`、`DEEPSEEK_API_KEY_2`…`_9` 与 `DEEPSEEK_KEY*`（共 18 个），
     扫描范围可用 `deepseekKeyPrefixes` / `deepseekKeyMaxIndex` 改（设置页「显示 → 密钥扫描」）。
  2. **读凭据文件的引用名**（0.7.0）：直接解析 `~/.dsh/.credentials.yaml` 里 `refs:` 段的**键名**
     —— 命名再怪也列得全。**只取键名，值连读都不读**（正则只捕获冒号前的名字，不在结果里）；
     关掉的方式是 `state.json` 的 `scanCredentialsFile: false`，插件就退回纯候选名探测。
- **多把 key**：宿主自己的 DeepSeek API Key 适配器只认一把（`apiKeyEnv` 是单值），想按多把 key 汇总
  就用 `deepseekKeys` 列引用（字符串或 `[{ ref, label }]`）——**侧栏余额 = 各把 key 之和**，
  币种不一致时不显示总额。没填 label 的引用会按名字派生一个短标签（`DEEPSEEK_API_KEY_2` → `API KEY 2`）。
- **卡片上的密钥编辑区**（0.7.0）：在 DeepSeek 卡片的「添加 key」行里直接填 key → `PUT /keys`
  写进宿主凭据库（顺位引用名，或自己填 `ref` / `label`），每行可删（**主 key 拒绝删**，
  要换请走卡片上方宿主自己的「API 密钥」）。默认**不预取明文**，点行内小眼睛才 `POST /keys/reveal`
  拉一次值；该路由只认「属于这条路线」的引用（别的引用一律 403）。
- 侧栏**余额行点一下就在两条之间切换**（`余额 · DeepSeek ⇄ ¥0.01` → `余额 · DeepSeek Account ⇄ ¥-0.04`），
  选择记在 `localStorage['balance-monitor:sidebar-balance']`；只有一条路线时不可点（提示里说明）。
- 账号路线的 token 由宿主服务签发（只有宿主拿得到），插件**不读**磁盘上的凭据值
  （唯一碰 `~/.dsh/.credentials.yaml` 的地方是上面那条「只取键名」）；
  平台端点失败时回落到推理域（同一 token 也认，但金额被官方四舍五入到 2 位），并标注来源
  （`account-platform` / `account-api` / `api-key`）。
- **两条都按官方计价**：不打站方倍率，也不算「未定价」。
- 设置页「概览 → 官方账户余额」把两条并列显示；「刷新余额」两条一起刷（也可指定 `provider`）。

### 设置页「余额与费用」（0.5.0 新增）

设置 → **余额与费用**（`settings.section`，order 32）一个页面五个分页：

| 分页 | 内容 |
|---|---|
| **概览** | 三张卡：今日 / 本月 / 累计费用（金额 + 调用次数 + 输入/缓存/输出）；今日会话明细表（会话 / 调用 / 输入 / 缓存 / 输出 / 命中率 / 费用）；预算（开关 + 额度 + 周期今日/本月/累计 + 进度条 + 超支预警）；官方账户余额（总余额/赠送/充值/更新于 + 「刷新余额」） |
| **额度** | 逐供应商：类型 / 状态 / 倍率 / 峰谷 / 模型数 / 今日费用 / 备注（余额、套餐、到期时间、错误） |
| **用量** | 累计输入 / 缓存（含缓存写入）/ 输出（含推理）/ 命中率；近 60 天柱状；今日按模型明细 |
| **价格** | 计价依据指纹；来源等级分布（各等级条数）；**勾选参与计价的来源等级**（推荐组合一键还原）；「更新价格表」按钮；价目元数据（最近更新 / 条数 / 来源地址 / 数据出处） |
| **显示** | 币种 / 符号 / 小数位 / 汇率 + 保存；账本保留（明细 / 日汇总天数）+ 独立保存；峰谷提醒两个勾选框（应用内 / 系统通知，勾选即写）；**密钥扫描**（读凭据文件引用名的开关 + 候选前缀 + 序号上限，独立保存）；**官方峰谷**（启用开关 + 高峰窗口 `1-4,6-10` + 假期列表，独立保存） |

**本月 / 累计为什么不靠账本**：账本只留最近几天原始记录（默认 7 天，供会话明细），所以另有
`storages/dsh-balance-monitor/days.json` —— 每天把当日总额**覆盖式**写进去（幂等），默认保留 400 天。
两个天数都能在设置页「显示 → 账本保留」里改（见第四节 `retention`）。
报表里的「今日」仍以账本为准，两者相减避免重复计数。

**改配置会发生什么**：`display` / `budget` / `priceSources` / `officialPeak` / 密钥扫描三项
都是白名单写入 `state.json`；改币种、汇率、来源等级或**峰谷窗口/假期**会换掉计价依据指纹（`p1-…`），
**只影响之后的调用**，历史金额一分不动（未定价的调用仍然显示 `—`，不会被画成 0）。
密钥扫描三项不进指纹（它只决定「能发现哪些 key」）。

### 侧栏底部：余额 / 今日 / 峰谷倒计时（0.3.0 新增）

侧栏底部走宿主的 `sidebar.footer.action` 槽位（list / root 作用域），显示三样东西：

| 行 | 内容 | 数据来源 |
|---|---|---|
| 余额 | `余额 ¥0.01` | **只有 DeepSeek 官方**有余额接口（`GET https://api.deepseek.com/user/balance`）；其余供应商不显示这一行 |
| 今日 | `今日 ¥0.0000` + 供应商下拉 | 所有供应商**相加**，金额是**倍率之后**的实际花费（不是官方原价） |
| 峰谷条 | 细进度条 + `剩余 5 小时 3 分后进入平价` | 官方峰谷相位（本地窗口 + 周末全谷 + 调休表），见第八节 |
| 峰谷表 | `峰谷表 · 预览 · 6` → 展开列出接下来的切换点（本地时刻 + `→ 高峰` / `→ 平价` + 相对倒计时） | `lib/pricing.js` 的 `upcomingSwitches()`（默认 6 个，最多 24），宿主算好随 `/sidebar` 一起下发 |

`今日` 的金额来自账本：宿主包裹 `llm/stream`，每次调用用**调用时刻**的档位算出
「官方价 × 站方倍率 × credits」并落成一条记录（`storages/dsh-balance-monitor/ledger.json`），
之后只做加总。三条不猜的规则：

1. **没探到倍率的中转站不按 1 算** —— token 照记、金额留空，侧栏显示「N 笔未定价」；
2. **未定价 ≠ 0** —— 金额为 `null` 时显示 `—`，不画成 `¥0`；
3. **依据变更不重算历史**（第八节），所以下拉切换供应商时看到的历史不会因为改价而变。

供应商下拉（`全部` / 各家）只影响**看谁**：选 `全部` 显示各家相加，选某一家显示它的
金额、调用次数、命中率、token 与逐模型明细。选择记在浏览器 `localStorage`。

轮询与节流：客户端每 30s 拉一次 `GET /sidebar`；宿主对中转站的探测有 **5 分钟冷却**
（不让侧栏的常驻轮询把探测节奏带起来），官方余额 60s 缓存。缓存里没有倍率的供应商
在探测发生前一直记「未定价」。

---

## 二、图片模态自动补全（0.2.0 新增）

手工声明一个中转站供应商时，每个模型条目都没有 `input`，而 pi-ai 对没有 `input` 的条目回落
`DEFAULT_INPUT = ["text"]`（`@deepseek-ai/dsh-llm-pi-ai`），宿主于是**把图片投影成文本占位**发给模型 ——
表现就是「图能拖进去，模型看不见」。中转站的模型基本都是多模态的，缺的只是这一行声明，本插件把它补上：
**新加的供应商不用再逐个模型勾「图片」。**

卡片上的两个控件：

| 控件 | 行为 |
|---|---|
| ☑ 新模型自动补图片（默认**开**） | 打开「设置 → 模型」这个页面时自动检查并补全，不需要点任何东西 |
| 立即补图片 | 手动补一次，**连显式勾成纯文本的模型也一起补** |

**首次打开就会对 auto 开着的供应商补一次**（这是「不用每次手动添加」的代价）。装到本机 profile 上时，
按当前 `cordis.patch.yml` 算，会写 8 个模型：`walk-grok` 的 `grok-4.5` + `pojia-gpt` 的全部 7 个
（`jiuhaoche` / `walk-gpt` / `nanshanyougui-claude` / `wbfd` 都已是全声明状态，不会被动）。
不想让某家被自动补，就先在 `state.json` 的 `autoImage` 里把它置 `false`（或在卡片上取消勾选）。

补全规则（只有两条，都是刻意的）：

1. **只加不减**：已经声明 `image` 的条目一个字都不动。
2. **显式优先**：`input: ["text"]` 是你明确勾的纯文本模型，**自动**补全会跳过它（卡片上会写「另有 N 个显式纯文本」），
   只有按「立即补图片」才会覆盖 —— 免得插件和你的显式选择来回打架。

写进去的就是 `llm-pi-ai.providers.<id>.models[].input: [text, image]`；卡片上显示
`已声明 / 总数`，补完之后列出这一次补了哪几个模型。

### 它是怎么落盘的（不是自己改 YAML）

走宿主 `settings` 服务（`@deepseek-ai/dsh-settings` + `@deepseek-ai/dsh-config-editor`）的
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

## 三、安装

本插件是标准的 DSH bundle 包，用一个 `cordis.patch.yml` 插一行 host 行。

**在 Harness 里装**：设置 → 插件 → 安装 bundle，目标目录填本仓库的绝对路径。

装完需要重启 `dsh web`（替换已安装包的 JS 模块需要重启才会加载新代码）。
装好之后打开 **设置 → 模型**，每张供应商卡片下方会出现「供应商类型」。

> 不通过 `plugin_manager` 手写 profile 的 `package.json` / `cordis.patch.yml`：那两步由安装动作自己完成。

### 一个上游限制（不是本插件的 bug）

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

## 四、配置存在哪

本插件自己持久化的只有两件事（「类型」和「自动补图片」开关）：

```
$DSH_HOME/storages/dsh-balance-monitor/state.json     ← 类型 / 自动补图片 / 展示币种 / 保留期 / 价表覆盖
$DSH_HOME/storages/dsh-balance-monitor/ledger.json    ← 调用账本（按天，含依据指纹；默认保留 7 天）
$DSH_HOME/storages/dsh-balance-monitor/days.json      ← 日汇总（本月/累计用；默认保留 400 天，覆盖式写入）
$DSH_HOME/storages/dsh-balance-monitor/prices.json    ← 站方口径价目（点「更新价格表」后写入）
```

`state.json` 可选字段（都可不写，缺省即默认值）：

```json
{
  "version": 2,
  "types": { "walk-grok": "sub2api" },
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
  "priceSources": ["official", "station", "manual"],
  "priceTable": { "models": { }, "providers": { }, "aliases": { } }
}
```

- `display`：金额展示币种（账本恒以美元存；CNY 时按 `exchangeRate` 乘回，与参照实现同名的四个字段）。
- `budget`：预算额度 + 周期（`today` / `month` / `all`），设置页「概览」可改。
- `retention`：两份文件的保留天数（`ledgerDays` 账本明细 / `rollupDays` 日汇总），设置页「显示」可改；
  两者都能省，允许 `1 – 3650`，且**日汇总不会短于明细**（不合法就各自回落默认）。
  调小**立刻**裁掉超期数据（`POST /config` 时同步裁剪并落盘），调大只影响之后的留存。
- `peakNotify`：峰谷提醒开关（`enabled` 侧栏横幅 / `system` 系统通知），设置页「显示」可改。
  两位都是**局部覆盖**：只提交一位不会把另一位带掉；两个都关 = 清掉这条配置。默认都关（不弹）。
  判定跟着侧栏 30s 轮询走，且只对**刚发生**的换档提醒（90s 内）——页面关着跨过的那次只记不报。
- `officialPeak`：官方峰谷配置，**逐字段**覆盖随包默认表（第八节），设置页「显示 → 官方峰谷」可改。
  字段缺失或非法 → 该字段回落默认；`windows: []`（永不判峰）与 `holidays: []`（没有假期）是**有效值**，
  但「给了非空数组却一条都不合法」按打字错处理、回落默认（免得一个笔误丢掉整年假期）。
  改它会换计价依据指纹，**只影响之后的调用**。
- `deepseekKeys`：多把 DeepSeek API Key 的**凭据引用**列表（字符串或 `{ ref, label }`），
  卡片上的密钥编辑区会自动维护它；侧栏余额 = 各把之和（币种不一致就不给总额）。
- `deepseekKeyPrefixes` / `deepseekKeyMaxIndex`：候选名探测的前缀与序号上限
  （默认 `DEEPSEEK_API_KEY`、`DEEPSEEK_KEY` × `_2…_9`），设置页「显示 → 密钥扫描」可改。
- `scanCredentialsFile`：读 `~/.dsh/.credentials.yaml` 里 `refs:` 段的**键名**（不读值）来补全候选名。
  只有显式 `false` 才关（关掉就退回纯候选名探测）；默认开。
- `priceSources`：允许参与计价的来源等级（第八节）；不写就是 `official + station + manual`。
- `priceTable`：整段覆盖默认价表（默认表见第八节）；不写就用随包的默认表（官方快照 + 站方快照）。
- `ledger.json` / `days.json` / `prices.json`：账本 / 日汇总 / 站方价目；账本**只加总不重算**。

**探测结果只放内存**（60s 缓存），不落盘：账号余额/花费不在磁盘上留副本。

API Key 对外的**只读**痕迹只有 `hasKey: true/false`。但要说清楚两条例外（0.7.0 起）：
`GET /keys` 只回「引用名 + 配没配」（**不含值**）；`POST /keys` 会把你在卡片上填的 key
写进宿主凭据库（`credentials.set`），`POST /keys/reveal`（点卡片上的小眼睛才走）会把某个
引用的**明文**回给界面。也就是说「key 不落盘、不进响应体」这句只对**探测流程**成立，
密钥编辑区这条路是显式写入/读取宿主凭据库的，见第五节。

这两个字段都**不写进 pi-ai 的 provider 配置**。上游的 provider profile schema 是 `z.object(...)`（非 strict），
往里面塞自定义字段能否存活没有验证过；本插件把自己的状态放在自己的存储里、按 provider id 索引，绕开这一点。
（反过来，补图片写的 `models[].input` 是 pi-ai **自己的字段**，走的是 `settings.mutate`，和内置设置页同一条路。）

---

## 五、宿主与客户端怎么通信

浏览器侧跨域取不到中转站接口（实测 `GET /v1/sub2api/billing` 带 `Origin` 也不返回
`Access-Control-Allow-Origin`，`OPTIONS` 直接 403），所以**所有出网请求都在宿主侧做**，
客户端只访问宿主自带 webserver 上的**同源**路由：

```
GET    /plugins/dsh-balance-monitor/state                  → { ok, state }
GET    /plugins/dsh-balance-monitor/sidebar                → { ok, data }（余额/今日/峰谷相位）
POST   /plugins/dsh-balance-monitor/type    { provider, type }
POST   /plugins/dsh-balance-monitor/refresh { provider? }
POST   /plugins/dsh-balance-monitor/vision/auto  { provider, enabled }
POST   /plugins/dsh-balance-monitor/vision/apply { provider? }
GET    /plugins/dsh-balance-monitor/report                 → { ok, data }（设置页「余额与费用」整页数据）
POST   /plugins/dsh-balance-monitor/config { display?, budget?, retention?, peakNotify?, priceSources?,
                                             officialPeak?, scanCredentialsFile?, deepseekKeyPrefixes?,
                                             deepseekKeyMaxIndex?, deepseekKeys? }
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

### 状态变更路由的跨站拦截面（0.7.0 新增）

这个 webserver 本身不鉴权（宿主不管认证），所以「本机任意进程」挡不住、也没打算挡
（它能直接读凭据文件）。要挡的是**任意网页**：一个简单请求（无预检）就能把 POST 打进来，
让插件替你删 key / 写 key / 改类型 / 触发抓取。所以 `POST` / `PUT` / `DELETE` / `PATCH`
一律先过三条判据，任一条命中即拒：

| 判据 | 响应 | 挡的是什么 |
|---|---|---|
| `Sec-Fetch-Site` 存在且不是 `same-origin` / `none` | `403` | 跨站请求（含同站子域） |
| `Origin` 存在且与 `Host` 不同源（含字面量 `null`） | `403` | 跨源请求 / 沙箱 iframe / `file://` |
| `content-type` 存在但不是 `application/json` | `415` | HTML 表单、`no-cors` fetch |

三个头**都不带**时放行（`curl`、脚本、老客户端）—— 那不是浏览器发起的跨站请求，拦它只会把
命令行用法挡在门外。GET 一律不校验。所以从脚本调这些路由时，**带上
`content-type: application/json`** 最稳妥（不带也能过，但带上就走正规路径）。

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

同理，请求侧也照 cost-meter 的有效做法做了硬加固，而不是依赖声明式的 `dshhub.permissions.network`
（该字段在 121 MB 的 `app.asar` 里出现 0 次，**没有任何运行时强制**）：

- `redirect: 'manual'` + 显式拒绝 3xx —— 防止 `Authorization` 头被带到重定向目标主机
- 响应体上限 512 KiB，流式计字节、不信 `Content-Length`（SPA 回落页可能有几十 KB）
- HTTPS 之外一律不发；出网只可能是 `baseURL` 推导出的 `/v1/usage`、`/v1/sub2api/billing`、`/v1/models`

---

## 六、开发与验证

```bash
NODE="C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"

# ── 门槛：全部不出网（离线 322 个用例 / 9 套）────────────────────────────
npm test                # = npm run test:offline
# 单独跑某一套：
$NODE test/pricing.test.mjs          # 档位与计价纯函数（79 个用例）：官方峰谷（含未来切换点）、officialPeak 归一、站方倍率复算、credits、未定价语义、价表命中、来源等级策略
$NODE test/litellm-prices.test.mjs   # 站方口径价目（17 个用例，fetch 全部打桩）：字段映射、渠道条目过滤、长上下文档、抓取链四种形态、合并位置
$NODE test/credentials-refs.test.mjs # 凭据引用名（8 个用例）：refs 段解析、只看名字不读值
$NODE test/usage-ledger.test.mjs     # 用量账本 + 侧栏/报表聚合（40 个用例）：按天/供应商/会话/模型加总、日汇总幂等与裁剪、保留期归一、预算占比、三级金额不重复计数
$NODE test/balance.test.mjs          # DeepSeek 官方余额（17 个用例，fetch 全部打桩）：域名白名单、金额解析、两条路线、错误形态
$NODE test/sub2api.test.mjs --offline # Sub2Api 适配器纯函数（34 个用例）：解析、花费、口径分歧的结构化原因
$NODE test/vision.test.mjs           # 模态补全纯函数（10 个用例）
$NODE test/host.test.mjs             # host 半身：假 ctx + 打桩 fetch，驱动全部同源路由（含 /report、/config、/prices、/keys）+ 跨站拦截面 + 手工喂假流验证记账（87 个用例，全程离线）
$NODE test/client-page.test.mjs      # 客户端半身：假 React 把设置页五个分页 + 侧栏**真的渲染一遍**，并点击按钮验证打到了宿主路由（30 个用例）

# ── 联网：真实站，**不是门槛**（要能连上那 4 家站）──────────────────────
npm run test:net           # 严格：任一站不可达即退出码 1
npm run test:net:lenient   #  纯传输层不可达（DNS/TLS/超时）降级为 SKIP，只对断言失败退出 1
npm run test:all           # 离线 + 严格联网
```

**联网用例的失败分两类，别混**：断言失败（倍率被站方改了、模型清单空了）才是代码/口径问题；
传输层不可达是环境问题，`--allow-unreachable` 会把它降成 `SKIP` 并在汇总里标出来。
所以**别把 `npm test` 换成联网版**：离线 322 个用例才是唯一稳定的回归门槛。

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
lib/index.js          host 半身：枚举供应商、探测、补模态、包裹 llm/stream 记账、注册同源路由（含 /report、/config、/prices、/keys）、状态变更路由的跨站拦截面
lib/client.js         客户端半身：手写模块，只 require('react')，注册「设置卡片」+「侧栏底部」+「设置页：余额与费用」三个槽位
lib/credentials-refs.js 凭据文件里 `refs:` 段的**键名**解析（只取名字、不读值；失败即空，不抛）
test/*.mjs            九套用例，离线门槛 322 个：pricing / litellm-prices / credentials-refs / usage-ledger / balance / vision（纯函数）+ sub2api（纯函数 + 真实站联网）+ host（离线驱动路由、跨站拦截面与假流）+ client-page（假 React 真渲染）
research/             选型阶段的调研与实测报告（FEASIBILITY.md、DESIGN-provider-types.md）+ 两个价表导入器 + 四个探测脚本
```

---

## 七、已知限制

按「硬限制（站方/上游决定，改不了）」与「未做（能补，还没补）」分开列，**不粉饰**。

### 硬限制

1. **只认 Sub2Api 计费口径**。`New API` / `one-api` 系**没有适配器**（选「其他」即完全不碰）——
   `research/relay-endpoint-map-newapi-oneapi.md` 里已有接口清单与源码级结论，落地还差一个适配器。
2. **积分倍率型站（wbfd 这类）折算不出钱**。这类站 `/v1/usage` 是 404、只有 `/v1/models[].credits`
   （如 `"x0.11"`），既无余额也无「官方价」，只能给**相对量**（`creditsWeight()`）。
   换货币要站点未公开的基准价，本模块**不猜**。
3. **余额只有 DeepSeek 两条路线有接口**。中转站没有余额端点 → 侧栏不显示那一行，
   官方余额也只在 `api.deepseek.com` 域名上查（白名单，防 key 被送到别处）。
4. **多 key 的发现面仍不完整**。候选名扫描（默认 18 个）＋ `~/.dsh/.credentials.yaml` 的
   `refs:` 键名（0.7.0）已经覆盖绝大多数命名；但**键名不在该文件里、也不符合候选前缀**的引用
   依然列不出来，只能靠 `state.json` 的 `deepseekKeys` 手填。另外凭据文件格式变了（非块状写法）就
   退回纯候选名探测，插件不抛错。
5. **`official` 价目只有 20 条**（DeepSeek 主表 4 + 厂商文档 16），其余 557 条落在
   `reseller` / `aggregator` / `unknown` 三档，默认**不参与计价**（见第八节）。没命中的模型就是未定价。
6. **峰谷提醒的粒度是 30 秒**。判定、相位、侧栏倒计时、一键预览切换点、跨档提醒（侧栏横幅 +
   可选系统通知）都有；但提醒是**跟着侧栏 30s 轮询**在客户端比出来的，所以：
   切换点最多晚 30s 才提示；页面没开着就不会提醒（下次打开只记不报，不补报几小时前的换档）；
   系统通知要浏览器授权（被拒就只剩横幅）。要做秒级提醒得在宿主侧挂定时器，本插件不这么做。
7. **手工新增供应商时卡片不显示** —— 上游槽位分发时机所致，见第三节。
8. **`GET /state` 会阻塞到本轮探测完成 + 补模态写盘完成**（首次约 1–2 秒，之后命中缓存），没做流式推送。
9. **跨站拦截面只挡浏览器**（0.7.0，见第五节）：`Sec-Fetch-Site` / `Origin` / `content-type`
   三条判据都靠浏览器自己带的头，所以本机脚本、`curl`（只要不带这些头）照样能打这些路由。
   想连本地进程也挡住，得让宿主 webserver 支持鉴权 —— 那不在本插件的能力范围内。

### 未做（能补，还没补）

10. **并发按单进程假设**：写入只有防抖 + `tmp` 写 + `rename` 原子替换（`lib/index.js:320`），
    **没有跨进程文件锁**。同一台机器跑两个宿主实例同时记账，理论上会互相覆盖。
11. **界面文案**按浏览器语言在 zh/en 之间二选一，还没有接宿主的 locale 服务
    （接错 API 会把整张卡片打崩，所以先用防御式探测）。
12. **补图片只补「没声明过」的模型**：显式勾成纯文本的模型要靠「立即补图片」或手动勾。
    自动补全的触发点是「设置 → 模型」页面渲染出本插件的卡片（也就是 `/state` 被访问）——
    不开这个页面时不会后台定时扫。写盘失败会进入 30s 冷却，不会每次请求都撞同一堵墙。
13. **60s 缓存**：手动「刷新」立即生效；自动刷新最坏滞后 60s。
14. **峰谷「窗口 / 假期」没有填错时的二次确认**：界面只做格式校验（`1-4,6-10` 这种写法），
    把 `1-4` 写成 `1-14` 这种「格式合法但语义不对」的值会照收 —— 值本身是合法配置，
    插件不替用户判断意图。

---

## 八、档位与计价（`lib/pricing.js`）

「一次调用花了多少钱」必须在**调用发起的那一刻**把档位固定下来再算，否则峰谷一过、
倍率一变，历史金额会跟着变。这个模块把三家来源归一成**三层相乘**（纯函数、零依赖）：

```
金额 = 单位价档位（官方峰谷选列，本地算）      tierFor()
     × 站方账户倍率（含站方峰谷因子，快照 + 本地复算）  resolveProviderRate()
     × 积分倍率（credits 型站，按模型静态）      creditsOf()
```

### 为什么不能合并成一个窗口表

官方峰谷是「在价表里选两列价之一」（谷价列 / 峰价列）；站方峰谷是「乘在金额上的因子」。
两者时区来源、语义、是否需要网络都不同，合并会同时算错两边。

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
  设置页把它写成 `1-4,6-10` 这种紧凑形式，保存前解析回数组（格式不对就不让保存）。
- `holidays` 是北京日历日，**每年要人工更新** —— 0.7.0 起不用改源码了：设置页「显示 → 官方峰谷」
  的假期输入框（逗号分隔）或 `state.json` 的 `officialPeak.holidays` 都能改。
  调休上班的周末仍按周末判谷。
- `effectiveAt` 之前的调用不套峰谷，`legacyBoundary` 之前按价表的 `legacyBase`（历史正确性）。
- 归一规则（`lib/pricing.js` 的 `normalizeOfficialPeak`）：字段缺失/非法 → 该字段回落默认；
  `windows: []`（永不判峰）与 `holidays: []`（没有假期）是有效值；给了非空数组却一条都不合法
  按打字错处理、回落默认。`enabled: false` 或空窗口会让相位块整体消失（侧栏不显示倒计时条）。

**展示侧**（都不参与计价，只影响界面）：

| 用途 | 函数 | 挂在哪 |
|---|---|---|
| 倒计时条（细进度 + 剩余时间） | `phaseAt()` | `/sidebar`、`/report` 的 `peak` 块 |
| 「峰谷表」一键预览接下来的切换点 | `upcomingSwitches()`（默认 6 个） | 同上，`peak.upcoming` |
| 跨档提醒（横幅 / 可选系统通知） | 客户端比 `peak.inPeak` + `localStorage` | 侧栏顶部，见 §四 `peakNotify` |

计价本身**不依赖**这些：档位在调用发起时由 `tierFor()` 定死并写进记录（见下面「入账即固化」），
界面怎么算倒计时都不会改动已入账的金额。

### 未定价 ≠ 0

`costOf()` / `priceCall()` 在缺单位价时返回 `null`（`basis: 'unpriced'`），而不是 `0`：
界面必须能把「没有价格」和「没花钱」分开显示（`¥0` 是最糟的默认值）。

```js
const resolved = resolveTier({ provider, model, atMs, snapshot, priceTable })
const call = priceCall({ buckets, tier: resolved.tier, rate: resolved.rate, credits: resolved.credits })
// call.cost === null → 显示 —；否则显示金额 + call.basis（如 'peak×local-peak'）
```

`resolveTier()` 即使算不出金额也会返回倍率、官方相位、credits 和切换点，供界面分开展示。

### credits 型站（wbfd 这类）

这类站 `/v1/usage` 是 404、只有 `/v1/models[].credits`（如 `"x0.11"`），没有余额也没有
「官方价」，所以只能给出**相对量**（`creditsWeight()` = 全部桶 × credits）；换算出货币需要
站点未公开的基准价，本模块不猜。`probeSub2Api()` 已把 `credits` 原样带出（`probe.models`）。

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

### 价目来源与「更新价格表」（0.4.0 新增）

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

**更新按钮**：侧栏底部 `价格表 · MM-DD ⟳ 更新` —— 点一下就让宿主去抓最新的站方价目：

```
抓取链（第一个成功即用）：
  1. LiteLLM raw 直链
  2. Sub2Api 的 price-mirror 分支 raw
  3. GitHub API：contents（取 sha）→ git/blobs（base64 正文，支持大文件）
  4. sub2api 仓库里的兜底副本（contents 内联 base64）
```

- 落盘到 `$DSH_HOME/storages/dsh-balance-monitor/prices.json`（与 `state.json` 分开：全量目录几百 KB）；
- **只影响之后的调用**（依据变更不重算历史，见上面的硬规定），按钮旁会显示本次收录的模型数；
- 抓取失败会如实显示每一条链路的原因；
- 随包快照（314 个模型、96.6 KB）保证**开箱即用**，重生成：`node research/import-station-prices.mjs`；
- 数据署名：LiteLLM `model_prices_and_context_window.json`（MIT），经 `Wei-Shaw/sub2api` 镜像分发。

### 硬规定：依据变更**不重算历史**，只影响后续调用

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

---

## 九、License

MIT。
