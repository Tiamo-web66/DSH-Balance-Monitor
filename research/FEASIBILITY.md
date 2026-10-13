# DSH 余额监控插件 —— 可行性调研与实测报告

调研时间：2026-10-12（UTC）
被测对象：DeepSeek 官方开放平台 + 6 家中转站（见 §3）
产物：本文 + `research/out/*.json`（原始证据）+ 三个可复跑脚本 + `relay-endpoint-map-newapi-oneapi.md`（上游源码级端点图）

---

## 0. 一句话结论

| 功能 | 只凭一把 key 能否实现 | 依据 |
|---|---|---|
| DeepSeek 余额 | **能**，且有两套独立链路 | §1.1 实测 200 |
| DeepSeek 累计消耗 | **能**（仅平台登录态链路，且 DSH 内置解析器会丢掉该字段） | §1.2 实测含 `total_costs` |
| DeepSeek 谷峰/低峰 | **能**，但是**纯本地计算**，官方无机读接口 | §1.3 |
| 模型价格 | DeepSeek：**无机读接口**，只能抓定价页 HTML；中转站：取决于网关，部分能 | §2、§3 |
| 中转站倍率 | **条件成立**：6 家里 1 家能直接读到倍率、1 家能读到额度消耗；**其余 4 家一把 key 什么都读不到** | §3 实测矩阵 |
| 中转站消耗额度 | 同上；且额外有「Δquota 自标定」法可在无控制台时测出实际计费倍率（方法已跑通） | §3.4 |

**最大的工程结论**：中转站没有统一实现，**不能写一个「通用中转站适配器」**。必须做成「探测 → 匹配适配器 → 声明式兜底」的三层结构，否则新接一家站就要改代码。

---

## 1. DeepSeek 官方侧（两条互不相通的凭据链路）

### 1.1 API Key 链路 —— 余额快照

```
GET https://api.deepseek.com/user/balance
Authorization: Bearer sk-...
```

实测 200：

```json
{"is_available":true,"balance_infos":[
  {"currency":"CNY","total_balance":"0.05","granted_balance":"0.00","topped_up_balance":"0.05"}]}
```

（同一会话内三次读取为 `0.11 → 0.05 → 0.03` —— 这是个**实时在扣费**的账号，插件必须按快照+时间戳展示，不要缓存成"固定余额"。该账号余额已接近归零，接插件前建议先充值，否则测试会被 `402` 打断。）

- 金额**全是字符串**，必须 `Number()` 后再判 `isFinite`，不能直接当数字用。
- 多币种账号会返回 CNY/USD **两条且顺序不稳定**，按余额/币种挑，别取 `[0]`。
- 错误形态（实测）：
  - 无效 key → `401` + JSON `{"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid ...","type":"authentication_error","code":"invalid_request_error"}}`
  - 缺 Authorization → `401` + **纯文本** `Authentication Fails (governor)`
  - **未知路径也返回 401（鉴权先于路由）** → 别指望靠路径探测发现隐藏接口
  - 余额不足走 `402`
- 这是官方**唯一**的账号/账单类接口。**没有** usage / 消耗历史 / 账单 / 配额接口（已核对 sitemap 全量端点）。
- `/models` 只给元数据（`deepseek-flash`、`deepseek-v4-pro`），**不含任何价格字段**。

> 现网模型已换代：`deepseek-chat` / `deepseek-reasoner` 于 2026-07-24 下线，现役 id 只有 `deepseek-flash`(V4.1-Flash) 与 `deepseek-v4-pro`(V4-Pro-0813)。旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用但路由到 Flash 计费。写死旧模型名的插件会直接失效。

### 1.2 平台登录态链路 —— 钱包 + 累计消耗（DSH 已有）

```
GET https://platform.deepseek.com/api/v0/users/get_user_summary
x-dsh-auth-token: <登录 grant>       // 不是 API key
```

实测 200：

```json
{"code":0,"data":{"biz_code":0,"biz_data":{
  "normal_wallets":[{"currency":"CNY","balance":"-0.0433720200000000","token_estimation":"0"}],
  "bonus_wallets":[{"currency":"CNY","balance":"0","token_estimation":"0"}],
  "total_costs":[{"currency":"CNY","amount":"206.0844743400000000"}]}}}
```

