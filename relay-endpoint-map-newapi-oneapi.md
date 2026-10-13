# new-api / one-api — client-side endpoint map for an `sk-`-only balance plugin

All claims below were read from upstream source (not from blog posts). Local clones used for line numbers:

| repo | git remote | HEAD checked | release tags checked |
|---|---|---|---|
| one-api | `https://github.com/songquanpeng/one-api.git` | `main` @ `8df4a2670b98266bd287c698243fff327d9748cf` (2025-02-21) = **v0.6.11 line** (latest tags `v0.6.11-preview.7`) | v0.6.11 |
| new-api | `https://github.com/Calcium-Ion/new-api.git` (GitHub redirects to **QuantumNous/new-api**; `go.mod` module = `github.com/QuantumNous/new-api`) | `main` @ `dd59854050f26f4f67bb3dac5274af5e17013462` (2026-10-12) = **v1.0.0-rc line** | v0.8.1, v0.9.28, v0.13.2, v1.0.0-rc.43 |

Clones: `C:\Users\Public\relay-research\one-api`, `C:\Users\Public\relay-research\new-api`.
Doc caveat: one-api's own `docs/API.md` documents only `GET /api/user/self` and `POST /api/topup` and says "当前 API 列表不全，请自行通过浏览器抓取前端请求". The `/dashboard/billing/*` endpoints are **undocumented upstream** (they exist for OpenAI-client compatibility).

---

## 1. Endpoints that accept `Authorization: Bearer sk-...`

### Method / middleware / handler

**new-api (v1.0.0-rc.43 == `main`, and identical for v0.13.2 unless noted)**

| path | method | auth middleware | handler (file:line) |
|---|---|---|---|
| `/dashboard/billing/subscription` | GET | **TokenAuth (sk- OK)** | `controller.GetSubscription` — `router/dashboard.go:15` |
| `/v1/dashboard/billing/subscription` | GET | TokenAuth | same (`router/dashboard.go:16`) |
| `/dashboard/billing/usage` | GET | TokenAuth | `controller.GetUsage` — `router/dashboard.go:17` |
| `/v1/dashboard/billing/usage` | GET | TokenAuth | same (`router/dashboard.go:18`) |
| `/v1/models`, `/v1/models/:model` | GET | TokenAuth | `controller.ListModels` / `RetrieveModel` — `router/relay-router.go:21-41` |
| `/api/usage/token/` (**trailing slash registered**) | GET | **TokenAuthReadOnly (sk- OK)** — v0.13.2+; strict `TokenAuth` in v0.9.28; **does not exist in v0.8.1** | `controller.GetTokenUsage` — `router/api-router.go:298-304` |
| `/api/log/token` | GET | TokenAuthReadOnly — v0.13.2+; in v0.8.1/v0.9.28 the route exists **without any auth middleware** but is useless unauthenticated (needs `token_id` in ctx) | `controller.GetLogByKey` — `router/api-router.go:357` |

Also sk--authenticated (no balance data): `/v1/chat/completions` etc. (`router/relay-router.go:74+`), `/v1beta/models`, `/v1/messages`, task/video/plugin routers (`task-router.go:16`, `video-router.go:13`, `plugin-router.go:119`).

**one-api v0.6.11 (identical paths to new-api for billing)**

| path | method | auth | handler |
|---|---|---|---|
| `/dashboard/billing/subscription` | GET | **TokenAuth (sk- OK)** | `router/dashboard.go:17` → `controller.GetSubscription` |
| `/v1/dashboard/billing/subscription` | GET | TokenAuth | `router/dashboard.go:18` |
| `/dashboard/billing/usage` | GET | TokenAuth | `router/dashboard.go:19` → `controller.GetUsage` |
| `/v1/dashboard/billing/usage` | GET | TokenAuth | `router/dashboard.go:20` |
| `/v1/models`, `/v1/models/:model` | GET | TokenAuth | `router/relay.go:14-18` |

one-api has **no** `/api/usage/token`, **no** `/api/log/token`, **no** `/api/pricing`, **no** `/api/ratio_config`, **no** `/api/uptime/status`.

### Response schemas

