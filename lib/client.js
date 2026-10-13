/**
 * dsh-balance-monitor —— 客户端半身（监听 Web 页）。
 *
 * 手写模块（不需要构建步骤）：只从浏览器模块表取 `react`，其余控件自己写，
 * 样式只用宿主主题 token（都带 fallback，token 改名不会把卡片打崩）。
 *
 * 三个渲染位置：
 *   1. `settings.models.provider-card` —— 每张供应商卡片里的类型/额度/花费/图片补全；
 *   2. `sidebar.footer.action`         —— 侧栏底部的「余额 / 今日 / 峰谷倒计时 / 价格表」；
 *   3. `settings.section`              —— 设置页「余额与费用」：概览 / 额度 / 用量 / 价格 / 显示。
 *
 * 数据来源：宿主侧的同源路由（浏览器跨域取不到中转站接口，必须宿主代取）。
 *   GET  /plugins/dsh-balance-monitor/state
 *   GET  /plugins/dsh-balance-monitor/sidebar
 *   GET  /plugins/dsh-balance-monitor/report
 *   POST /plugins/dsh-balance-monitor/config        { display?, budget?, retention?, priceSources? }
 *   POST /plugins/dsh-balance-monitor/balance/refresh
 *   POST /plugins/dsh-balance-monitor/prices/update
 *   POST /plugins/dsh-balance-monitor/type          { provider, type }
 *   POST /plugins/dsh-balance-monitor/refresh       { provider }
 *   POST /plugins/dsh-balance-monitor/vision/auto   { provider, enabled }
 *   POST /plugins/dsh-balance-monitor/vision/apply  { provider? }
 */