**关键发现**：`total_costs`（累计消耗金额，206.08 元）是**目前唯一能程序化拿到的「已花掉多少钱」**。而 DSH 内置解析器（`dsh-deepseek-account-platform` 的 `summary` schema）**只投影 `normal_wallets` / `bonus_wallets`，把 `total_costs` 丢掉了**。

- 同链路还有 `GET /auth-api/v0/users/current`（账号资料，含 `balance_alert.alert_bound` 余额告警阈值）与 `POST /api/v0/users/get_unnotified_bonuses`。
- 插件内可直接复用宿主服务：`ctx.deepseekAccount.getBalance(client)`（返回充值钱包+赠金钱包），无需自己存 token。
- 该 grant **无过期、无刷新流程**（上游明确列为已知限制），失效只能重新登录。

> ⚠️ 两条链路的数字**对不上**：同一时刻 API key 报 `total_balance=0.05` 且 `is_available=true`，平台钱包报 `normal_wallets.balance≈-0.0434`（欠费）。两者极可能是**不同账号**（key 无账号标识，无法直接比对）。插件若要同时展示这两个数字，必须显式提示"可能不是同一账号"，否则用户会以为插件算错了。

### 1.3 谷峰 / 低峰（错峰优惠）—— 只能本地算

官方定价页（中文页给人民币价）现行规则：

- **高峰**：北京时间**周一至周五 9:00–12:00、14:00–18:00**（等价 UTC 01:00–04:00、06:00–10:00），**不含中国法定节假日**
- **空闲（谷）**：其余全部时段，**含周末与中国法定节假日全天**
- **谷价 = 峰价 × 50%**，且**缓存命中输入 / 缓存未命中输入 / 输出三档全部适用**
- 现行方案 2026-08-16 16:00 UTC 生效；2026-09-10 04:00 UTC 调价（结构未变）

单模型现行价（CNY / 1M tokens，空闲→高峰）：

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.02 → 0.04 | 1 → 2 | 4 → 8 |
| `deepseek-v4-pro` | 0.15 → 0.30 | 4.5 → 9.0 | 13.5 → 27.0 |

**阻塞点**：官方**不发布机读的价格接口，也不发布节假日日历**。所以：
1. 价格必须抓 `api-docs.deepseek.com/quick_start/pricing`（Docusaurus 服务端预渲染，可直接解析 HTML；币种由中/英页决定）或内置价格表 + 人工同步；
2. 节假日必须**自带中国法定节假日表**（含调休），DSH 现有插件 `dsh-cost-meter` 的 `DEFAULT_PEAK_HOLIDAYS` 就是这种表，可直接参考实现思路。

---

## 2. 中转站侧：为什么不能做通用实现

上游源码级结论（详见 `relay-endpoint-map-newapi-oneapi.md`，基于 one-api v0.6.11 与 new-api v1.0.0-rc 实际源码）：

- 倍率（`group_ratio`）**只**来自公开的 `GET /api/pricing`（或 `GET /api/user/groups`）；`/api/ratio_config` 只给 per-model ratio 且默认返回 403（需服务端开 `ExposeRatioEnabled`）。
- `GET /dashboard/billing/subscription` + `/usage` 接受 **sk- key**，但 `*_limit_usd` 是**「已授予总额」而不是「剩余」**，剩余要自己算：
  `remaining ≈ hard_limit_usd − total_usage / 100`，且只在显示类型为货币时单位才对；new-api 默认作用域是**token 级**而非账号级。
- `GET /api/user/self` 在**原版** one-api/new-api 上**拒绝 sk- key**（只认 session/JWT 或 `nap_` 前缀的 PAT）。控制台里看到的余额是登录态才有的。
- 浏览器侧抓 `/api/status`、`/api/pricing` 会被 CORS 挡掉（这两个路由不下发 `Access-Control-Allow-Origin`）→ **插件必须宿主侧 fetch、客户端只做展示**。
- 限流：new-api `/api/*` 默认 360 req/180s，`ratio_config`/`usage/token` 更严（20/1200s），超限 **429 + 空 body**（new-api 带 `Retry-After`）。轮询间隔不能太激进。