`GET /dashboard/billing/subscription` (both projects, same struct; one-api `controller/channel-billing.go:24`, new-api `controller/billing.go`):

```json
{
  "object": "billing_subscription",
  "has_payment_method": true,
  "soft_limit_usd": 12.34,
  "hard_limit_usd": 12.34,
  "system_hard_limit_usd": 12.34,
  "access_until": 0
}
```
Semantics (read the code, this is the part plugins get wrong):
- `*_limit_usd` = **`remainQuota + usedQuota`** (i.e. total granted quota), *not* the remaining balance. one-api `controller/billing.go:50-59`; new-api `controller/billing.go:46-60`.
- Scope = **the token** when `DisplayTokenStatEnabled == true` (default **true** in both: one-api `common/config/config.go:23`, new-api `common/constants.go:25`), otherwise the user.
- Units: new-api (v0.9.28+) applies the site display type: USD → `quota / QuotaPerUnit`; CNY → `quota / QuotaPerUnit * USDExchangeRate`; TOKENS → raw token count (`controller/billing.go:47-58`). one-api only has a bool: `if config.DisplayInCurrencyEnabled { amount /= config.QuotaPerUnit }` (`controller/billing.go:39-41`).
- `access_until` = token expiry (unix seconds, `0` if none). Unlimited-quota token → `100000000` (one-api `controller/billing.go:55-57`).

`GET /dashboard/billing/usage`:

```json
{ "object": "list", "total_usage": 1234.56 }
```
- Struct: `relay/model/channel-billing.go:48` (one-api), where the comment says `unit: 0.01 dollar`.
- Value = `used_quota` converted by the same display rule, then **× 100** (one-api `controller/billing.go:80-87`; new-api `controller/billing.go:73-105`).
- ⇒ remaining balance in display units ≈ `hard_limit_usd − total_usage / 100`. This only holds when the display type is a *currency*; with TOKENS display (new-api) or `DisplayInCurrencyEnabled=false` (one-api) the two endpoints use **inconsistent units** (new-api: subscription = raw tokens, usage = tokens×100; one-api: subscription = raw quota when the flag is off — plus `usedQuota` is left at 0 in the user-scope branch because of `controller/billing.go:44-49`, a known upstream quirk).

`GET /api/usage/token/` (new-api only, `controller/token.go:229-285`):

```json
{ "code": true, "message": "ok",
  "data": { "object": "token_usage", "name": "…",
            "total_granted": 1000000, "total_used": 250000, "total_available": 750000,
            "unlimited_quota": false, "model_limits": {...}, "model_limits_enabled": false,
            "expires_at": 0 } }
```
- Raw **quota integers** here (not divided by `QuotaPerUnit`). `expires_at == -1` is normalised to `0`.
- Gotchas: the handler re-parses `Authorization` itself and requires exactly `Bearer <key>` (one space, `controller/token.go:239-248`), and strips only the `sk-` prefix **without** splitting on `-` — so an admin-style `sk-<key>-<channelid>` key returns "获取令牌信息失败".
- **Registered path is `/api/usage/token/` with a trailing slash**; `GET /api/usage/token` gets a gin 301 (`gin.New()` keeps `RedirectTrailingSlash=true`).

`GET /api/log/token` (new-api, `controller/log.go:74-92`): `{"success":true,"message":"","data":[<recent log rows for this token>]}`.

### Paths that REJECT an `sk-` key

Both projects' dashboard middleware only accepts (a) the session cookie/JWT, or (b) a *dashboard access token* — one-api: the UUID in `users.access_token` (`middleware/auth.go:authHelper` → `model.ValidateAccessToken`, which strips `Bearer ` and compares the raw string, `model/user.go`); new-api: only `nap_`-prefixed PATs (`model/user_access_token.go:17 AccessTokenPrefix = "nap_"`) plus legacy `access_token` which is being retired (`middleware/auth.go:lookupAccessToken` / `ErrLegacyAccessTokenRetired`). An `sk-…` relay key is neither ⇒ hard reject:

| path | method | one-api | new-api | why |
|---|---|---|---|---|
| `/api/user/self` | GET | UserAuth (session/access-token) — **rejects sk-** | UserAuth — **rejects sk-** | `router/api.go:44` / `router/api-router.go:100` |
| `/api/user/token` | GET | UserAuth, returns a **new** `access_token` UUID (`controller/user.go:285`) | **removed in v1.0.0-rc/main**; present ≤ v0.13.2 (`api-router.go: selfRoute.GET("/token", controller.GenerateAccessToken)`) | replaces browser-session auth, not usable with sk- |
| `/api/user/dashboard` | GET | UserAuth — **rejects sk-**; returns 7-day per-day/per-model stats `{day, model_name, request_count, quota, prompt_tokens, completion_tokens}` (`controller/user.go:262`, `model/log.go:SearchLogsByDayAndModel`) | **does not exist** in any checked version (v0.8.1/v0.9.28/v0.13.2/v1.0.0-rc.43) | — |
| `/api/models` | GET | UserAuth (`router/api.go:18`) | UserAuth (`router/api-router.go:30`) | returns `{success,data:{<channelType>:[model,…]}}` — model names only, **no ratios** |
| `/api/user/available_models` | GET | UserAuth (`router/api.go:50`) | — (has `/api/user/models`, UserAuth, `api-router.go:101`) | — |
| `/api/channel/models` | GET | AdminAuth (`router/api.go:76`) | AdminAuth + `authz.ChannelRead` (`router/channel-router.go:60`) | — |
| `/api/group` | GET | **AdminAuth** (`router/api.go:115-119`) | **AdminAuth** (`router/api-router.go:361-363`) | returns group-name list, no ratios |
| `/api/token/*`, `/api/log/self*`, `/api/data/self`, `/api/user/access_tokens*` | GET | UserAuth | UserAuth | — |

No endpoint in either project returns the **user-account** remaining balance to an `sk-` key. With the default `DisplayTokenStatEnabled=true` everything sk--reachable is **token-scoped**.

---

## 2. Unauthenticated / publicly readable endpoints

**new-api (`router/api-router.go`, v1.0.0-rc.43 == main):**

| path | method | notes |
|---|---|---|
| `/api/status` | GET | line 28. Public. Also `/api/setup` (28-29 area) |
| `/api/uptime/status` | GET | line 29. Public (v0.9.28+; absent in v0.8.1). Returns `{success,message,data:[{categoryName, monitors:[{name, uptime, status, group?}]}]}` (`controller/uptime_kuma.go:25-33,131`); `data: []` unless the operator configured Uptime-Kuma groups |
| `/api/pricing` | GET | line 38. **Public by default**; in v1.0.0-rc it is wrapped in `HeaderNavModuleAuth("pricing")` (`middleware/header_nav.go`), which falls back to `Enabled=true, RequireAuth=false` when the `HeaderNavModules` option is empty (no default is seeded anywhere) ⇒ anonymous is served, but an operator can set `requireAuth:true` and then it is `UserAuth` (401 for sk-) |
| `/api/ratio_config` | GET | line 62. Public route **but returns 403 unless option `ExposeRatioEnabled` is on** (`controller/ratio_config.go`, `setting/ratio_setting/expose_ratio.go` — default `false`) |
| `/api/user/groups` | GET | line 91. **Public** (no middleware). Returns `{success,data:{<group>:{ratio,desc}}}` for publicly usable groups (`controller/group.go:26-52`) — with no user context `ratio` = the site-wide `group_ratio` (`service/group.go:128-134`). Undocumented, present in every version checked |
| `/api/notice`, `/api/about`, `/api/home_page_content`, `/api/user-agreement`, `/api/privacy-policy` | GET | public |
| `/api/perf-metrics`, `/api/perf-metrics/summary`, `/api/rankings` | GET | gated by the same `HeaderNavModules` mechanism |

**one-api (`router/api.go`):** `/api/status` (line 17, public), `/api/notice`, `/api/about`, `/api/home_page_content`, `GET /api/verification`, `GET /api/reset_password`, `POST /api/user/reset`, `POST /api/user/register`, `POST /api/user/login`, `GET /api/user/logout`, `/api/oauth/*`. There is **no** public pricing/ratio/uptime endpoint at all, and **no** `/api/user/groups`.

