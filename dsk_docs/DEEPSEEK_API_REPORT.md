# DeepSeek Open Platform — Balance / Billing / Pricing API facts

Evidence collected 2026-10-12 (UTC) live from `api-docs.deepseek.com` (served by Tencent EdgeOne; `last-modified: 2026-09-24`) and by read-only probes against `api.deepseek.com` with an invalid key.
Raw captured page text: `dsk_docs/*.txt` in this workspace.

> **Breaking change vs. the task premise:** `deepseek-chat` and `deepseek-reasoner` no longer exist as current models. They were discontinued 2026-07-24. Current model ids are **`deepseek-flash`** and **`deepseek-v4-pro`**.
> Source: https://api-docs.deepseek.com/updates ("Date: 2026-04-24 … The two legacy API model names, deepseek-chat and deepseek-reasoner, will be discontinued in three months (2026-07-24."), https://api-docs.deepseek.com/quick_start/pricing

---

## 1. Balance API

| Item | Value | Source |
|---|---|---|
| Method + path | `GET /user/balance` | https://api-docs.deepseek.com/api/get-user-balance |
| Full URL | `https://api.deepseek.com/user/balance` | base URL per https://api-docs.deepseek.com/ |
| Auth header | `Authorization: Bearer <API key>` (HTTP Bearer) | https://api-docs.deepseek.com/api/deepseek-api (Authentication: HTTP Bearer Auth) |
| Credential | Same ordinary platform API key (`sk-...`). No separate/second credential is documented anywhere in the current doc set. | see below |

**Credential caveat (explicit):** the endpoint is documented inside the same API reference with global Bearer auth and no separate auth note. I could **not** confirm live that a valid `sk-` key succeeds, because no valid key is available in this environment; only the failure paths were observable. Treat "ordinary API key works" as documented-but-not-live-verified.

### Exact 200 response schema
Source: https://api-docs.deepseek.com/api/get-user-balance (EN) / https://api-docs.deepseek.com/zh-cn/api/get-user-balance (ZH)

```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "110.00",
      "granted_balance": "10.00",
      "topped_up_balance": "100.00"
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `is_available` | boolean | Whether the user's balance is sufficient for API calls |
| `balance_infos` | object[] | Array (currency is an enum: `CNY` \| `USD`) |
| `balance_infos[].currency` | string | Currency of this balance entry |
| `balance_infos[].total_balance` | string | Total available balance, incl. granted + topped-up |
| `balance_infos[].granted_balance` | string | Total **not expired** granted balance |
| `balance_infos[].topped_up_balance` | string | Total topped-up balance |

All monetary values are **strings** (not numbers) and there is **no** timestamp / history in the response — it is a point-in-time snapshot.

### Error / response shape (observed live, 2026-10-12)

| Case | Status | Body | Content-Type |
|---|---|---|---|
| Invalid key (`Authorization: Bearer sk-…`) | 401 | `{"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid (request_id: e8336763-579a-4f69-b0b7-f9a84247dc31)","type":"authentication_error","param":null,"code":"invalid_request_error"}}` | `application/json` |
| No `Authorization` header | 401 | `Authentication Fails (governor)` — plain text, Content-Length 31 | none |
| Header present but not `Bearer sk-...` | 401 | `Authentication Fails (auth header format should be Bearer sk-...)` — plain text | none |
| Insufficient balance (documented) | 402 | documented code, body not observed | https://api-docs.deepseek.com/quick_start/error_codes |

Notes: the key is masked to its last 4 characters in the message; a per-request UUID is included. Same 401 JSON shape is returned by `/models` and `/chat/completions`. Unknown paths (e.g. `/xyz123`) also return 401, because the auth gate runs before routing — **so path probing cannot be used to discover undocumented endpoints.**

## 2. Documented account/billing-related endpoints

Complete documented endpoint set (from https://api-docs.deepseek.com/sitemap.xml, 52 URLs):

- `POST /chat/completions` — https://api-docs.deepseek.com/api/create-chat-completion
- `POST /completions` (FIM, beta) — https://api-docs.deepseek.com/api/create-completion
- `POST /responses` (OpenAI Responses API format) — https://api-docs.deepseek.com/api/create-response
- `GET /models` — https://api-docs.deepseek.com/api/list-models (returns full model metadata: id, name, context_window, max_output_tokens, modalities, effort levels — **no pricing fields**)
- `GET /user/balance` — the **only** account/billing endpoint
- Files (not billing): `POST /files`, `GET /files`, `GET /files/{file_id}`, `DELETE /files/{file_id}`

Documented: `/user/balance`, `/models`, `/chat/completions`, `/completions`, `/responses`, the file endpoints.
**Not documented (i.e. no such API):** usage history, spend history, invoice/billing detail, per-key quota, pricing, or peak/off-peak schedule.
Undocumented endpoints: none asserted — I did not and could not enumerate them (auth gate returns 401 for every path).

Per-request token accounting **is** available, but from the model response itself, not a billing endpoint: the `usage` object includes `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` — https://api-docs.deepseek.com/guides/kv_cache

## 3. Pricing table (per 1M tokens)

Source: https://api-docs.deepseek.com/quick_start/pricing (USD) and https://api-docs.deepseek.com/zh-cn/quick_start/pricing (CNY).

USD:

| Model id | Input (cache hit) off-peak / peak | Input (cache miss) off-peak / peak | Output off-peak / peak | Concurrency |
|---|---|---|---|---|
| `deepseek-flash` (DeepSeek-V4.1-Flash) | $0.003 / $0.006 | $0.15 / $0.30 | $0.60 / $1.20 | 2500 |
| `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 | 500 |