---

## 3. 实测矩阵：6 家中转站，一把 sk- key 到底能读到什么

> **§3 已被 §3.5 修正，请连着读。** 本节只测了 New API 默认的那几条路径，结论「只有模型清单」是**错的**：
> 这些站把账单接口开在**模型面**的 `/v1/usage` 上，sk- key 能读到余额、消耗、逐模型倍率。
> 补测见 §3.5 与 `DESIGN-provider-types.md`。

探测脚本：`research/probe-relay-capabilities.mjs`（串行、只读、每目标 ≤6 请求）
原始证据：`research/out/relay-probe.json`

| 中转站 | `/v1/models` | `/api/status` `/api/pricing` `/api/ratio_config` | `/dashboard/billing/*` | `/api/user/self` | 结论 |
|---|---|---|---|---|---|
| nexus.itssx.com/api/grok45 (`jiuhaoche`) | 200 ✅ 28 模型 | 400 `Unsupported endpoint` | 200 **HTML** | **200 JSON** ✅ | **额度可读** |
| walkcoding.top (`walk-grok`) | 200 ✅ | 404 | 200 **HTML** | 404 | 只有模型清单 |
| st.walkcoding.top (`walk-gpt`) | 200 ✅ | 404 | 200 **HTML** | 404 | 只有模型清单 |
| nanshanyougui.xyz | 200 ✅ | 404 | 200 **HTML** | 404 | 只有模型清单 |
| tokencore.dev (`pojia-gpt`) | 403 `GROUP_DELETED` | 404 | 200 **HTML** | 404 | key 分组已删 |
| 114.66.62.99:7863 (`wbfd`) | 200 ✅ **带倍率** | 404 | 404 | 404 | **倍率可读**，无余额 |

### 3.1 必须写进代码的陷阱：SPA 假 200

`/dashboard/billing/subscription` 在 5 家站上返回 **HTTP 200 + `<index.html>`**（前端 SPA 对未知路径的回落），**不是账单接口**。第一版脚本就把它当成了「成功」。

> 判据：`content-type` 含 `text/html` 或 body 以 `<!doctype`/`<html` 开头 → 直接判失败，绝不能 `JSON.parse` 成功就当真。

### 3.2 唯一能读到账号额度的一家：`jiuhaoche`

```
GET https://nexus.itssx.com/api/grok45/api/user/self     (Authorization: Bearer sk-...)
→ 200 {"data":{"group":"default","id":0,"quota":7014265,"request_count":37119,
                "status":1,"used_quota":2815403585,"username":"..."},"success":true}
无 key → 403 {"error":{"message":"Missing API Key","type":"invalid_request_error"}}
```

- 返回结构与 one-api 控制台口吻一致，但这家**允许 sk- key 直接读**（属于定制/魔改，非上游默认行为）。
- `quota`=剩余额度、`used_quota`=已消耗、`request_count`=调用次数、`group`=分组名。
- 按 one-api/new-api 默认口径 `1 USD = 500000 quota` 换算：剩余 ≈ $14.03，已用 ≈ $5630.81。
  **该站实际 `quota_per_unit` 未经核实**（`/api/status` 被禁用，拿不到官方换算常量），这两个美元数只能算"按默认口径的推断值"。
- `group` 只给名字（`default`），**分组倍率拿不到** —— 该站的 `/api/status`、`/api/pricing` 一律 `400 Unsupported endpoint`，说明它是裁剪过的网关，公开配置面被关掉了。

### 3.3 唯一能读到倍率的一家：`wbfd`（倍率直接写在模型清单里）

`GET /v1/models`（需 key）返回的每个模型对象带 **`credits`** 与人类可读的 `description`：

```json
{"id":"cn:glm-5.2","credits":"x0.79","description":"[x0.79 credit] 1M 上下文，擅长长程任务", ...}
{"id":"cn:deepseek-v4-flash","credits":"x0.17"}
```

即：这家站的「倍率」根本不在 `group_ratio` 里，而是**按模型挂在 `/v1/models`**上。用同一套 New API 适配器去读它必然读不到。