window.__ModuleLoader__.load({
  id: 'dsh-balance-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const ROUTE = '/plugins/dsh-balance-monitor'
    /** 侧栏余额显示哪条 DeepSeek 路线（点余额行切换） */
    const BALANCE_PICK_KEY = 'balance-monitor:sidebar-balance'

    const isZh = (() => {
      try {
        return String(navigator.language ?? '').toLowerCase().startsWith('zh')
      } catch {
        return true
      }
    })()

    const S = isZh
      ? {
          type: '供应商类型',
          other: '其他',
          sub2api: 'Sub2Api',
          refresh: '刷新',
          refreshing: '刷新中…',
          loading: '读取中…',
          quota: '额度',
          rate: '倍率',
          models: '模型',
          spend: '花费',
          balance: '余额',
          remaining: '剩余',
          limit: '上限',
          used: '已用',
          wallet: '钱包余额',
          plan: '套餐',
          expiredIn: '天后到期',
          official: '官方价',
          effective: '按倍率',
          actual: '站方实扣',
          consistent: '与站方实扣一致',
          mismatch: '与站方实扣不一致（反推倍率 {rate}），以接口倍率为准',
          periodTotal: '累计',
          periodToday: '今日',
          periodModels: '逐模型合计',
          group: '分组',
          userOverride: '用户专属',
          resolved: '解析后',
          peakOn: '峰谷已启用 {start}–{end} ×{multiplier}（当前 ×{applied}，时区 {tz}）',
          peakOff: '峰谷未启用',
          noKey: '未找到 API Key',
          clickRefresh: '点「刷新」查询',
          notSub2api: '非 Sub2Api 供应商不查询额度。',
          image: '图片',
          imageAll: '{declared}/{total} 个模型已声明图片',
          imageExplicit: '另有 {n} 个显式纯文本',
          autoImage: '新模型自动补图片',
          applyImage: '立即补图片',
          applying: '补全中…',
          imageApplied: '已补 {n} 个模型：{models}',
          imageNothing: '没有需要补的模型',
          imageAutoOff: '自动补图片已关闭',
          keyRow: '密钥',
          keyPrimary: '主 key（宿主正在用）',
          keyConfigured: '已配置',
          keyMissing: '未配置',
          keyAdd: '添加 key',
          revealKey: '显示密钥',
          hideKey: '隐藏密钥',
          saveKey: '保存 key',
          remove: '删除',
          // ── 设置页「余额与费用」 ──
          sectionLabel: '余额与费用',
          loadFailed: '读取失败',
          tabOverview: '概览',
          tabQuota: '额度',
          tabUsage: '用量',
          tabPrices: '价格',
          tabDisplay: '显示',
          todayCost: '今日费用',
          monthCost: '本月费用',
          allCost: '累计费用',
          since: '自',
          callsCount: '调用',
          times: '次',
          inputTok: '输入',
          cacheTok: '缓存',
          outputTok: '输出',
          cacheWriteTok: '缓存写入',
          reasoningTok: '推理',
          hitRate: '命中',
          days: '天',
          cost: '费用',
          costNote: '金额按**入账时刻冻结的单价 × 站方倍率**累加，所以改价目/倍率不会动历史。未命中价目的调用只记 token，金额显示 —。',
          unpricedNote: n => `今日有 ${n} 笔未定价`,
          unpricedMonth: n => `本月累计 ${n} 笔未定价`,
          todaySessions: '今日会话',
          session: '会话',
          noSessions: '今日还没有调用记录',
          budget: '预算',
          enableBudget: '启用预算',
          budgetAmount: '额度',
          periodMonth: '本月',
          periodAll: '累计',
          save: '保存',
          reset: '还原',
          overBudget: '已超支',
          nearBudget: '接近额度',
          budgetOff: '未启用预算（勾选后可显示已用金额与占比）',
          budgetNoAmount: '还没填额度',
          officialBalance: '官方账户余额',
          balanceUnavailable: '暂不可用',
          total: '总余额',
          granted: '赠送',
          toppedUp: '充值',
          updatedAt: '更新于',
          balanceKeysRow: '按 key 明细',
          pickDiscovered: '选一个探测到的引用…',
          discoveryUnsupported: '这个宿主的凭据服务没有 describe()，请手填引用名。',
          discoveryScanned: n => `已探测 ${n} 个候选名`,
          discoveryFound: list => `命中：${list}`,
          addKey: '添加 key 引用',
          balanceKeysHint: '填凭据引用名（如 DEEPSEEK_API_KEY_2）即可把第二把 key 的余额一并计入总额；同一引用只查一次。',
          balanceSumHint: '总额 = 上面每把 key 之和（币种不一致时不显示总额）。',
          balanceHint: '余额有两处来源：DeepSeek 官方 API Key 路线（api.deepseek.com）与登录账号后的平台账号路线（platform.deepseek.com）——它们是两个不同的钱包，数字本来就不一样。其余供应商没有余额接口，看「额度」页。站方实扣以站方账单为准。',
          balanceSource: {
            'api-key': 'API Key 路线',
            'account-platform': '账号路线（平台精确余额）',
            'account-api': '账号路线（推理域，2 位）',
          },
          peakNow: '当前档位',
          peakText: '见侧栏倒计时条',
          tabIn: '展示币种',
          basis: '计价依据',
          quotaHint: '额度与倍率来自各供应商接口（60 秒内复用缓存）。积分型站点的 credits 只是相对量，不折算成钱。',
          provider: '供应商',
          status: '状态',
          remark: '备注',
          expiresAt: '到期',
          peakYes: '启用',
          peakNo: '未启用',
          quotaNote: '「费用」列是今日按倍率算出的金额；未定价时显示 —。',
          trendTitle: n => `最近 ${n} 天`,
          modelToday: '今日按模型',
          model: '模型',
          modelsUnit: '个模型',
          priceBasis: '计价依据',
          updatePrices: '更新价格表',
          lastUpdate: '最近更新',
          bundled: '随包快照',
          allowedSources: '参与计价的来源等级',
          recommended: '推荐组合',
          sourceHint: '默认 official + station + manual。转售（opencode.ai）与聚合（openrouter.ai）价格含加价/促销，默认不参与——需要时才勾上。',
          sourceLevel: '来源等级',
          entries: '条数',
          explain: '说明',
          srcOfficial: '官方价',
          srcStation: '站方口径',
          srcManual: '手工填写',
          srcReseller: '转售商',
          srcAggregator: '聚合目录',
          srcUnknown: '来源未知',
          srcOfficialCode: 'official',
          srcStationCode: 'station',
          srcManualCode: 'manual',
          sourceExplain: {
            official: '厂商自有文档域上的挂牌价',
            station: 'Sub2Api 自己算钱用的那张表（LiteLLM），与站方账单同源',
            manual: '你自己填的条目（state.json 的 priceTable / 别名）',
            reseller: '转售商挂牌价，含加价与促销档',
            aggregator: '聚合目录价，含 :batch/:free 变体',
            unknown: '没有来源可判，默认不参与',
          },
          attribution: '数据出处',
          sourceUrlLabel: '来源地址',
          currency: '币种',
          symbol: '符号',
          decimals: '小数位',
          exchangeRate: '汇率',
          displayHint: '账本以美元入账，展示时按上面汇率折算。改币种/汇率会换计价依据指纹，**只影响之后的调用**。',
          displayHint2: '「未定价」不会被画成 0 —— 那表示当时没有可用的价目依据。',
          retention: '账本保留',
          ledgerDays: '账本明细（天）',
          rollupDays: '日汇总（天）',
          saveRetention: '保存保留期',
          retentionHint: '明细供「今日会话 / 按模型」用，日汇总供「本月 / 累计」用（上限 3650 天）。'
            + '调小会**立刻**删掉超期数据且不可恢复；日汇总不会短于明细。',
        }
      : {
          type: 'Provider type',
          other: 'Other',
          sub2api: 'Sub2Api',
          refresh: 'Refresh',
          refreshing: 'Refreshing…',
          loading: 'Loading…',
          quota: 'Quota',
          rate: 'Multiplier',
          models: 'Models',
          spend: 'Spend',
          balance: 'Balance',
          remaining: 'Remaining',
          limit: 'Limit',
          used: 'Used',
          wallet: 'Wallet balance',
          plan: 'Plan',
          expiredIn: 'days to expiry',
          official: 'Official price',
          effective: '× multiplier',
          actual: 'Station charge',
          consistent: 'matches the station charge',
          mismatch: 'differs from the station charge (implied {rate}); the endpoint multiplier wins',
          periodTotal: 'all time',
          periodToday: 'today',
          periodModels: 'per-model total',
          group: 'group',
          userOverride: 'user override',
          resolved: 'resolved',
          peakOn: 'Peak pricing on {start}–{end} ×{multiplier} (now ×{applied}, tz {tz})',
          peakOff: 'Peak pricing off',
          noKey: 'No API key found',
          clickRefresh: 'Press Refresh to query',
          notSub2api: 'Not a Sub2Api provider; nothing to query.',
          image: 'Images',
          imageAll: '{declared}/{total} models declare image input',
          imageExplicit: '{n} more are explicitly text-only',
          autoImage: 'Auto-enable image for new models',
          applyImage: 'Add image now',
          applying: 'Applying…',
          imageApplied: 'Added image to {n} model(s): {models}',
          imageNothing: 'Nothing to add',
          imageAutoOff: 'Auto image is off',
          keyRow: 'Key',
          keyPrimary: 'primary (used by the host)',
          keyConfigured: 'configured',
          keyMissing: 'missing',
          keyAdd: 'Add key',
          revealKey: 'Reveal key',
          hideKey: 'Hide key',
          saveKey: 'Save key',
          remove: 'Remove',
          // ── Settings page: Balance & Cost ──
          sectionLabel: 'Balance & Cost',
          loadFailed: 'Load failed',
          tabOverview: 'Overview',
          tabQuota: 'Quota',
          tabUsage: 'Usage',
          tabPrices: 'Prices',
          tabDisplay: 'Display',
          todayCost: 'Today',
          monthCost: 'This month',
          allCost: 'All time',
          since: 'since',
          callsCount: 'calls',
          times: 'calls',
          inputTok: 'input',
          cacheTok: 'cache',
          outputTok: 'output',
          cacheWriteTok: 'cache write',
          reasoningTok: 'reasoning',
          hitRate: 'Hit rate',
          days: 'days',
          cost: 'Cost',
          costNote: 'Amounts accrue with the unit price and station multiplier frozen at call time, so price or rate changes never re-price history. Calls with no price basis record tokens only and show —.',
          unpricedNote: n => `${n} unpriced call(s) today`,
          unpricedMonth: n => `${n} unpriced this month`,
          todaySessions: "Today's sessions",
          session: 'Session',
          noSessions: 'No calls recorded today',
          budget: 'Budget',
          enableBudget: 'Enable budget',
          budgetAmount: 'Amount',
          periodMonth: 'This month',
          periodAll: 'All time',
          save: 'Save',
          reset: 'Reset',
          overBudget: 'over budget',
          nearBudget: 'close to limit',
          budgetOff: 'Budget is off (enable it to see used amount and share)',
          budgetNoAmount: 'No amount set yet',
          officialBalance: 'Official account balance',
          balanceUnavailable: 'Unavailable',
          total: 'Total',
          granted: 'Granted',
          toppedUp: 'Topped up',
          updatedAt: 'updated',
          balanceKeysRow: 'Per key',
          pickDiscovered: 'Pick a discovered ref…',
          discoveryUnsupported: 'This host has no credentials.describe(); type the ref manually.',
          discoveryScanned: n => `scanned ${n} candidate names`,
          discoveryFound: list => `found: ${list}`,
          addKey: 'Add key ref',
          balanceKeysHint: 'Enter a credential ref name (e.g. DEEPSEEK_API_KEY_2) to include a second key in the total; each ref is queried once.',
          balanceSumHint: 'Total = sum of the keys above (hidden when currencies differ).',
          balanceHint: 'Two balance sources: the DeepSeek API-key route (api.deepseek.com) and the signed-in Platform account route (platform.deepseek.com) — separate wallets with different numbers. Other providers expose no balance; see the Quota tab. The station charge is authoritative.',
          balanceSource: {
            'api-key': 'API key route',
            'account-platform': 'Account route (exact)',
            'account-api': 'Account route (2dp)',
          },
          peakNow: 'Current tier',
          peakText: 'see the sidebar countdown',
          tabIn: 'Display currency',
          basis: 'Basis',
          quotaHint: 'Quota and multipliers come from each provider endpoint (cached for 60s). Credits-only stations are a relative metric, not money.',
          provider: 'Provider',
          status: 'Status',
          remark: 'Notes',
          expiresAt: 'expires',
          peakYes: 'on',
          peakNo: 'off',
          quotaNote: 'The cost column is today’s amount after the multiplier; — means unpriced.',
          trendTitle: n => `Last ${n} days`,
          modelToday: 'Today by model',
          model: 'Model',
          modelsUnit: 'models',
          priceBasis: 'Price basis',
          updatePrices: 'Update prices',
          lastUpdate: 'Updated',
          bundled: 'bundled snapshot',
          allowedSources: 'Source tiers used for pricing',
          recommended: 'Recommended',
          sourceHint: 'Defaults to official + station + manual. Reseller (opencode.ai) and aggregator (openrouter.ai) prices carry markups or promos and stay off unless you opt in.',
          sourceLevel: 'Tier',
          entries: 'Entries',
          explain: 'Meaning',
          srcOfficial: 'Official',
          srcStation: 'Station basis',
          srcManual: 'Manual',
          srcReseller: 'Reseller',
          srcAggregator: 'Aggregator',
          srcUnknown: 'Unknown',
          srcOfficialCode: 'official',
          srcStationCode: 'station',
          srcManualCode: 'manual',
          sourceExplain: {
            official: 'List price from the vendor’s own documentation domain',
            station: 'The LiteLLM table Sub2Api bills with — same basis as the station invoice',
            manual: 'Entries you filled in yourself (priceTable / aliases in state.json)',
            reseller: 'Reseller list price incl. markup and promo tiers',
            aggregator: 'Aggregator catalogue price incl. :batch/:free variants',
            unknown: 'No provenance; excluded by default',
          },
          attribution: 'Data source',
          sourceUrlLabel: 'Source URL',
          currency: 'Currency',
          symbol: 'Symbol',
          decimals: 'Decimals',
          exchangeRate: 'Rate',
          displayHint: 'The ledger stores USD; display converts with the rate above. Changing currency or rate changes the basis fingerprint and affects future calls only.',
          displayHint2: '“Unpriced” is never drawn as 0 — it means no price basis was available at that moment.',
          retention: 'Ledger retention',
          ledgerDays: 'Detail (days)',
          rollupDays: 'Daily rollup (days)',
          saveRetention: 'Save retention',
          retentionHint: 'Detail feeds “today\u2019s sessions / by model”; the rollup feeds month/all totals (max 3650 days). '
            + 'Lowering it **immediately** deletes older data (not recoverable); the rollup is never shorter than the detail.',
        }

    // ── 侧栏底部（余额 / 今日 / 峰谷倒计时条）的文案 ──
    const S2 = isZh
      ? {
          balance: '余额',
          balanceInsufficient: '余额不足',
          today: '今日',
          all: '全部',
          provider: '供应商',
          calls: '{n} 次',
          hit: '命中 {p}%',
          unpriced: '{n} 笔未定价',
          peakToPeak: '后进入高峰',
          peakToOff: '后进入平价',
          weekendAllOff: '周末全谷价',
          holidayAllOff: '法定假日全谷价',
          prices: '价格表',
          bundled: '内置',
          updatePrices: '更新',
          updating: '更新中…',
          pricesHint: '抓取站方口径价目（LiteLLM 镜像 / sub2api 兜底）；更新只影响之后的调用，不改历史',
          balanceSwitchHint: '⇄',
          balanceHint: '点击展开：各官方路线 + 每把 key 的余额明细',
          balanceKeys: '按 key 明细',
          balanceHintMany: n => `登录 DeepSeek 账号后有两个供应商（API Key / 账号），余额是两份不同的钱；点一下在 ${n} 条之间切换`,
          balanceHintOne: name => `${name || 'DeepSeek'}：只有这一条官方路线，无可切换的余额`,
        }
      : {
          balance: 'Balance',
          balanceInsufficient: 'insufficient',
          today: 'Today',
          all: 'All',
          provider: 'Provider',
          calls: '{n} calls',
          hit: 'hit {p}%',
          unpriced: '{n} unpriced',
          peakToPeak: ' to peak',
          peakToOff: ' to off-peak',
          weekendAllOff: 'Weekend · all off-peak',
          holidayAllOff: 'Holiday · all off-peak',
          prices: 'Prices',
          bundled: 'bundled',
          updatePrices: 'Update',
          updating: 'Updating…',
          pricesHint: 'Fetch station-basis prices (LiteLLM mirror / sub2api fallback); updates affect future calls only',
          balanceSwitchHint: '⇄',
          balanceHint: 'Click to expand: routes + per-key balances',
          balanceKeys: 'Per key',
          balanceHintMany: n => `Signing in to a DeepSeek account gives two providers (API key / account) with separate wallets; click to cycle ${n}`,
          balanceHintOne: name => `${name || 'DeepSeek'}: only one official route, nothing to switch`,
        }

    const css = {
      root: {
        marginTop: 8,
        padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        fontSize: 12,
        lineHeight: 1.7,
      },
      head: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      label: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      select: {
        height: 26,
        padding: '0 6px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
        fontSize: 12,
      },
      button: {
        height: 26,
        padding: '0 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        columnGap: 10,
        rowGap: 2,
        marginTop: 6,
      },
      key: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', whiteSpace: 'nowrap' },
      val: { wordBreak: 'break-word' },
      check: { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' },
      error: { marginTop: 6, color: 'var(--dsw-alias-label-error, #d33)' },
      note: { marginTop: 4, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
    }

    const num = (value, digits = 4) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value === 0) return '0'
      const abs = Math.abs(value)
      if (abs >= 1000) return value.toFixed(2)
      if (abs >= 1) return value.toFixed(digits)
      return value.toPrecision(4)
    }
    const money = (value, unit) => (typeof value === 'number' ? `${num(value)}${unit ? ` ${unit}` : ''}` : '—')

    // ── 跨卡片共享的一份状态：N 张卡片只发一次请求 ──
    const store = {
      state: null,
      error: null,
      loading: false,
      listeners: new Set(),
      inflight: null,
      emit() {
        for (const fn of [...this.listeners]) {
          try { fn() } catch { /* 单个订阅者出错不影响其它卡片 */ }
        }
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
      async call(path, init) {
        const response = await fetch(`${ROUTE}${path}`, {
          headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
          method: init?.body ? 'POST' : 'GET',
          body: init?.body ? JSON.stringify(init.body) : undefined,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok !== true) {
          throw new Error(payload?.error ?? `HTTP ${response.status}`)
        }
        return payload.state
      },
      async load(force) {
        if (this.inflight !== null) return this.inflight
        this.loading = true
        this.emit()
        this.inflight = (async () => {
          try {
            this.state = await this.call('/state')
            this.error = null
          } catch (error) {
            this.error = String(error?.message ?? error)
          } finally {
            this.loading = false
            this.inflight = null
            this.emit()
          }
        })()
        return this.inflight
      },
      async mutate(path, body) {
        this.loading = true
        this.emit()
        try {
          this.state = await this.call(path, { body })
          this.error = null
        } catch (error) {
          this.error = String(error?.message ?? error)
        } finally {
          this.loading = false
          this.emit()
        }
      },
    }

    function useStore(provider) {
      const [, bump] = useState(0)
      useEffect(() => {
        const unsubscribe = store.subscribe(() => bump(n => n + 1))
        // 已经加载过但**没有这个供应商**时也要再拉一次：手工新增的供应商要等下一次
        // /state 才会出现，而宿主正是拿这次请求去补它的图片模态。
        const known = provider !== undefined && store.state?.providers?.some(item => item.provider === provider)
        if (store.state === null || (provider !== undefined && !known)) store.load()
        return unsubscribe
      }, [provider])
      return store
    }

    function row(key, value) {
      return [h('span', { style: css.key, key: `${key}-k` }, key), h('span', { style: css.val, key: `${key}-v` }, value)]
    }

    function describeQuota(entry) {
      const sub = entry.sub2api
      if (!sub) return null
      const unit = sub.unit
      if (sub.quota && typeof sub.quota.remaining === 'number') {
        const parts = [`${num(sub.quota.remaining)} / ${num(sub.quota.limit)} ${unit ?? ''}`.trim()]
        if (typeof sub.daysUntilExpiry === 'number') parts.push(`${sub.daysUntilExpiry} ${S.expiredIn}`)
        return [`${S.plan}`, parts.join(' · ')]
      }
      if (sub.subscription) {
        const parts = []
        if (typeof sub.subscription.dailyLimit === 'number') parts.push(`1d ${num(sub.subscription.dailyUsage)}/${num(sub.subscription.dailyLimit)}`)
        if (typeof sub.subscription.weeklyLimit === 'number') parts.push(`7d ${num(sub.subscription.weeklyUsage)}/${num(sub.subscription.weeklyLimit)}`)
        if (typeof sub.subscription.monthlyLimit === 'number') parts.push(`30d ${num(sub.subscription.monthlyUsage)}/${num(sub.subscription.monthlyLimit)}`)
        return [S.plan, parts.join(' · ') || '—']
      }
      if (typeof sub.balance === 'number') return [sub.planName || S.wallet, money(sub.balance, unit)]
      return [S.quota, '—']
    }

    function describeRate(rate) {
      if (!rate || typeof rate.effective !== 'number') return null
      const parts = []
      if (typeof rate.group === 'number') parts.push(`${S.group} ${num(rate.group)}`)
      if (typeof rate.user === 'number') parts.push(`${S.userOverride} ${num(rate.user)}`)
      if (typeof rate.resolved === 'number' && rate.resolved !== rate.effective) parts.push(`${S.resolved} ${num(rate.resolved)}`)
      const peak = rate.peak?.enabled
        ? S.peakOn
            .replace('{start}', String(rate.peak.start ?? '?'))
            .replace('{end}', String(rate.peak.end ?? '?'))
            .replace('{multiplier}', num(rate.peak.multiplier))
            .replace('{applied}', num(rate.peak.applied))
            .replace('{tz}', String(rate.peak.timezone ?? '—'))
        : S.peakOff
      return `${num(rate.effective)}${parts.length > 0 ? `（${parts.join(' · ')}）` : ''} · ${peak}`
    }

    function describeSpend(entry) {
      const spend = entry.sub2api?.spend
      if (!spend) return null
      const period = spend.period === 'today' ? S.periodToday : spend.period === 'models' ? S.periodModels : S.periodTotal
      const lines = [
        `${S.official} ${money(spend.officialCost, spend.currency)} × ${num(spend.effectiveRate)} = ${money(spend.byMultiplier, spend.currency)}（${period}）`,
      ]
      const tail = spend.actualCost === null
        ? ''
        : spend.mismatch
          ? S.mismatch.replace('{rate}', num(spend.impliedRate))
          : ` · ${S.consistent}`
      const actual = spend.actualCost === null ? '' : `　${S.actual} ${money(spend.actualCost, spend.currency)}`
      return [lines[0], `${S.effective}${actual}${tail}`]
    }

    /**
     * DeepSeek 卡片的「多把 key」编辑区：直接写宿主凭据库（`PUT /keys`），
     * 引用名自动顺位（`DEEPSEEK_API_KEY_2`、`_3`…）。**值只上行、不下来**。
     */
    function KeyEditor({ provider }) {
      const [state, setState] = useState({ loading: true, keys: [], nextRef: null, primaryRef: null, error: null })
      const [value, setValue] = useState('')
      const [busy, setBusy] = useState(false)
      /** ref → 已揭示的值（只在点眼睛后才有） */
      const [revealed, setRevealed] = useState({})
      const apply = async (path, init) => {
        const response = await fetch(`${ROUTE}${path}`, {
          method: init?.method ?? 'GET',
          headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
          body: init?.body ? JSON.stringify(init.body) : undefined,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload.data
      }
      const load = useCallback(async () => {
        try {
          const data = await apply(`/keys?provider=${encodeURIComponent(provider)}`)
          setState({ loading: false, error: null, ...data })
        } catch (error) {
          setState(prev => ({ ...prev, loading: false, error: String(error?.message ?? error) }))
        }
      }, [provider])
      useEffect(() => { void load() }, [load])
      const submit = useCallback(async () => {
        if (value.trim() === '') return
        setBusy(true)
        try {
          const data = await apply('/keys', { method: 'PUT', body: { provider, value: value.trim() } })
          setValue('')
          setState({ loading: false, error: null, ...data })
        } catch (error) {
          setState(prev => ({ ...prev, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }, [provider, value])
      const remove = useCallback(async ref => {
        setBusy(true)
        try {
          const data = await apply('/keys', { method: 'DELETE', body: { provider, ref } })
          setState({ loading: false, error: null, ...data })
        } catch (error) {
          setState(prev => ({ ...prev, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }, [provider])

      const toggleReveal = useCallback(async ref => {
        let next = null
        if (revealed[ref] !== undefined) {
          next = { ...revealed }
          delete next[ref]
          setRevealed(next)
          return
        }
        try {
          const data = await apply('/keys/reveal', { method: 'POST', body: { provider, ref } })
          setRevealed({ ...revealed, [ref]: data.value })
        } catch (error) {
          setState(prev => ({ ...prev, error: String(error?.message ?? error) }))
        }
      }, [apply, provider, revealed])

      const rows = []
      for (const key of state.keys ?? []) {
        const shown = revealed[key.ref]
        rows.push(row(`${S.keyRow} ${key.ref}`,
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            // 值默认打码；点小眼睛才去宿主取一次（常规 /keys 列表里不含值）
            key.configured
              ? h('code', { style: { ...css.note, minWidth: 110 } }, shown === undefined ? '••••••••' : shown)
              : h('span', { style: css.note }, S.keyMissing),
            key.configured
              ? h('button', {
                  type: 'button',
                  style: css.button,
                  title: shown === undefined ? S.revealKey : S.hideKey,
                  'aria-label': shown === undefined ? S.revealKey : S.hideKey,
                  onClick: () => { void toggleReveal(key.ref) },
                }, shown === undefined ? '👁' : '🙈')
              : null,
            h('span', { style: css.note }, key.ref === state.primaryRef
              ? S.keyPrimary
              : key.configured ? S.keyConfigured : S.keyMissing),
            key.managed
              ? h('button', { type: 'button', style: css.button, disabled: busy, onClick: () => { void remove(key.ref) } }, S.remove)
              : null)))
      }
      rows.push(row(S.keyAdd,
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h('input', {
            type: 'password',
            style: { ...css.select, width: 280 },
            placeholder: state.nextRef ?? '',
            value,
            onChange: event => setValue(event.target.value),
          }),
          h('button', { type: 'button', style: css.button, disabled: busy || value.trim() === '', onClick: () => { void submit() } },
            busy ? S.loading : S.saveKey))))
      if (state.error !== null) rows.push(row('', h('span', { style: css.error }, state.error)))
      return h('div', { style: css.grid }, rows)
    }
    function BalanceCard(props) {
      const provider = props?.provider?.provider ?? props?.provider?.id ?? props?.provider
      const view = useStore(provider)
      const entry = view.state?.providers?.find(item => item.provider === provider)
      const [busy, setBusy] = useState(false)

      const onType = useCallback(async event => {
        const type = event.target.value
        setBusy(true)
        await store.mutate('/type', { provider, type })
        setBusy(false)
      }, [provider])

      const onRefresh = useCallback(async () => {
        setBusy(true)
        await store.mutate('/refresh', { provider })
        setBusy(false)
      }, [provider])

      const onAutoImage = useCallback(async event => {
        setBusy(true)
        await store.mutate('/vision/auto', { provider, enabled: event.target.checked })
        setBusy(false)
      }, [provider])

      const onApplyImage = useCallback(async () => {
        setBusy(true)
        await store.mutate('/vision/apply', { provider })
        setBusy(false)
      }, [provider])

      if (entry === undefined) {
        return h('div', { style: css.root },
          h('div', { style: css.head }, h('span', { style: css.label }, S.type),
            h('span', null, view.loading ? S.loading : '—')))
      }

      const type = entry.type ?? 'other'
      const image = entry.image
      const imageEditable = image?.editable === true
      const justApplied = (view.state?.vision?.applied ?? []).find(item => item.provider === provider)
      const rows = []
      if (type === 'sub2api') {
        if (entry.status === 'idle') rows.push(row(S.quota, S.clickRefresh))
        if (entry.status === 'error') rows.push(row(S.quota, entry.error ?? '—'))
        if (entry.status === 'ok' && entry.sub2api) {
          const quota = describeQuota(entry)
          if (quota) rows.push(row(S.quota, `${quota[0]}：${quota[1]}`))
          rows.push(row(S.rate, describeRate(entry.sub2api.rate) ?? '—'))
          rows.push(row(S.models, `${entry.sub2api.modelCount ?? 0}`))
          const spend = describeSpend(entry)
          if (spend) {
            rows.push(row(S.spend, spend[0]))
            rows.push(row('', spend[1]))
          }
          if (entry.updatedAt) rows.push(row('', `${new Date(entry.updatedAt).toLocaleTimeString()}`))
        }
      } else {
        rows.push(row('', S.notSub2api))
      }
      if (imageEditable) {
        const detail = [S.imageAll.replace('{declared}', String(image.declared)).replace('{total}', String(image.total))]
        if (image.explicitText > 0) detail.push(S.imageExplicit.replace('{n}', String(image.explicitText)))
        if (image.auto !== true) detail.push(S.imageAutoOff)
        rows.push(row(S.image, detail.join(' · ')))
        if (justApplied && justApplied.models.length > 0) {
          const names = justApplied.models.slice(0, 6).join('、')
          const more = justApplied.models.length > 6 ? ` +${justApplied.models.length - 6}` : ''
          rows.push(row('', S.imageApplied.replace('{n}', String(justApplied.models.length)).replace('{models}', names + more)))
        }
      }

      return h('div', { style: css.root },
        h('div', { style: css.head },
          h('span', { style: css.label }, S.type),
          h('select', {
            style: css.select,
            value: type,
            disabled: busy || view.loading,
            'aria-label': S.type,
            onChange: onType,
          },
            h('option', { value: 'other' }, S.other),
            h('option', { value: 'sub2api' }, S.sub2api)),
          type === 'sub2api'
            ? h('button', {
                type: 'button',
                style: css.button,
                disabled: busy || view.loading,
                onClick: onRefresh,
              }, busy || view.loading ? S.refreshing : S.refresh)
            : null,
          imageEditable
            ? h('label', { style: css.check, title: S.autoImage },
                h('input', {
                  type: 'checkbox',
                  checked: image.auto === true,
                  disabled: busy || view.loading,
                  onChange: onAutoImage,
                }),
                h('span', null, S.autoImage))
            : null,
          imageEditable
            ? h('button', {
                type: 'button',
                style: css.button,
                disabled: busy || view.loading || image.missing === 0,
                onClick: onApplyImage,
                title: image.missing === 0 ? S.imageNothing : S.applyImage,
              }, busy || view.loading ? S.applying : S.applyImage)
            : null,
          entry.hasKey === false ? h('span', { style: css.label }, S.noKey) : null),
        rows.length > 0 ? h('div', { style: css.grid }, rows) : null,
        // DeepSeek 路线：多把 key 的编辑区（写宿主凭据库）
        entry.deepseekRoute === undefined ? null : h(KeyEditor, { provider }),
        view.error ? h('div', { style: css.error }, view.error) : null)
    }

    // ── 侧栏底部：余额（仅官方） / 今日（倍率之后的实际花费） / 峰谷倒计时条 ──
    const SIDEBAR_POLL_MS = 30_000
    /** 与 settings 卡片分开的一份状态：侧栏常驻，卡片只在设置页里。 */
    const sidebar = {
      data: null,
      error: null,
      priceMessage: null,
      priceFailed: false,
      updating: false,
      listeners: new Set(),
      inflight: null,
      emit() {
        for (const fn of [...this.listeners]) {
          try { fn() } catch { /* 单个订阅者出错不影响别人 */ }
        }
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
      async load() {
        if (this.inflight !== null) return this.inflight
        this.inflight = (async () => {
          try {
            const response = await fetch(`${ROUTE}/sidebar`, { headers: { accept: 'application/json' } })
            const payload = await response.json().catch(() => null)
            if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
            this.data = payload.data
            this.error = null
          } catch (error) {
            this.error = String(error?.message ?? error)
          } finally {
            this.inflight = null
            this.emit()
          }
        })()
        return this.inflight
      },
      /**
       * 「更新价格表」：让宿主去抓站方口径价目（LiteLLM 镜像 / sub2api 兜底）。
       * 更新只影响之后的调用（依据变更不重算历史）。
       */
      async updatePrices() {
        if (this.updating === true) return
        this.updating = true
        this.priceMessage = isZh ? '更新中…' : 'Updating…'
        this.priceFailed = false
        this.emit()
        try {
          const response = await fetch(`${ROUTE}/prices/update`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: '{}',
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          const meta = payload.data?.meta ?? {}
          const count = Number.isFinite(Number(meta.accepted)) ? Number(meta.accepted) : null
          this.priceMessage = (isZh ? '价目已更新' : 'Prices updated') + (count === null ? '' : ` · ${count} 个模型`)
        } catch (error) {
          this.priceFailed = true
          this.priceMessage = (isZh ? '更新失败：' : 'Update failed: ') + String(error?.message ?? error)
        } finally {
          this.updating = false
          this.emit()
          // 价格变了就顺便刷一次侧栏（金额口径可能随来源等级变化）
          void this.load()
        }
      },
    }

    function useSidebar() {
      const [, bump] = useState(0)
      useEffect(() => {
        const unsubscribe = sidebar.subscribe(() => bump(n => n + 1))
        if (sidebar.data === null) sidebar.load()
        const timer = setInterval(() => { void sidebar.load() }, SIDEBAR_POLL_MS)
        // 切回窗口时补一次：别的页面改过配置就该立刻反映出来
        const onFocus = () => { void sidebar.load() }
        window.addEventListener('focus', onFocus)
        return () => {
          unsubscribe()
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [])
      return sidebar
    }

    /** 金额格式化：按展示币种的小数位，值太小自动放宽两位（避免显示成 0）。 */
    function formatAmount(value, display) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const symbol = typeof display?.symbol === 'string' && display.symbol.length > 0 ? display.symbol : '¥'
      const decimals = Number.isInteger(display?.decimals) ? Math.max(0, Math.min(8, display.decimals)) : 4
      const text = value !== 0 && Math.abs(value) < Math.pow(10, -decimals)
        ? value.toFixed(decimals + 2)
        : value.toFixed(decimals)
      return `${symbol}${text}`
    }

    const CURRENCY_SYMBOL = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$', TWD: 'NT$', KRW: '₩' }

    /**
     * 按**金额自己的币种**排版。
     *
     * 为什么不能直接用展示币种：官方余额、站方余额、积分额度的币种各不相同
     * （人民币 / 美元 / credits），借用展示符号会把 ¥0.01 显示成 $0.01。
     */
    function formatMoney(value, currency, display) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const code = typeof currency === 'string' && currency.trim().length > 0 ? currency.trim().toUpperCase() : null
      const symbol = code === null ? undefined : CURRENCY_SYMBOL[code]
      if (symbol !== undefined) return formatAmount(value, { ...(display ?? {}), symbol })
      const text = formatAmount(value, { ...(display ?? {}), symbol: '' })
      return code === null ? text : `${text} ${code}`
    }

    function formatTokens(value) {      const number = Math.max(0, Number(value) || 0)
      if (number < 1e3) return String(Math.round(number))
      if (number < 1e6) return `${(number / 1e3).toFixed(1)}K`
      return `${(number / 1e6).toFixed(1)}M`
    }

    function formatCountdown(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return isZh ? '<1 分钟' : '<1 min'
      const minutes = Math.floor(ms / 60_000)
      if (minutes < 1) return isZh ? '<1 分钟' : '<1 min'
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      if (hours <= 0) return isZh ? `${rest} 分钟` : `${rest} min`
      if (rest === 0) return isZh ? `${hours} 小时` : `${hours} h`
      return isZh ? `${hours} 小时 ${rest} 分` : `${hours} h ${rest} min`
    }

    const sidebarCss = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 10px 2px',
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      },
      line: { display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' },
      label: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      value: { color: 'var(--dsw-alias-label-primary, inherit)', fontVariantNumeric: 'tabular-nums' },
      warn: { color: 'var(--dsw-alias-state-warning-primary, #b45309)', fontSize: 11 },
      select: {
        marginLeft: 'auto',
        maxWidth: 96,
        height: 20,
        padding: '0 4px',
        borderRadius: 4,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
        fontSize: 11,
      },
      meta: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      balanceButton: {
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      detail: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '4px 0 2px',
        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))',
      },
      detailRow: { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between', fontSize: 11 },
      detailKeys: { display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 10 },
      detailRoute: {
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      detailRouteOn: {
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
      },
      priceRow: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 },
      priceButton: {
        marginLeft: 'auto',
        height: 18,
        padding: '0 6px',
        borderRadius: 4,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      barWrap: { marginTop: 2 },
      track: {
        height: 4,
        borderRadius: 2,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.25))',
        overflow: 'hidden',
      },
      bar: { height: '100%', borderRadius: 2, transition: 'width 0.3s ease' },
      barText: { display: 'block', marginTop: 2, fontSize: 11 },
      error: { color: 'var(--dsw-alias-label-error, #d33)', fontSize: 11 },
    }

    function SidebarFooter() {
      const view = useSidebar()
      const [selected, setSelected] = useState('all')
      // 余额显示哪条 DeepSeek 路线（点余额行切换）
      const [balancePick, setBalancePick] = useState(null)
      // 余额明细面板（点余额行展开：各路线 + 每条路线下每把 key 的余额）
      const [showDetail, setShowDetail] = useState(false)
      // 选中的供应商记住：切页面/重启不用再选一次
      useEffect(() => {
        try {
          const saved = localStorage.getItem('balance-monitor:sidebar-provider')
          if (typeof saved === 'string' && saved.length > 0) setSelected(saved)
          const savedBalance = localStorage.getItem(BALANCE_PICK_KEY)
          if (typeof savedBalance === 'string' && savedBalance.length > 0) setBalancePick(savedBalance)
        } catch { /* 隐私模式下 localStorage 会抛，忽略 */ }
      }, [])
      const data = view.data
      if (data === null) return null

      const providers = Array.isArray(data.providers) ? data.providers : []
      const active = selected === 'all' ? null : providers.find(item => item.provider === selected) ?? null
      const total = data.total ?? {}
      const amount = active === null ? total.amount : active.amount
      const calls = active === null ? total.calls : active.calls
      const tokens = active === null ? total.tokens : active.tokens
      const hitRate = active === null ? total.hitRate : active.hitRate
      const unpriced = active === null ? total.unpriced : active.unpriced

      const onSelect = event => {
        const next = event.target.value
        setSelected(next)
        try { localStorage.setItem('balance-monitor:sidebar-provider', next) } catch { /* 同 localStorage 注释 */ }
      }

      const balance = data.balance
      // 登录 DeepSeek 账号后宿主里有两个供应商（`deepseek-official` 与 `deepseek-account`），
      // 余额是**两份不同的钱** —— 余额行点一下就切换，选择记在 localStorage。
      const balances = Array.isArray(data.balances) && data.balances.length > 0
        ? data.balances
        : (balance === null || balance === undefined ? [] : [balance])
      const shown = balances.find(item => item.provider === balancePick) ?? balance ?? balances[0] ?? null
      const pickRoute = provider => {
        setBalancePick(provider)
        try { localStorage.setItem(BALANCE_PICK_KEY, provider) } catch { /* 同 localStorage 注释 */ }
      }
      const money2 = value => formatMoney(value, shown?.currency ?? data.display?.currency, { ...data.display, decimals: 2 })
      const balanceLabel = shown === null
        ? S2.balance
        : balances.length > 1 && shown.displayName !== undefined
          ? `${S2.balance} · ${shown.displayName}`
          : S2.balance
      // 点击余额 → 展开明细：每条官方路线一行，当前路线下面再列出**每把 key**的余额
      const keyRows = Array.isArray(shown?.keys) ? shown.keys : []
      const balanceNode = balances.length === 0
        ? null
        : h('div', { style: sidebarCss.line, key: 'balance' },
            h('button', {
              type: 'button',
              style: sidebarCss.balanceButton,
              title: S2.balanceHint,
              onClick: () => setShowDetail(!showDetail),
            },
              `${balanceLabel} ${showDetail ? '▾' : '▸'}`),
            typeof shown?.amount === 'number'
              ? h('span', { style: sidebarCss.value }, money2(shown.amount))
              : h('span', { style: sidebarCss.warn, title: shown?.error ?? '' }, shown?.error ?? '—'),
            keyRows.length > 1 ? h('span', { style: sidebarCss.label }, `(${keyRows.length} 把 key)`) : null,
            shown !== null && shown.isAvailable === false && typeof shown.amount === 'number'
              ? h('span', { style: sidebarCss.warn }, S2.balanceInsufficient)
              : null)
      const detailNode = showDetail === true && balances.length > 0
        ? h('div', { style: sidebarCss.detail, key: 'balance-detail' },
            balances.map(item => h('div', { style: sidebarCss.detailRow, key: item.provider },
              h('button', {
                type: 'button',
                style: item.provider === shown?.provider ? sidebarCss.detailRouteOn : sidebarCss.detailRoute,
                onClick: () => pickRoute(item.provider),
              }, item.displayName ?? item.provider),
              typeof item.amount === 'number'
                ? formatMoney(item.amount, item.currency, { ...data.display, decimals: 2 })
                : (item.error ?? '—'))),
            keyRows.length === 0
              ? null
              : h('div', { style: sidebarCss.detailKeys },
                  h('div', { style: sidebarCss.label }, S2.balanceKeys),
                  keyRows.map(key => h('div', { style: sidebarCss.detailRow, key: key.ref },
                    h('span', { style: sidebarCss.label, title: key.ref }, key.label ?? key.ref),
                    typeof key.amount === 'number'
                      ? formatMoney(key.amount, key.currency, { ...data.display, decimals: 2 })
                      : (key.error ?? '—')))),
            keyRows.length > 0 ? null : h('div', { style: sidebarCss.label }, shown?.error ?? ''))
        : null
      const peak = data.peak
      // 用本地时钟算进度/倒计时（宿主与浏览器同机）：轮询间隔内也能给出准确的剩余量
      const nowMs = Date.now()
      let bar = null
      if (peak !== null && Number.isFinite(peak.nextAtMs)) {
        const start = Number.isFinite(peak.prevAtMs) ? peak.prevAtMs : peak.nextAtMs
        const span = peak.nextAtMs - start
        const ratio = span > 0 ? Math.min(1, Math.max(0, (nowMs - start) / span)) : 0
        const text = peak.zoneKind === 'weekend'
          ? S2.weekendAllOff
          : peak.zoneKind === 'holiday'
            ? S2.holidayAllOff
            : `${formatCountdown(peak.nextAtMs - nowMs)}${peak.inPeak ? S2.peakToOff : S2.peakToPeak}`
        bar = h('div', { style: sidebarCss.barWrap, key: 'peak' },
          h('div', { style: sidebarCss.track },
            h('div', {
              style: {
                ...sidebarCss.bar,
                width: `${Math.round(ratio * 100)}%`,
                background: peak.inPeak
                  ? 'var(--dsw-alias-state-warning-primary, #d08700)'
                  : 'var(--dsw-alias-state-success-primary, #1a7f37)',
              },
            })),
          h('span', { style: sidebarCss.barText, title: text }, text))
      }

      const metaParts = [S2.calls.replace('{n}', String(calls ?? 0))]
      if (typeof hitRate === 'number') metaParts.push(S2.hit.replace('{p}', (hitRate * 100).toFixed(1)))
      if (tokens > 0) metaParts.push(`${formatTokens(tokens)} tok`)
      if (unpriced > 0) metaParts.push(S2.unpriced.replace('{n}', String(unpriced)))

      return h('div', { style: sidebarCss.root, 'data-balance-monitor': 'sidebar' },
        balanceNode,
        detailNode,
        h('div', { style: sidebarCss.line, key: 'today' },
          h('span', { style: sidebarCss.label }, S2.today),
          h('span', { style: sidebarCss.value }, formatAmount(amount, data.display)),
          h('select', {
            style: sidebarCss.select,
            value: selected,
            'aria-label': S2.provider,
            onChange: onSelect,
          },
            h('option', { value: 'all' }, S2.all),
            providers.map(item => h('option', { key: item.provider, value: item.provider }, item.displayName ?? item.provider)))),
        h('div', { style: sidebarCss.meta, key: 'meta' }, metaParts.join(' · ')),
        bar,
        // 价格表：来源等级「站方口径」的价目由这里更新（抓 LiteLLM 镜像 / sub2api 兜底）
        h('div', { style: sidebarCss.priceRow, key: 'prices' },
          h('span', { style: sidebarCss.label },
            `${S2.prices}${data.prices?.fetchedAt ? ` · ${String(data.prices.fetchedAt).slice(5, 10)}` : data.prices?.bundled ? ` · ${S2.bundled}` : ''}`),
          h('button', {
            type: 'button',
            style: sidebarCss.priceButton,
            disabled: view.updating === true,
            title: S2.pricesHint,
            onClick: () => { void view.updatePrices() },
          }, view.updating === true ? S2.updating : S2.updatePrices)),
        view.priceMessage === null
          ? null
          : h('div', { style: view.priceFailed === true ? sidebarCss.error : sidebarCss.meta, key: 'priceMessage' }, view.priceMessage),
        view.error !== null ? h('div', { style: sidebarCss.error, key: 'error' }, view.error) : null)
    }

    // ───────────── 设置页「余额与费用」：概览 / 额度 / 用量 / 价格 / 显示 ─────────────
    // 分页结构与参照实现对齐；金额一律由宿主算好（同 /sidebar 的口径）。
    const pageCss = {
      root: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 },
      head: { display: 'flex', alignItems: 'center', gap: 8 },
      headTitle: { fontWeight: 600, fontSize: 14 },
      message: { marginLeft: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      messageBad: { marginLeft: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-error, #d64545)' },
      tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', paddingBottom: 6 },
      tab: { padding: '4px 10px', borderRadius: 6, border: 'none', background: 'transparent', color: 'inherit', fontSize: 12, cursor: 'pointer' },
      tabActive: { padding: '4px 10px', borderRadius: 6, border: 'none', background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14))', color: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
      cards: { display: 'flex', gap: 10, flexWrap: 'wrap' },
      card: { flex: '1 1 180px', minWidth: 170, border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 },
      cardTitle: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      cardValue: { fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      cardMeta: { fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      note: { fontSize: 11, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      section: { border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
      sectionTitle: { fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' },
      th: { textAlign: 'right', padding: '6px 6px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontWeight: 500, whiteSpace: 'nowrap' },
      thLeft: { textAlign: 'left', padding: '6px 6px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontWeight: 500, whiteSpace: 'nowrap' },
      td: { textAlign: 'right', padding: '6px 6px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.12))', whiteSpace: 'nowrap' },
      tdLeft: { textAlign: 'left', padding: '6px 6px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.12))', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' },
      bar: { height: 6, borderRadius: 3, background: 'rgba(128,128,128,0.2)', overflow: 'hidden' },
      btn: { height: 24, padding: '0 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'inherit', fontSize: 12, cursor: 'pointer' },
      input: { height: 24, width: 110, padding: '0 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))', background: 'transparent', color: 'inherit', fontSize: 12 },
      trend: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 60 },
    }

    const SOURCE_LABEL = {
      official: S.srcOfficial, station: S.srcStation, manual: S.srcManual,
      reseller: S.srcReseller, aggregator: S.srcAggregator, unknown: S.srcUnknown,
    }

    const report = {
      data: null,
      error: null,
      tab: 'overview',
      busy: false,
      message: null,
      failed: false,
      listeners: new Set(),
      inflight: null,
      emit() { for (const fn of this.listeners) fn() },
      async load() {
        if (this.inflight !== null) return this.inflight
        this.inflight = (async () => {
          try {
            const response = await fetch(`${ROUTE}/report`, { headers: { accept: 'application/json' } })
            const payload = await response.json().catch(() => null)
            if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
            this.data = payload.data
            this.error = null
          } catch (error) {
            this.error = String(error?.message ?? error)
          } finally {
            this.inflight = null
            this.emit()
          }
        })()
        return this.inflight
      },
      setTab(tab) { this.tab = tab; this.emit() },
      async post(path, body) {
        const response = await fetch(`${ROUTE}${path}`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload.data
      },
      /** 保存配置：白名单键（display / budget / priceSources），宿主会回传新指纹。 */
      async saveConfig(patch) {
        if (this.busy) return
        this.busy = true
        this.message = isZh ? '保存中…' : 'Saving…'
        this.failed = false
        this.emit()
        try {
          const data = await this.post('/config', patch)
          this.message = `${isZh ? '已保存' : 'Saved'} · ${S.basis} ${data?.basisId ?? ''}`
          await this.load()
        } catch (error) {
          this.failed = true
          this.message = `${isZh ? '保存失败：' : 'Save failed: '}${String(error?.message ?? error)}`
        } finally {
          this.busy = false
          this.emit()
        }
      },
      async action(path, label, body) {
        if (this.busy) return
        this.busy = true
        this.message = label
        this.failed = false
        this.emit()
        try {
          await this.post(path, body)
          this.message = isZh ? '完成' : 'Done'
          await this.load()
        } catch (error) {
          this.failed = true
          this.message = String(error?.message ?? error)
        } finally {
          this.busy = false
          this.emit()
        }
      },
    }

    const useReport = () => {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump(value => value + 1)
        report.listeners.add(listener)
        void report.load()
        return () => { report.listeners.delete(listener) }
      }, [])
      return report
    }

    const monthDay = value => (typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : '—')

    function CostCard({ title, amount, meta }) {
      return h('div', { style: pageCss.card },
        h('div', { style: pageCss.cardTitle }, title),
        h('div', { style: pageCss.cardValue }, amount),
        h('div', { style: pageCss.cardMeta }, meta))
    }

    function tokenLine(tokens, calls) {
      const list = tokens ?? {}
      return `${S.callsCount} ${calls} ${S.times} · ${S.inputTok} ${formatTokens(list.input)} · ${S.cacheTok} ${formatTokens(list.cacheRead)} · ${S.outputTok} ${formatTokens(list.output)}`
    }

    function OverviewTab({ data, view }) {
      const today = data?.totals?.today
      const month = data?.totals?.month
      const all = data?.totals?.all
      const display = data?.display
      const budget = data?.budget
      const [amount, setAmount] = useState('')
      const [keyRef, setKeyRef] = useState('')
      // 候选引用名：宿主用 credentials.describe() 探测（只报名字，不读值）
      const keyCandidates = data?.keyCandidates ?? {}
      const discovered = Array.isArray(keyCandidates.candidates) ? keyCandidates.candidates : []
      const [period, setPeriod] = useState('month')
      const drafted = amount !== ''
      const effectiveAmount = drafted
        ? (amount.trim() === '' ? null : Number(amount))
        : (budget?.amount ?? null)
      // 宿主算好的占比直接用（同币种）；用户正在改额度时按草稿预览
      const ratio = budget?.enabled !== true
        ? null
        : drafted
          ? (Number.isFinite(effectiveAmount) && effectiveAmount > 0 ? (budget?.usedAmount ?? 0) / effectiveAmount : null)
          : (budget?.ratio ?? null)
      return h('div', { style: pageCss.root, key: 'overview' },
        h('div', { style: pageCss.cards },
          h(CostCard, { title: S.todayCost, amount: formatAmount(today?.amount, display), meta: tokenLine(today?.tokens, today?.calls) }),
          h(CostCard, { title: S.monthCost, amount: formatAmount(month?.amount, display), meta: tokenLine(month?.tokens, month?.calls) }),
          h(CostCard, {
            title: S.allCost,
            amount: formatAmount(all?.amount, display),
            meta: `${all?.since === null || all?.since === undefined ? '' : `${S.since} ${all.since} · `}${S.callsCount} ${all?.calls ?? 0} ${S.times}`,
          })),
        h('div', { style: pageCss.note }, S.costNote),
        (today?.unpriced ?? 0) > 0 || (month?.unpriced ?? 0) > 0
          ? h('div', { style: pageCss.note }, `${S.unpricedNote(today?.unpriced ?? 0)} · ${S.unpricedMonth(month?.unpriced ?? 0)}`)
          : null,

        h('div', { style: pageCss.section, key: 'sessions' },
          h('div', { style: pageCss.sectionTitle }, S.todaySessions),
          (data?.sessions ?? []).length === 0
            ? h('div', { style: pageCss.note }, S.noSessions)
            : h('table', { style: pageCss.table },
                h('thead', null, h('tr', null,
                  h('th', { style: pageCss.thLeft }, S.session),
                  h('th', { style: pageCss.th }, S.callsCount),
                  h('th', { style: pageCss.th }, S.inputTok),
                  h('th', { style: pageCss.th }, S.cacheTok),
                  h('th', { style: pageCss.th }, S.outputTok),
                  h('th', { style: pageCss.th }, S.hitRate),
                  h('th', { style: pageCss.th }, S.cost))),
                h('tbody', null, (data?.sessions ?? []).map(row => h('tr', { key: row.sessionId },
                  h('td', { style: pageCss.tdLeft, title: row.sessionId }, String(row.sessionId).slice(0, 14)),
                  h('td', { style: pageCss.td }, row.calls),
                  h('td', { style: pageCss.td }, formatTokens(row.tokens.input)),
                  h('td', { style: pageCss.td }, formatTokens(row.tokens.cacheRead)),
                  h('td', { style: pageCss.td }, formatTokens(row.tokens.output)),
                  h('td', { style: pageCss.td }, row.hitRate === null ? '—' : `${(row.hitRate * 100).toFixed(1)}%`),
                  h('td', { style: pageCss.td }, row.priced === 0
                    ? '—'
                    : `${formatAmount(row.usd, display)}${row.unpriced > 0 ? ` +${row.unpriced}` : ''}`)))))),

        h('div', { style: pageCss.section, key: 'budget' },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.budget),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: budget?.enabled === true,
                onChange: event => { void view.saveConfig({ budget: { enabled: event.target.checked } }) },
              }),
              S.enableBudget),
            h('span', { style: pageCss.note }, S.budgetAmount),
            h('input', {
              style: pageCss.input,
              type: 'number',
              min: '0',
              step: '0.01',
              placeholder: budget?.amount === null || budget?.amount === undefined ? '' : String(budget.amount),
              value: amount,
              onChange: event => setAmount(event.target.value),
            }),
            h('select', {
              style: pageCss.input,
              value: budget?.period ?? period,
              onChange: event => { setPeriod(event.target.value); void view.saveConfig({ budget: { period: event.target.value } }) },
            },
              h('option', { value: 'today' }, S.periodToday),
              h('option', { value: 'month' }, S.periodMonth),
              h('option', { value: 'all' }, S.periodAll)),
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true,
              onClick: () => { void view.saveConfig({ budget: { amount: effectiveAmount } }) },
            }, S.save)),
          h('div', { style: pageCss.bar },
            h('div', {
              style: {
                ...pageCss.bar,
                height: '100%',
                width: `${Math.max(0, Math.min(100, (ratio ?? 0) * 100)).toFixed(1)}%`,
                background: ratio !== null && ratio >= 1
                  ? 'var(--dsw-alias-label-error, #d64545)'
                  : 'var(--dsw-alias-brand-primary, #4b7bec)',
              },
            })),
          h('div', { style: pageCss.note },
            budget?.enabled !== true
              ? S.budgetOff
              : ratio === null
                ? S.budgetNoAmount
                : `${S.used} ${formatAmount(budget.usedAmount, display)} / ${formatAmount(effectiveAmount, display)} · ${(ratio * 100).toFixed(1)}%${ratio >= 1 ? ` · ${S.overBudget}` : ratio >= 0.8 ? ` · ${S.nearBudget}` : ''}`)),

        h('div', { style: pageCss.section, key: 'official' },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.officialBalance),
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true,
              onClick: () => { void view.action('/balance/refresh', isZh ? '刷新中…' : 'Refreshing…') },
            }, S.refresh)),
          // 两条 DeepSeek 路线（API Key / 账号）是两个不同的钱包，逐条列出
          (data?.balances ?? []).length === 0
            ? h('div', { style: pageCss.note }, S.balanceUnavailable)
            : (data.balances ?? []).map(item => h('div', { style: pageCss.row, key: item.provider },
                h('span', { style: pageCss.cardTitle }, item.displayName ?? item.provider),
                typeof item.amount === 'number'
                  ? `　${S.total} ${formatMoney(item.amount, item.currency, display)} · ${S.granted} ${formatMoney(item.granted ?? 0, item.currency, display)} · ${S.toppedUp} ${formatMoney(item.toppedUp ?? 0, item.currency, display)}`
                  : `　${item.error ?? '—'}`,
                item.updatedAt === undefined || item.updatedAt === null
                  ? null
                  : h('span', { style: pageCss.note }, `· ${S.updatedAt} ${String(item.updatedAt).slice(11, 19)}`),
                item.source === null || item.source === undefined
                  ? null
                  : h('span', { style: pageCss.note }, `· ${S.balanceSource[item.source] ?? item.source}`))),
          h('div', { style: pageCss.note }, S.balanceHint),
          // 多把 key：逐条列出（总额是它们之和）；候选来自宿主的 describe() 探测（不读值）
          h('div', { style: pageCss.row },
            h('span', { style: pageCss.cardTitle }, S.balanceKeysRow),
            discovered.length > 0
              ? h('select', {
                  style: { ...pageCss.input, width: 200 },
                  value: keyRef,
                  onChange: event => setKeyRef(event.target.value),
                },
                  h('option', { value: '' }, S.pickDiscovered),
                  discovered.map(ref => h('option', { key: ref, value: ref }, ref)))
              : h('input', {
                  style: { ...pageCss.input, width: 200 },
                  placeholder: 'DEEPSEEK_API_KEY_2',
                  value: keyRef,
                  onChange: event => setKeyRef(event.target.value),
                }),
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true || keyRef.trim() === '',
              onClick: () => {
                const refs = (data?.balances ?? []).find(item => item.kind === 'api-key')?.keys ?? []
                const next = [...refs.map(item => item.ref), keyRef.trim()]
                setKeyRef('')
                void view.saveConfig({ deepseekKeys: next })
              },
            }, S.addKey)),
          h('div', { style: pageCss.note },
            ((data?.balances ?? []).find(item => item.kind === 'api-key')?.keys ?? []).length > 1
              ? S.balanceSumHint
              : S.balanceKeysHint),
          // 探测结果：只报「扫了哪些名字、命中了哪些」，不碰值
          h('div', { style: pageCss.note }, keyCandidates.supported === false
            ? S.discoveryUnsupported
            : `${S.discoveryScanned(keyCandidates.scanned?.length ?? 0)} · ${S.discoveryFound((keyCandidates.foundRefs ?? []).join(', ') || '—')}`)),
        h('div', { style: pageCss.note }, `${S.tabIn} ${data?.display?.currency ?? 'CNY'} · ${S.basis} ${data?.prices?.basisId ?? '—'} · ${S.peakNow} ${S.peakText}`))
    }

    function QuotaTab({ data }) {
      const display = data?.display
      return h('div', { style: pageCss.root, key: 'quota' },
        h('div', { style: pageCss.note }, S.quotaHint),
        h('table', { style: pageCss.table },
          h('thead', null, h('tr', null,
            h('th', { style: pageCss.thLeft }, S.provider),
            h('th', { style: pageCss.thLeft }, S.type),
            h('th', { style: pageCss.th }, S.status),
            h('th', { style: pageCss.th }, S.rate),
            h('th', { style: pageCss.th }, S.plan),
            h('th', { style: pageCss.th }, S.models),
            h('th', { style: pageCss.th }, S.cost),
            h('th', { style: pageCss.thLeft }, S.remark))),
          h('tbody', null, (data?.quotas ?? []).map(row => {
            const api = row.sub2api ?? {}
            const billing = api.billing ?? null
            const quota = api.balance ?? api.quota?.remaining ?? api.subscription?.balance ?? null
            const remark = [
              quota === null || quota === undefined ? null : `${S.balance} ${formatMoney(Number(quota), api.unit ?? null, display)}`,
              api.planName === undefined || api.planName === null ? null : `${S.plan} ${api.planName}`,
              api.expiresAt === undefined || api.expiresAt === null ? null : `${S.expiresAt} ${monthDay(String(api.expiresAt))}`,
              row.error ?? null,
            ].filter(Boolean).join(' · ')
            const rate = api.rate?.effective ?? api.rate?.resolved ?? api.rate?.group
            return h('tr', { key: row.provider },
              h('td', { style: pageCss.tdLeft }, row.displayName ?? row.provider),
              h('td', { style: pageCss.tdLeft }, row.type ?? '—'),
              h('td', { style: pageCss.td }, row.status ?? '—'),
              h('td', { style: pageCss.td }, typeof rate === 'number' ? `×${rate}` : '—'),
              h('td', { style: pageCss.td }, billing?.peak?.enabled === true ? S.peakYes : S.peakNo),
              h('td', { style: pageCss.td }, api.modelCount ?? 0),
              h('td', { style: pageCss.td }, (row.priced ?? 0) === 0 && (row.unpriced ?? 0) > 0 ? '—' : formatAmount(row.amount, display)),
              h('td', { style: pageCss.tdLeft, title: remark }, remark === '' ? '—' : remark))
          }))),
        h('div', { style: pageCss.note }, S.quotaNote))
    }

    function UsageTab({ data }) {
      const display = data?.display
      const all = data?.totals?.all ?? {}
      const tokens = all.tokens ?? {}
      const trend = data?.trend ?? []
      const peak = Math.max(0, ...trend.map(row => row.usd ?? 0))
      return h('div', { style: pageCss.root, key: 'usage' },
        h('div', { style: pageCss.cards },
          h(CostCard, { title: S.inputTok, amount: formatTokens(tokens.input), meta: `${S.cacheTok} ${formatTokens(tokens.cacheRead)} · ${S.cacheWriteTok} ${formatTokens(tokens.cacheWrite)}` }),
          h(CostCard, { title: S.outputTok, amount: formatTokens(tokens.output), meta: `${S.reasoningTok} ${formatTokens(tokens.reasoning)}（并入输出计费）` }),
          h(CostCard, { title: S.hitRate, amount: all.hitRate === null || all.hitRate === undefined ? '—' : `${(all.hitRate * 100).toFixed(1)}%`, meta: `${S.callsCount} ${all.calls ?? 0} ${S.times} · ${S.days} ${all.days ?? 0}` })),
        h('div', { style: pageCss.section, key: 'trend' },
          h('div', { style: pageCss.sectionTitle }, S.trendTitle(trend.length)),
          h('div', { style: pageCss.trend }, trend.map(row => h('div', {
            key: row.date,
            title: `${row.date} · ${formatAmount(row.amount, display)} · ${row.calls} ${S.times}`,
            style: {
              flex: '1 1 0',
              height: `${peak <= 0 ? 2 : Math.max(2, (row.usd / peak) * 100)}%`,
              background: 'var(--dsw-alias-brand-primary, #4b7bec)',
              borderRadius: 2,
            },
          })))),
        h('div', { style: pageCss.section, key: 'models' },
          h('div', { style: pageCss.sectionTitle }, S.modelToday),
          (data?.models ?? []).length === 0
            ? h('div', { style: pageCss.note }, S.noSessions)
            : h('table', { style: pageCss.table },
                h('thead', null, h('tr', null,
                  h('th', { style: pageCss.thLeft }, S.model),
                  h('th', { style: pageCss.thLeft }, S.provider),
                  h('th', { style: pageCss.th }, S.callsCount),
                  h('th', { style: pageCss.th }, S.inputTok),
                  h('th', { style: pageCss.th }, S.cacheTok),
                  h('th', { style: pageCss.th }, S.outputTok),
                  h('th', { style: pageCss.th }, S.cost))),
                h('tbody', null, (data?.models ?? []).map(row => h('tr', { key: `${row.provider}/${row.model}` },
                  h('td', { style: pageCss.tdLeft }, row.model),
                  h('td', { style: pageCss.tdLeft }, row.provider ?? '—'),
                  h('td', { style: pageCss.td }, row.calls),
                  h('td', { style: pageCss.td }, formatTokens(row.tokens.input)),
                  h('td', { style: pageCss.td }, formatTokens(row.tokens.cacheRead)),
                  h('td', { style: pageCss.td }, formatTokens(row.tokens.output)),
                  h('td', { style: pageCss.td }, row.priced === 0 ? '—' : formatAmount(row.usd, display))))))))
    }

    function PricesTab({ data, view }) {
      const prices = data?.prices ?? {}
      const breakdown = prices.breakdown ?? {}
      const sources = prices.sources ?? []
      const [draft, setDraft] = useState(null)
      const current = draft ?? sources
      const toggle = source => {
        const next = current.includes(source) ? current.filter(item => item !== source) : [...current, source]
        setDraft(next)
      }
      return h('div', { style: pageCss.root, key: 'prices' },
        h('div', { style: pageCss.row },
          h('div', { style: pageCss.sectionTitle }, S.priceBasis),
          h('button', {
            type: 'button',
            style: pageCss.btn,
            disabled: view.busy === true,
            onClick: () => { void view.action('/prices/update', isZh ? '抓取价目中…' : 'Fetching prices…') },
          }, S.updatePrices),
          h('span', { style: pageCss.note }, `${S.lastUpdate} ${monthDay(prices.meta?.fetchedAt)} · ${prices.meta?.accepted ?? '—'} ${S.modelsUnit} · ${prices.meta?.sourceKind ?? '—'}${prices.meta?.bundled === true ? ` · ${S.bundled}` : ''}`)),
        h('div', { style: { ...pageCss.section, gap: 6 } },
          h('div', { style: pageCss.sectionTitle }, S.allowedSources),
          h('div', { style: pageCss.row }, Object.entries(SOURCE_LABEL).map(([source, label]) => h('label', { key: source, style: pageCss.row },
            h('input', { type: 'checkbox', checked: current.includes(source), onChange: () => toggle(source) }),
            `${label}（${breakdown[source] ?? 0}）`))),
          h('div', { style: pageCss.row },
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true || draft === null,
              onClick: () => { void view.saveConfig({ priceSources: current }) },
            }, S.save),
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true,
              onClick: () => { void view.saveConfig({ priceSources: [S.srcOfficialCode, S.srcStationCode, S.srcManualCode] }) },
            }, S.recommended)),
          h('div', { style: pageCss.note }, S.sourceHint)),
        h('table', { style: pageCss.table },
          h('thead', null, h('tr', null,
            h('th', { style: pageCss.thLeft }, S.sourceLevel),
            h('th', { style: pageCss.th }, S.entries),
            h('th', { style: pageCss.thLeft }, S.explain))),
          h('tbody', null, Object.entries(SOURCE_LABEL).map(([source, label]) => h('tr', { key: source },
            h('td', { style: pageCss.tdLeft }, label),
            h('td', { style: pageCss.td }, breakdown[source] ?? 0),
            h('td', { style: pageCss.tdLeft }, S.sourceExplain[source] ?? ''))))),
        h('div', { style: pageCss.note }, `${S.attribution}：${prices.attribution ?? '—'}`),
        prices.meta?.sourceUrl === undefined || prices.meta?.sourceUrl === null
          ? null
          : h('div', { style: pageCss.note }, `${S.sourceUrlLabel} ${prices.meta.sourceUrl}`))
    }

    function DisplayTab({ data, view }) {
      const display = data?.display ?? {}
      // 保留期由宿主算好送来（`data.retention` 总是存在）；这里的数字只是老宿主兜底。
      const retention = data?.retention ?? { ledgerDays: 7, rollupDays: 400 }
      const [rawDraft, setDraft] = useState(null)
      // 两份编辑态放进**同一个** draft（`display` / `retention` 各自可为 null）。
      // 非对象一律当「没在编辑」：宿主切分页会重建这个组件，状态形状不该被
      // 上一个分页留下的值污染（拿到垃圾就当没改过，回落到宿主送来的值）。
      const draft = rawDraft !== null && typeof rawDraft === 'object' ? rawDraft : {}
      const displayDraft = draft.display ?? null
      const retentionDraft = draft.retention ?? null
      const current = displayDraft ?? {
        currency: display.currency ?? 'CNY',
        symbol: display.symbol ?? '¥',
        decimals: display.decimals ?? 4,
        exchangeRate: display.exchangeRate ?? 7.2,
      }
      const currentRetention = retentionDraft ?? {
        ledgerDays: retention.ledgerDays ?? 7,
        rollupDays: retention.rollupDays ?? 400,
      }
      const patch = (key, value) => setDraft({ ...draft, display: { ...current, [key]: value } })
      const patchRetention = (key, value) => setDraft({ ...draft, retention: { ...currentRetention, [key]: value } })
      return h('div', { style: pageCss.root, key: 'display' },
        h('div', { style: { ...pageCss.section, gap: 8 } },
          h('div', { style: pageCss.row },
            S.currency, h('input', { style: pageCss.input, value: current.currency, onChange: event => patch('currency', event.target.value) }),
            S.symbol, h('input', { style: pageCss.input, value: current.symbol, onChange: event => patch('symbol', event.target.value) }),
            S.decimals, h('input', { style: pageCss.input, type: 'number', min: '0', max: '8', value: current.decimals, onChange: event => patch('decimals', Number(event.target.value)) }),
            S.exchangeRate, h('input', { style: pageCss.input, type: 'number', min: '0', step: '0.01', value: current.exchangeRate, onChange: event => patch('exchangeRate', Number(event.target.value)) })),
          h('div', { style: pageCss.row },
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true,
              onClick: () => { void view.saveConfig({ display: current }) },
            }, S.save),
            displayDraft === null ? null : h('button', { type: 'button', style: pageCss.btn, onClick: () => setDraft({ ...draft, display: null }) }, S.reset)),
          h('div', { style: pageCss.note }, S.displayHint)),
        h('div', { style: pageCss.section, gap: 8 },
          h('div', { style: pageCss.row },
            S.retention,
            S.ledgerDays, h('input', {
              style: pageCss.input,
              type: 'number',
              min: '1',
              max: '3650',
              value: currentRetention.ledgerDays,
              onChange: event => patchRetention('ledgerDays', Number(event.target.value)),
            }),
            S.rollupDays, h('input', {
              style: pageCss.input,
              type: 'number',
              min: '1',
              max: '3650',
              value: currentRetention.rollupDays,
              onChange: event => patchRetention('rollupDays', Number(event.target.value)),
            })),
          h('div', { style: pageCss.row },
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true,
              // 单独一个按钮：保留期**不进**计价指纹，别和「显示」一起提交
              onClick: () => { void view.saveConfig({ retention: currentRetention }) },
            }, S.saveRetention),
            retentionDraft === null ? null : h('button', { type: 'button', style: pageCss.btn, onClick: () => setDraft({ ...draft, retention: null }) }, S.reset)),
          h('div', { style: pageCss.note }, S.retentionHint)),
        h('div', { style: pageCss.note }, S.displayHint2))
    }

    function CostPage() {
      const view = useReport()
      const data = view.data
      const tabs = [
        ['overview', S.tabOverview],
        ['quota', S.tabQuota],
        ['usage', S.tabUsage],
        ['prices', S.tabPrices],
        ['display', S.tabDisplay],
      ]
      const body = view.error !== null
        ? h('div', { style: pageCss.note }, `${S.loadFailed}：${view.error}`)
        : data === null
          ? h('div', { style: pageCss.note }, S.loading)
          : view.tab === 'quota' ? h(QuotaTab, { data })
            : view.tab === 'usage' ? h(UsageTab, { data })
              : view.tab === 'prices' ? h(PricesTab, { data, view })
                : view.tab === 'display' ? h(DisplayTab, { data, view })
                  : h(OverviewTab, { data, view })
      return h('div', { style: pageCss.root },
        h('div', { style: pageCss.head },
          h('div', { style: pageCss.headTitle }, S.sectionLabel),
          h('button', {
            type: 'button',
            style: pageCss.btn,
            disabled: view.busy === true,
            onClick: () => { void view.load() },
          }, view.busy === true ? S.refreshing : S.refresh),
          view.message === null
            ? null
            : h('span', { style: view.failed === true ? pageCss.messageBad : pageCss.message }, view.message)),
        h('div', { style: pageCss.tabs }, tabs.map(([key, label]) => h('button', {
          key,
          type: 'button',
          style: view.tab === key ? pageCss.tabActive : pageCss.tab,
          onClick: () => view.setTab(key),
        }, label))),
        body)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 三个 settingsNs 都是 Loader entry id（上游 `dsh-base/cordis.patch.yml` 里就是这么命名的）：
        //   llm-pi-ai               → 所有中转站路由（含手工声明的）
        //   llm-deepseek            → DeepSeek 官方 API Key 路由
        //   llm-deepseek-account    → DeepSeek 账号登录路由
        // 槽位按 `options.key === entryKey(=settingsNs)` 严格匹配，多注册一个键不会互相干扰。
        for (const key of ['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account']) {
          ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
            name: 'settings.models.provider-card',
            id: `balance-monitor:${key}`,
            key,
            order: 60,
          }, BalanceCard))
        }
        ctx.effect(() => () => { store.listeners.clear() }, 'balance-monitor: client store')

        // 侧栏底部：余额 / 今日 / 峰谷倒计时条。
        // order 取 10：排在参照实现（侧栏 order 0/1）之后，不抢它的位置。
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'balance-monitor:sidebar',
          order: 10,
        }, SidebarFooter))
        ctx.effect(() => () => { sidebar.listeners.clear() }, 'balance-monitor: sidebar store')

        // 设置页「余额与费用」：概览 / 额度 / 用量 / 价格 / 显示。
        // order 取 32：排在参照实现（设置页 order 30/31）之后，不抢它的导航位置。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'balance-monitor:cost',
          order: 32,
          label: S.sectionLabel,
        }, CostPage))
        ctx.effect(() => () => { report.listeners.clear() }, 'balance-monitor: report store')
      },
    }
  },
})