### Response payloads that carry pricing data

`GET /api/status` — one-api (`controller/misc.go:18-44`), data fields include:
`version, start_time, email_verification, github_oauth, github_client_id, lark_client_id, system_name, logo, footer_html, wechat_qrcode, wechat_login, server_address, turnstile_check, turnstile_site_key, top_up_link, chat_link, quota_per_unit, display_in_currency, oidc*`.
Format: `{"success":true,"message":"","data":{…}}`.

`GET /api/status` — new-api (`controller/misc.go:41-196`), same envelope, data adds: `quota_per_unit`, `display_in_currency`, **`quota_display_type`** (`USD|CNY|TOKENS|CUSTOM`), `custom_currency_symbol`, `custom_currency_exchange_rate`, **`usd_exchange_rate`**, `price`, `stripe_unit_price`, `HeaderNavModules`, `SidebarModulesAdmin`, `docs_link`, `setup`, plus oauth/passkey/legal/console flags.

`GET /api/pricing` — new-api only:

```json
{ "success": true,
  "data": [ { "model_name": "gpt-4o", "description": "", "icon": "", "tags": "",
              "vendor_id": 0,
              "quota_type": 0,                // 0 = ratio billing, 1 = fixed price
              "model_ratio": 1.25,
              "model_price": 0,               // USD per request when quota_type==1
              "owner_by": "openai",
              "completion_ratio": 4,
              "cache_ratio": 0.5,             // optional *
              "create_cache_ratio": 1.25,     // optional * (v0.13.2+)
              "image_ratio": 2, "audio_ratio": 1, "audio_completion_ratio": 1,   // optional
              "enable_groups": ["default","vip"],
              "supported_endpoint_types": ["openai","anthropic"],
              "billing_mode": "tiered_expr", "billing_expr": "…",   // v1.0.0-rc only, optional
              "pricing_version": "a42d372c…" } ],
  "vendors": [ { "id": 1, "name": "OpenAI", "description": "", "icon": "" } ],
  "group_ratio": { "default": 1, "vip": 0.9 },     // <-- the 倍率 multiplier
  "usable_group": { "default": "默认分组", "vip": "…" },
  "supported_endpoint": { "…": {"path":"…","method":"…"} },
  "auto_groups": ["…"],
  "pricing_version": "a42d372ccf0b5dd13ecf71203521f9d2" }
```
Source: `controller/pricing.go:38-78` (v1.0.0-rc/main), struct `model/pricing.go:27-47`, `quota_type` assignment `model/pricing.go:347-355`, `group_ratio` from `ratio_setting.GetGroupRatioCopy()` (`setting/ratio_setting/group_ratio.go:62`). v0.8.1 shipped a smaller version of the same shape (`{success,data,group_ratio,usable_group}`) with `middleware.TryUserAuth()` (`controller/pricing.go:9-40`).

`GET /api/ratio_config` — new-api only, **no `group_ratio` in any version I checked**:

```json
{ "success": true, "message": "",
  "data": { "model_ratio": {"gpt-4o": 1.25, "…": 0},
            "completion_ratio": {"gpt-4o": 4},
            "cache_ratio": {"…": 0.5},
            "create_cache_ratio": {"…": 1.25},     // v0.13.2+
            "model_price": {"mj_imagine": 0.1},
            "billing_mode": {"…": "tiered_expr"},  // v1.0.0-rc+ (setting/billing_setting/tiered_billing.go:174)
            "billing_expr": {"…": "…"} } }
```
Source: `setting/ratio_setting/exposed_cache.go:34-58` verified at tags **v0.9.28 / v0.13.2 / v1.0.0-rc.43**; wrapper `controller/ratio_config.go`. 403 body: `{"success":false,"message":"The ratio config API is not enabled"}` (v1.0.0-rc) / `"倍率配置接口未启用"` (≤v0.13.2).