### 3.4 无控制台时怎么测倍率：Δquota 自标定法（**已跑通**）

不需要 `/api/status`、不需要控制台、不需要上游价格表也能开工：

```
实际扣费 = tokens × 上游单价 × 倍率    （new-api 还叠 model_ratio / completion_ratio / cache_ratio）
quota 是整数计量                     （默认 1 USD = 500000 quota）
⇒ 只要能读到 used_quota，就能用「调一次、量两次」把实际计费测出来
```

实测（`research/measure-relay-quota-delta.mjs`，jiuhaoche / `claude-haiku-4-5`）：

```
调用前: quota=7014265  used_quota=2815403585  request_count=37119
调用后: quota=…        used_quota=2815405932  request_count=37120   → Δ=2347 quota
本次用量: prompt_tokens=2458(cached 2432) completion_tokens=400(reasoning 101)
⇒ Δ = 0.004694 USD (@500000 quota/USD)
```

**但同一轮实验暴露了三个更要命的事实**（这直接决定插件架构）：

1. **中转站的 `usage` 不可信。** 我发一条内容为 `hi` 的消息，`prompt_tokens` 报 **2440**，其中 `cached_tokens=2432` —— 网关自己塞了约 2400 token 的固定前缀，且永远算命中缓存。
2. **模型会被静默替换。** 请求 `model: claude-haiku-4-5`，响应 `model: grok-4.5`。按请求的模型名去算价，一定算错。
3. **参数会被忽略。** 请求 `max_tokens: 8`，实际返回 29；`max_tokens: 300`，实际返回 400。

⇒ **架构结论：中转站的「消耗额度」必须以账号级 `used_quota`/余额差值为准（轮询），不能靠本地累计 token 估算。** 本地估算只能用于 DeepSeek 官方侧。

绝对倍率要不要现在算出来？不建议。它需要「上游真实价格表」作为分母，而上面第 2 点说明上游价格表未必对得上号。工程上更稳的做法是**自标定**：发几笔 token 构成差异明显的调用，对 `Δquota = a·miss_in + b·cached_in + c·out` 解线性方程，得到「每 token 的 quota 单价」，再与价格目录比对得出倍率——不依赖任何站点公开配置。

---

### 3.5 补测（重要修正）：账单接口在 `/v1/usage`，不在控制台

`GET {base}/v1/usage` + `Authorization: Bearer sk-...`，实测结果：

| 站 | HTTP | 关键字段 | 有效倍率 `actual_cost/cost` |
|---|---|---|---|
| walkcoding.top | 200 | `balance=29.92280799` `unit=USD` `planName=钱包余额` `mode=unrestricted` `usage.total` `daily_usage[]` `model_stats[]` | **0.09** |
| st.walkcoding.top | 200 | 同上，`balance` 与上一行**完全相同**（同账户） | **0.12** |
| nanshanyougui.xyz | 200 | 同上（与上两家同款网关软件） | **0.10** |
| jiuhaoche | 200 | `mode=quota_limited` `quota.limit=5644.8357` `quota.used=5630.813665` `quota.remaining=14.022035` `expires_at=2027-02-10` | **1.28**（加价） |
| wbfd | 404 | — | 倍率只在 `/v1/models` 的 `credits` 里（`x0.79`） |
| pojia-gpt | 403 | `GROUP_DELETED` | key 已失效 |

要点：

- **倍率不用反推**：sub2api 另有 `GET /v1/sub2api/billing`（同样是 sk- key）直接返回 `effective_rate_multiplier`，并给出 `group_rate_multiplier` / `resolved_rate_multiplier` / `user_rate_multiplier` / `peak_*` / `applied_peak_multiplier` / `timezone` 的完整分解。实测 walkcoding 0.09、st.walkcoding 0.12、nanshanyougui 0.10，与下表反推值一致。详见 `DESIGN-provider-types.md` §8.2。
- `cost` = 站方按上游官方价算的原价，`actual_cost` = 真实扣费。**站方自己把两个数都给了**，所以「消耗金额」直接读 `actual_cost` 即可，不需要「官方价 × 倍率」自己算。
- 控制台的真·分组倍率接口 `/api/v1/groups/rates` 用 sk- key 读是 `401 INVALID_TOKEN`，**要登录态**（但已不必用）。
- 该站 1 USD = 500000 quota **已证实**（`quota.remaining×500000` 与 `/api/user/self` 的 `quota` 对得上，差值正是两次读取之间的测试调用扣费）。
- 逐日比值可反推该站自己的峰谷时段（分组配置里有 `peak_rate_enabled/peak_start/peak_end/peak_rate_multiplier`）。