CNY:

| Model id | Input (cache hit) 空闲 / 高峰 | Input (cache miss) 空闲 / 高峰 | Output 空闲 / 高峰 |
|---|---|---|---|
| `deepseek-flash` | ¥0.02 / ¥0.04 | ¥1 / ¥2 | ¥4 / ¥8 |
| `deepseek-v4-pro` | ¥0.15 / ¥0.30 | ¥4.5 / ¥9.0 | ¥13.5 / ¥27.0 |

Both models: context 1M, max output 384K. Legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted but route to V4.1-Flash and bill at Flash price. Billing formula: `expense = tokens × price`; granted balance is deducted before topped-up balance.

**Contradiction to be aware of:** https://api-docs.deepseek.com/news/news260910 states "Starting at 04:00 UTC on Sept 14, 2026, all deepseek-v4-pro requests will route to V4.1-Flash at V4.1-Flash rates", while https://api-docs.deepseek.com/updates (Date: 2026-09-10) states V4 Pro API service continues after 2026-09-14 "with the billing method remaining unchanged". The pricing page still lists V4-Pro as a separately priced model. Which rate actually applies to `deepseek-v4-pro` after 2026-09-14 is therefore ambiguous in the official docs.

## 4. Off-peak ("错峰优惠" / 峰谷定价) rules

- **Rule:** off-peak price = **50% of** peak price ("Off-peak rates are half of the peak rates" / 空闲时段价格为高峰时段价格的一半).
- **Peak windows:** **01:00–04:00 UTC and 06:00–10:00 UTC, Monday–Friday, excluding Chinese public holidays** (= 北京时间周一至周五 09:00–12:00、14:00–18:00，不含中国法定节假日).
- **Off-peak:** all other hours, including **all of Saturday/Sunday and all Chinese public holidays in full**.
- **Applies to:** all three line items — cache-hit input, cache-miss input, **and** output (each has both a PEAK and an OFF-PEAK row in the pricing table).
- **Start date (current scheme):** new V4-family peak/off-peak pricing took effect **16:00 UTC on 2026-08-16** (= 北京时间 2026-08-17 00:00). Sources: https://api-docs.deepseek.com/news/news260813 , https://api-docs.deepseek.com/updates (Date: 2026-08-13), https://api-docs.deepseek.com/zh-cn/updates
- **Price revision:** V4.1-Flash prices revised effective **04:00 UTC 2026-09-10**; peak/off-peak structure continued unchanged. Source: https://api-docs.deepseek.com/news/news260910
- Historical note: the 2025 era off-peak discount page (`/news/news250225`) **no longer exists** — it now returns the intro page (`/`). No current official page documents the old 2025 windows/percentages, so I make no claim about them.
- Not documented anywhere: whether Chinese public holidays are computed by a machine-readable calendar, and no holiday list is published (relevant if the plugin must compute peak/off-peak locally).

## 5. Programmatic pricing / schedule / usage-history API

**No such public API exists.** Explicitly:

- No documented endpoint returns pricing or the peak/off-peak schedule; these are published only as HTML pages (https://api-docs.deepseek.com/quick_start/pricing and the changelog/news pages). Not available via API.
- No documented endpoint returns usage history or spend history (no equivalent of OpenAI's `/dashboard/billing/usage`). Not available via API.
- The only programmatic monetary data is `GET /user/balance`, a **current** snapshot of `is_available`, `total_balance`, `granted_balance`, `topped_up_balance` per currency. No history, no time series, no per-key/per-model breakdown. (Not verified against a valid key — see §1.)
- Token-level usage per request must be accumulated by the caller from the `usage` object of each chat/completion response (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`) and multiplied by the published prices.

### Practical implications for a balance-monitoring plugin
1. Poll `GET https://api.deepseek.com/user/balance` with `Authorization: Bearer <sk-...>`; parse `balance_infos[]` as strings, handle both `CNY` and `USD` entries; drive alerts off `is_available` and `total_balance`.
2. Treat 401 as "bad/absent key", not "endpoint missing" — every path returns 401 with an invalid key. Body may be JSON (`{"error":{...}}`) or plain text ("Authentication Fails (governor)" / "…should be Bearer sk-..."), so the parser must tolerate non-JSON 401 bodies.
3. `402` means the account is out of balance.
4. Do **not** expect `deepseek-chat` / `deepseek-reasoner`; price from a locally maintained table keyed by `deepseek-flash` / `deepseek-v4-pro`, and refresh it by scraping the pricing page (no pricing API).

### URLs cited
- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/api/get-user-balance
- https://api-docs.deepseek.com/zh-cn/api/get-user-balance
- https://api-docs.deepseek.com/api/deepseek-api
- https://api-docs.deepseek.com/api/list-models
- https://api-docs.deepseek.com/quick_start/error_codes
- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/zh-cn/quick_start/pricing
- https://api-docs.deepseek.com/quick_start/rate_limit
- https://api-docs.deepseek.com/quick_start/token_usage
- https://api-docs.deepseek.com/guides/kv_cache
- https://api-docs.deepseek.com/updates
- https://api-docs.deepseek.com/zh-cn/updates
- https://api-docs.deepseek.com/news/news260813
- https://api-docs.deepseek.com/news/news260910
- https://api-docs.deepseek.com/news/news250929
- https://api-docs.deepseek.com/sitemap.xml