**Answer to "`group_ratio` from `/api/pricing` vs `/api/ratio_config`"**: in every version checked, `group_ratio` **only** comes from `GET /api/pricing` (anon-usable) or `GET /api/user/groups` (per-group `ratio`, anon-usable where the group is public). `/api/ratio_config` only carries per-model `model_ratio / completion_ratio / cache_ratio / create_cache_ratio / model_price`, and is 403 by default anyway. So the plugin must use `/api/pricing` for 倍率.

`GET /api/channel/models` — **not** public anywhere (AdminAuth / `authz.ChannelRead`).

---

## 3. Quota integer → currency

- `QuotaPerUnit = 500 * 1000.0` in both: one-api `common/config/config.go:21`, new-api `common/constants.go:22` (comment: `$0.002 / 1K tokens`). Default: **USD**, so **500000 quota = $1**, 1 quota = $0.000002.
- Defaults: `DisplayInCurrencyEnabled = true` (one-api `common/config/config.go:22`, new-api `common/constants.go:24`), `DisplayTokenStatEnabled = true` (one-api `:23`, new-api `:25`).
- new-api display type (`setting/operation_setting/general_setting.go:7-10,30`): `USD` (default) / `CNY` / `TOKENS` / `CUSTOM`; `USDExchangeRate` default `7.3` (`setting/operation_setting/payment_setting_old.go:18`). one-api has no CNY/exchange-rate concept, only the boolean.
- 1 ratio unit = $0.002 per 1K tokens = 1000 quota per 1K tokens = 1 quota per token at ratio 1.

**one-api charge** (`relay/controller/text.go:43-45`, `relay/controller/helper.go:97-115`, ratios from `relay/billing/ratio/model.go:686,725`, `relay/billing/ratio/group.go:31`):

```
ratio = model_ratio(model) * group_ratio(group)
quota = ceil( (prompt_tokens + completion_tokens * completion_ratio) * ratio )
```
No fixed-price (`model_price`) and no cache ratio in one-api v0.6.11. Images/audio: `quota = ratio * <size/seconds formula>` with the same `ratio = model_ratio * group_ratio` (`relay/controller/image.go:171-173`, `audio.go:57-59`). Pre-consume: `(PreConsumedQuota + prompt + max_tokens) * ratio`.

**new-api charge** (`service/text_quota.go:220-300`, `service/quota.go:46-88,107-113`, `relay/helper/price.go:85-164`):

```
ratio        = model_ratio * group_ratio            # group ratio = token.group, else user.group; "auto" resolved; group_group_ratio[user_group][group] overrides
per-token    = (prompt_text − cached + cached*cache_ratio + cache_creation*cache_creation_ratio
                + completion_text*completion_ratio
                + audio_in*audio_ratio + audio_out*audio_ratio*audio_completion_ratio
                + image_ratio terms) * ratio
fixed price  = model_price * QuotaPerUnit * group_ratio        # when quota_type == 1
```
`quota_type` 1 = fixed price (`model_price`, USD/request), 0 = ratio billing (`model/pricing.go:347-355`). Tiered/expression billing (`billing_mode=billing_expr|tiered_expr`, `billing_expr`) exists only in the v1.0.0-rc line and can make per-request cost non-linear.

Group-ratio precedence: `ratio_setting.GetGroupGroupRatio(userGroup, usingGroup)` (per-user special ratio) → else global `GetGroupRatio(usingGroup)`; unusable/deprecated groups are rejected at auth time (`middleware/auth.go:TokenAuth`, `setting/ratio_setting/group_ratio.go:75-100`).

---

## 4. Version differences & routing/prefix

**Route prefix / ports**
- Both serve **everything on one listener** — `<host>:${PORT:-3000}` (one-api `main.go:115-120`, new-api `main.go:209-215`): console SPA at `/`, management API at `/api/...`, relay at `/v1/...` (+ `/v1beta/...`, `/pg/...` in new-api), OpenAI billing at `/dashboard/...` **and** `/v1/dashboard/...`.
- Neither implements a configurable path prefix. Sub-path deployments are done in a reverse proxy, and both honour `FRONTEND_BASE_URL` only to 301-redirect non-API traffic on slave nodes (one-api `router/main.go:14-27`, new-api `router/main.go:24-42`). A plugin must therefore (a) accept a user-supplied base URL, (b) follow 301s, and (c) keep the trailing slash on `/api/usage/token/` (gin `RedirectTrailingSlash=true`).
- Console and relay are **not** on different ports; only split deployments use different `PORT`/proxy rules.