完整分析：`DESIGN-provider-types.md`。脚本：`research/probe-relay-usage-endpoint.mjs`、`research/probe-console-contract.mjs`。

---

## 4. 插件工程约束（DSH 侧，已核实）

- 插件形态：`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`，插入一行 host 行；`exports` 分出 host 入口 / `./client`（web UI）/ `./typert`（RPC 绑定）。SDK 包在宿主 asar 内提供（`dsh-credentials`、`dsh-home-paths` 走 peerDependencies）。
- `dshhub.permissions.network` 是**白名单**：所有要访问的域名必须显式列出，**包括中转站域名**。这是"必须先确定目标站"的硬约束。
- **CORS 决定分层**：`/api/status`、`/api/pricing` 不下发 ACAO → 浏览器侧 fetch 必然失败 → **所有出网请求放宿主侧，客户端只收状态**。
- 凭证：一律走 `dsh-credentials`（`{{VAR_NAME}}` 引用 + `credentialRef`），与模型配置共用同一把 key，不要另存明文。
- 隐私边界：未启用的 provider 不应产生任何出站请求（现有 `dsh-cost-meter` 就是这么约定的）。
- 参考实现：`dsh-cost-meter` 已实现「官方余额 + 峰谷显示 + 价格抓取 + 自定义余额端点（含 NewApi 模板，`divide: 500000`）」。**它的空缺正是本插件的机会**：自定义余额要用户手填 URL 和 extract 规则，没有内置的中转站探测、没有倍率测量、没有把「剩余 + 已耗 + 倍率」合成一条视图。

---

## 5. 待确认 / 未做（不粉饰）

1. **`api.zxcbug.com` 无法实测：环境里没有它的 key。** 本次全程未对该站点发过任何请求（工作区约定禁令）。
   已获用户授权做「只读余额/额度查询」，但 `~/.dsh/.credentials.yaml` 的 `refs` 段只有 6 把 key，全部属于其它站点；DSH 各 profile 的 provider 配置里也没有 zxcbug 条目。**需要提供该站的 key（或指明它对应哪个 provider）才能补测**。补测方案已就绪：直接复用 `research/probe-relay-capabilities.mjs`，只跑余额/额度类路径，不做路径枚举。
   该站**未经验证**，因此插件里它的适配器只能先按通用探测逻辑写，不能承诺可用。
2. **两条 DeepSeek 链路的数字归属未确认**（§1.2 末），需确认平台登录账号与 API key 是否同一账号。
3. **`quota_per_unit` 未核实**：jiuhaoche 的美元换算用了默认 500000，未经站点侧证实。
4. **上游价格表来源未定**：DeepSeek 官方靠抓页；中转站模型（`grok-4.5`、`claude-haiku-4-5` 等）的"上游真实价"没有可靠公开机读源，倍率绝对值的可信度受此限制。
5. **one-api 只核到 v0.6.11**，new-api 核到 v1.0.0-rc.43；更老的 tag 未逐个读源码。

---

## 6. 复跑方式

```bash
NODE="C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"

$NODE research/probe-deepseek-official.mjs        # → research/out/deepseek-official.json
$NODE research/probe-relay-capabilities.mjs       # → research/out/relay-probe.json
$NODE research/measure-relay-quota-delta.mjs      # → 控制台输出（含 1 次极小额真实调用）
```

三个脚本都从 `~/.dsh/.credentials.yaml` 读 key，**只输出 key 前 6 位**，不落盘任何密钥；产物 JSON 里的账号标识字段会被抹掉。

> `research/out/` 已写进 `.gitignore`：里面虽有额度数值和账号 ID，属于运行态数据，不入版本库；需要时本地重跑脚本即可重建。