**one-api vs new-api**
- one-api v0.6.11 lacks: `/api/pricing`, `/api/ratio_config`, `/api/uptime/status`, `/api/usage/token`, `/api/log/token`, `/api/user/access_tokens`, `/api/user/groups`, `quota_display_type`/`usd_exchange_rate` in `/api/status`.
- one-api has `/api/user/dashboard`, `/api/user/token`, `/api/user/available_models`, `/api/models`, `/api/group` — new-api keeps `/api/models` and `/api/group` but has **no `/api/user/dashboard`**.

**new-api version matrix (verified in source at each tag)**

| feature | v0.8.1 | v0.9.28 | v0.13.2 | v1.0.0-rc.43 / main |
|---|---|---|---|---|
| `/api/pricing` anon access | `TryUserAuth()` ✔ | `TryUserAuth()` ✔ | `TryUserAuth()` ✔ | `HeaderNavModuleAuth("pricing")` ✔ by default (operator can require auth) |
| `/api/uptime/status` | ✗ | ✓ | ✓ | ✓ |
| `/api/ratio_config` | ✗ | ✓ (403 unless `ExposeRatioEnabled`) | ✓ | ✓, payload adds `billing_mode`/`billing_expr` |
| `/api/user/token` (`GenerateAccessToken`) | ✓ | ✓ | ✓ | **removed** (→ `/api/user/access_tokens`, PAT prefix `nap_`) |
| `/api/usage/token/` | ✗ | ✓ with strict `TokenAuth` (expired/exhausted key → 401) | ✓ with `TokenAuthReadOnly` | ✓ `TokenAuthReadOnly` |
| `/api/log/token` | route exists, no auth middleware (returns error w/o token ctx) | same | `TokenAuthReadOnly` | `TokenAuthReadOnly` |
| `/dashboard/billing/*` CNY/TOKENS-aware amounts | — | ✓ | ✓ | ✓ |

---

## 5. Rate-limit and auth-failure behaviour to expect

**Rate limits (per client IP)**
- one-api (`middleware/rate-limit.go`, `common/config/config.go:128-145`): `/api/*` and `/dashboard/*` use `GlobalAPIRateLimit` = **480 req / 180 s** (`GLOBAL_API_RATE_LIMIT` env; `0` or `DEBUG=true` disables); critical routes (`/api/verification`, `/api/reset_password`, `/api/user/reset`, `/api/oauth/*`) = **20 / 1200 s`. Rejection = **HTTP 429 with an empty body** (`c.Status(429)`), no `Retry-After`.
- new-api (`middleware/rate-limit.go`, `common/init.go:126-140`): `/api/*` = `GlobalAPIRateLimit` **360 / 180 s** (`GLOBAL_API_RATE_LIMIT`, `GLOBAL_API_RATE_LIMIT_DURATION`, `GLOBAL_API_RATE_LIMIT_ENABLE=true`); web = 120/180 s; `/api/ratio_config`, `/api/usage/token/`, `/api/log/token` also carry `CriticalRateLimit` **20 / 1200 s**. Rejection = **HTTP 429 + `Retry-After: <seconds>`**, empty body (`writeRateLimited`). Redis or in-process counters (`rateLimit:v2:ip:<mark>:<ip>`), fixed window.

**Auth failures**
- one-api `TokenAuth` invalid/unknown `sk-` → **401** `{"error":{"message":"…","type":"one_api_error"}}` (`middleware/utils.go:abortWithMessage`). Banned user → **403**; token IP allowlist violation → **403** with `该令牌只能在指定网段使用…`; model not in the token's allow-list → **403**.
- one-api session/dashboard endpoints: **no** `Authorization` at all → 401 `{"success":false,"message":"无权进行此操作，未登录且未提供 access token"}`; wrong value → **HTTP 200** with `{"success":false,"message":"无权进行此操作，access token 无效"}` (plugins must check `success`, not the status code); banned → 200 + `用户已被封禁`; insufficient role → 200 + `权限不足`.
- new-api `TokenAuth` failures → **401** OpenAI-style `{"error":{"message":…}}`; `TokenAuthReadOnly` → **401** `{"success":false,"message":…}` with a stable `code` for dashboard-route failures (`AUTH_UNAUTHORIZED`, `AUTH_SESSION_REQUIRED`, `ACCESS_TOKEN_SCOPE_DENIED`, …) plus an `Auth-Version` response header on success (`middleware/auth.go`). Legacy access tokens are retired in the v1.0.0-rc line → `ACCESS_TOKEN_LEGACY_RETIRED`.
- Admin channel pinning: `sk-<key>-<channelid>`; the middleware splits on `-` and takes `parts[0]` as the key (`one-api middleware/auth.go:TokenAuth`, `new-api middleware/auth.go:SetupContextForToken`) — a token key containing `-` is silently truncated, and non-admins using the 2-part form get **403**.

**CORS (matters if the plugin runs in a browser)**
- one-api: `middleware.CORS()` (`AllowAllOrigins`-style) is applied **only** to `/dashboard/*` (`router/dashboard.go:12`) and `/v1/*` (`router/relay.go:11`). `/api/*` has **no** `Access-Control-Allow-Origin`.
- new-api: CORS on `/v1/*` (`relay-router.go:16`), `/dashboard/*` (`router/dashboard.go:15`), and only `/api/usage/*` + `/api/log/*` (`api-router.go:299,355`). `/api/status`, `/api/pricing`, `/api/ratio_config` send **no ACAO header** (no global CORS in `main.go`).
- ⇒ a browser page/extension from another origin cannot `fetch()` them; proxy through your own backend or run same-origin.

---

## 6. Practical recipe for the plugin, and honest uncertainties

Suggested probe order with only `sk-`:
1. `GET /api/status` (no auth) → `quota_per_unit`, `display_in_currency`, `quota_display_type`, `usd_exchange_rate`, `server_address`, `version`. Fails ⇒ maybe one-api (fewer fields) or a non-relay; use `/` + `/api/status` to fingerprint (`version` string).
2. `GET /api/pricing` (no auth) → per-model `model_ratio`/`model_price`/`quota_type`/`completion_ratio`/`cache_ratio` **and `group_ratio`** (倍率) + `usable_group`. `403 "pricing is disabled"` ⇒ operator gated it ⇒ fall back to `/api/ratio_config` (usually 403 too) then to `/api/user/groups` (public).
3. `GET /dashboard/billing/subscription` + `GET /dashboard/billing/usage` with `Authorization: Bearer sk-…` → remaining ≈ `hard_limit_usd − total_usage/100` **only** when display type is USD/CNY; note the value is **token-scoped** unless `DisplayTokenStatEnabled=false`.
4. new-api only: `GET /api/usage/token/` → exact raw quota integers for that token.
5. `/api/models`, `/api/group`, `/api/channel/models`, `/api/user/self` are not usable with `sk-`; don't waste a probe on them (or treat a 401/200-with-success:false there as "expected").

Uncertainties I cannot resolve from source alone:
- Whether *your* operator changed one-api's `DisplayInCurrencyEnabled`/`DisplayTokenStatEnabled` or new-api's `quota_display_type` — must be read from `/api/status` at runtime.
- one-api's `main` branch head in this environment is Feb 2025; if upstream has newer commits, the one-api statements are valid for v0.6.11 and every line number cites that commit. I did not inspect one-api tags newer than `v0.6.11-preview.7`.
- new-api `main` (v1.0.0-rc) is a very fast-moving line: e.g. `/api/user/token` was deleted and `/api/pricing` was re-gated between v0.13.2 and v1.0.0-rc. My matrix covers exactly the four tags listed; anything between them is unverified.
- `/api/log/token`'s exact middleware in v0.9.x was not read line-by-line for the group-level `Use()`; I verified v0.8.1 (no auth middleware on that route) and v0.13.2+ (`TokenAuthReadOnly`).
