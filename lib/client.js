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
 *   GET    /plugins/dsh-balance-monitor/state
 *   GET    /plugins/dsh-balance-monitor/sidebar
 *   GET    /plugins/dsh-balance-monitor/report
 *   POST   /plugins/dsh-balance-monitor/config      { display?, budget?, retention?, peakNotify?,
 *                                                     priceSources?, officialPeak?,
 *                                                     scanCredentialsFile?, deepseekKeyPrefixes?,
 *                                                     deepseekKeyMaxIndex?, deepseekKeys?,
 *                                                     allowedHosts? }
 *   POST   /plugins/dsh-balance-monitor/balance/refresh
 *   POST   /plugins/dsh-balance-monitor/prices/update
 *   POST   /plugins/dsh-balance-monitor/type        { provider, type }
 *   POST   /plugins/dsh-balance-monitor/refresh     { provider }
 *   POST   /plugins/dsh-balance-monitor/vision/auto { provider, enabled }
 *   POST   /plugins/dsh-balance-monitor/vision/apply { provider? }
 *   GET    /plugins/dsh-balance-monitor/keys?provider=<id>          → 引用名 + 配没配（不含值）
 *   PUT    /plugins/dsh-balance-monitor/keys        { provider, value, ref?, label? }
 *   DELETE /plugins/dsh-balance-monitor/keys        { provider, ref }
 *   POST   /plugins/dsh-balance-monitor/keys/reveal { provider, ref } → 明文（点小眼睛才调）
 *
 * 状态变更路由（POST/PUT/DELETE）在宿主侧有跨站拦截面（Sec-Fetch-Site / Origin /
 * content-type），所以本文件所有写请求都带 `content-type: application/json`。
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
    /** 上一次看到的峰谷档位（`peak` / `off`）：跨过切换点才提醒一次。 */
    const PEAK_STATE_KEY = 'balance-monitor:peak-state'
    /** 已经「提前提醒」过的切换点时刻：同一个切换点只提前喊一次。 */
    const PEAK_LEAD_KEY = 'balance-monitor:peak-lead-at'
    /** 模型花费卡片的展开状态（「记住展开状态」打开时用它）。 */
    const CARD_OPEN_KEY = 'balance-monitor:model-card-open'
    /** 清空历史的确认串（与宿主约定的那个，写错一个字宿主会拒绝）。 */
    const HISTORY_CLEAR_TOKEN = 'clear-all-history'
    /**
     * 只对**刚发生**的切换点提醒：轮询 30s，所以留 3 倍余量（90s）。
     * 页面关着跨过的切换点（比如隔夜回来）只记不报 —— 提醒几小时前的换档是噪音。
     */
    const PEAK_REMINDER_FRESH_MS = 90_000
    /** 高峰窗口条数上限（宿主侧上限 48，这里留足余量并对用户可见，避免静默截断）。 */
    const PEAK_WINDOW_MAX = 24

    /**
     * 语言：`auto`（跟随浏览器）/ `zh` / `en`。取值来自宿主配置（`ui.locale`），
     * 改动后**整表重建** S / S2 并让三个 store 重新广播 —— 所有已挂载的卡片立刻换语言。
     */
    const LOCALE_AUTO = 'auto'
    const browserIsZh = () => {
      try {
        return String(navigator.language ?? '').toLowerCase().startsWith('zh')
      } catch {
        return true
      }
    }
    let localeMode = LOCALE_AUTO
    let isZh = browserIsZh()
    /** 三个 store（卡片 / 侧栏 / 设置页）：切语言时一起广播，别让某块停在旧文案上。 */
    const storeRegistry = new Set()
    const normalizeLocale = value => (value === 'zh' || value === 'en' ? value : LOCALE_AUTO)
    const resolveIsZh = mode => (mode === 'zh' ? true : mode === 'en' ? false : browserIsZh())

    const buildS = zh => zh
      ? {
          type: '供应商类型',
          other: '其他',
          sub2api: 'Sub2Api',
          workbuddy: 'WorkBuddy（积分）',
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
          mismatchFactor: '实扣 ≈ 按倍率算的 {factor} 倍（{direction} {percent}%）',
          mismatchHigher: '高',
          mismatchLower: '低',
          mismatchUnity: '倍率接口报的是 1，多半不是「官方价 × 倍率」这条公式',
          mismatchSpread: '逐模型反推倍率 {min}–{max}（{n} 个模型），站方按模型逐个定价',
          mismatchKeep: '仍以接口倍率为准，反推值只用来解释差异',
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
          creditsTodayCard: '积分（今日）',
          creditsSiteCard: '站方全量',
          creditsFilterCard: '按调用来源',
          creditsFilterHint: '面板对 UA / 来源 IP 做**包含**匹配；留空即回落默认 UA（deepseek-harness）。留空时读到的会是站长整个账号池（含所有买家）的量。',
          creditsModelsCard: '带倍率模型',
          creditsUnknownCard: '无积分记录',
          creditsTruncatedCard: '归档只取最近 1000 条，可能漏数',
          creditsNoPanel: '面板读不到（没权限 / 版本不同）：类型判定照常，只是没有消耗数据。',
          officialRoute: '官方路线：没有供应商类型，余额按官方接口查。',
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
          keyEmpty: '这个供应商还没有可用的密钥引用（宿主按供应商过滤后为空）。在下面填一把新 key，或到「余额与费用 → 概览」把已有引用加进来。',
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
          peakNotify: '峰谷提醒',
          notifyInApp: '应用内提醒',
          notifySystem: '系统通知',
          notifyHint: '跨过高峰 / 平价切换点时提醒一次；**提前量**则是在切换前就提醒（同一个切换点只提醒一次）。'
            + '判定跟着侧栏轮询走（最多晚一个轮询周期）；首次运行只记录不提醒。'
            + '系统通知要在浏览器里授权，被拒后应用内提醒照旧。',
          notifyLead: '提前提醒（分钟，1–30）',
          notifyLeadBad: '提前量要在 1–30 分钟之间',
          notifyType: '提醒类型',
          notifyTypeBoth: '进峰与进谷都提醒',
          notifyTypePeak: '只提醒进入峰',
          notifyTypeOff: '只提醒进入谷',
          notifyPosition: '弹窗位置',
          notifyPositionCorner: '右下角',
          notifyPositionCenter: '屏幕中心',
          previewPeak: '预览进入峰',
          previewOff: '预览进入谷',
          previewHint: '用真实组件渲染一次：文案 / 位置 / 系统通知与实际触发完全一致，不用等下一次换档。',
          saveNotifyLead: '保存提前量',
          retentionHint: '明细供「今日会话 / 按模型」用，日汇总供「本月 / 累计」用（上限 3650 天）。'
            + '调小会**立刻**删掉超期数据且不可恢复；日汇总不会短于明细。',
          keyDiscovery: '密钥扫描',
          scanCredentialsFile: '读凭据文件的引用名',
          scanHint: '只读 `~/.dsh/.credentials.yaml` 里 `refs:` 段的**键名**（不读值），命名再怪也能列全；'
            + '关掉就退回按候选名逐个探测。',
          keyPrefixes: '候选前缀',
          keyMaxIndex: '序号上限',
          keyPrefixesHint: '前缀按逗号分隔，会展开成「前缀」+「前缀_2 … 前缀_N」（上限 1–50）。',
          saveDiscovery: '保存扫描设置',
          accessControl: '访问控制',
          allowedHosts: '额外允许的主机名',
          allowedHostsHint: '默认只接受回环地址（127.0.0.1 / localhost / [::1]）—— 这是防 DNS rebinding 的那道闸。'
            + '通过反向代理 / 自定义域名 / 局域网 IP 访问宿主时，把主机名填在这里（逗号分隔，可带端口）。',
          saveHosts: '保存白名单',
          allowedHostsBad: '主机名不合法：只允许字母 / 数字 / 点 / 横线 / 下划线，可带端口，IPv6 用 [..]',
          uiSection: '界面',
          localeLabel: '界面语言',
          localeAuto: '跟随浏览器',
          localeZh: '简体中文',
          localeEn: 'English',
          refreshSecondsLabel: '侧栏刷新间隔（秒）',
          refreshSecondsHint: '10–60 秒。只影响侧栏数据轮询，不影响记账与金额口径。',
          saveRefreshSeconds: '保存间隔',
          refreshSecondsBad: '间隔要在 10–60 秒之间',
          hideOfficialBalance: '隐藏官方余额',
          hideTodayCost: '隐藏今日消耗',
          hideHint: '开启后对应区块整体不渲染（共享屏幕 / 截图防泄露）。「隐藏官方余额」只收掉余额；'
            + '「隐藏今日消耗」收掉概览的今日费用卡片、侧栏的今日金额行、默认周期为「今日」的模型花费卡片，'
            + '以及额度横条 / 右下角角标里的今日金额 —— 峰谷档位、余额、token 与调用次数统计都不受影响。',
          showSessionId: '会话明细显示完整会话 ID',
          showSessionIdHint: '默认只显示前 14 位；打开后便于去日志里对。',
          sidebarTools: '侧栏显示峰谷表 / 价格表',
          sidebarToolsHint: '默认不显示：价格表更新在「价格」页，「峰谷表」在本页「官方峰谷」下面。'
            + '打开后侧栏底部才会多出这两行（含「价目已更新」结果行）。',
          peakConfigTitle: '官方峰谷',
          peakEnabled: '启用峰谷档',
          peakWindows: '高峰窗口（UTC 小时）',
          peakHolidays: '假期（北京日期）',
          peakWindowsBad: '窗口格式不对：应为 `1-4,6-10`（UTC 小时，0–23，逗号分隔，最多 24 条；'
            + '起止不能相同，要跨午夜写 `22-2`）',
          savePeak: '保存峰谷',
          peakSchedule: '峰谷表',
          peakScheduleHint: '接下来 6 个档位切换点（北京时间窗口，按本地时区显示）；只影响之后的调用计价',
          peakScheduleEmpty: '峰谷没有开启（或算不出切换点）',
          heatTitle: 'Token 用量统计',
          heatSummary: (weeks, tokensText, calls) => `近 ${weeks} 周 ${tokensText} tokens · ${calls} 次调用（按日汇总，超出账本明细保留期也能看到）`,
          heatLegend: '颜色由浅到深 = 当日 token 量由少到多；鼠标悬停看当天明细。',
          modelStatsTitle: '按模型统计（token 与费用）',
          modelStatsToday: '今日',
          modelStatsHistory: '全部历史',
          modelStatsRank: '排行依据：',
          rankCost: '费用',
          rankTokens: 'Token',
          rankHit: '命中率',
          rankPerUsd: '每美元 token',
          modelStatsEmpty: '这个区间没有数据',
          modelStatsScope: (since, days, total) => `${since} 起 · ${days} 天有记录 · ${total} 个模型`,
          modelStatsGap: days => `其中 ${days} 天是 0.8.0 之前写入的，没有按模型明细（只计入总额）`,
          modelStatsUnpriced: count => `${count} 次未定价`,
          historySection: '历史数据',
          historyHint: '每次调用的依据（价表 / 倍率 / 峰谷档）在**入账时就冻结**了，所以导入与清除都不会重算历史金额 —— '
            + '改价只影响之后的调用。清除会同时清掉明细（ledger.json）与日汇总（days.json），**不可恢复**。',
          historyImport: '导入安装前历史',
          historyClear: '清除全部历史',
          historyClearConfirm: '再点一次确认清空',
          historyClearCancel: '取消',
          /**
           * 清空结果：宿主会带上 `writeFailed`（落盘失败的原因）。**落盘失败必须如实说** ——
           * 内存确实清了，但磁盘上还是旧数据，下次启动历史会「回来」；
           * 只说「已清空」就是把假象当结果报给用户。
           */
          historyCleared: (days, records, rollupDays, writeFailed) => {
            const failed = Array.isArray(writeFailed)
              ? writeFailed.filter(reason => String(reason ?? '').length > 0)
              : []
            if (failed.length > 0) return `内存已清，落盘失败：${failed.join('；')}（磁盘上还是旧数据，重启会回来）`
            return `已清空：明细 ${days} 天 / ${records} 条，日汇总 ${rollupDays} 天`
          },
          historyProbe: (files, projects, reason) => `扫描结果：${projects} 个项目 / ${files} 份会话日志 —— ${reason}`,
          // ── 「显示」页的新控件（分组标题 / 说明 / 勾选框文案）──
          // 这些控件在代码里一律从**这张表**取值（`S` 上的键），所以文案必须在这里；
          // 早先整批写进了侧栏那张表（`S2`），结果四个分组标题一个字都不显示、
          // 12 个勾选框没有文字（`h('input')` 后面跟了个 `undefined`）。
          modelCardSection: '模型花费卡片',
          modelCardEnabled: '显示模型花费卡片',
          modelCardDefaultExpanded: '默认展开',
          modelCardRemember: '记住展开状态',
          modelCardShowTokens: '显示 Token',
          modelCardShowShare: '显示费用占比条',
          modelCardPeriod: '默认周期',
          modelCardPeriodToday: '今日',
          modelCardPeriodDays90: '近 90 天',
          modelCardRows: '模型行数（1–10）',
          saveCardRows: '保存行数',
          cardRowsBad: '行数要在 1–10 之间',
          modelCardPosition: '卡片位置',
          modelCardPositionBottom: '底部',
          modelCardPositionTop: '顶部',
          modelCardHint: '侧栏那块的 Top-N 模型与占比（关闭时宿主不下发数据，也不做聚合）。'
            + '「近 90 天」读日汇总，所以比账本明细看得远；未定价的调用金额不计入占比，行尾用 ⚠ 标出来。',
          sessionCostSection: '本会话费用',
          sessionCostEnabled: '显示本会话费用',
          sessionCostPosition: '显示位置',
          sessionCostPositionComposer: '输入区下方',
          sessionCostPositionHeader: '会话标题栏',
          sessionCostPositionOff: '不显示',
          sessionCostShowHitRate: '显示缓存命中率',
          sessionCostIncludeSubagent: '包含子代理',
          sessionCostHint: '金额取自本插件账本（与全站同口径，依据入账即固化），每 15 秒刷新一次。'
            + '「包含子代理」需要宿主在调用事件里给出父会话 id —— 没给的话只统计本会话，界面上会标出「宿主未提供子代理归属」，不假装算过。',
          stripSection: '额度横条',
          stripEnabled: '显示输入框上方的额度横条',
          stripShowBalance: '横条里也显示余额',
          stripHint: '横条给：今日金额 / 峰谷档位与倒计时 / 官方余额（可关）。点一下刷新一次。',
          cornerSection: '右下角角标',
          cornerEnabled: '显示右下角角标',
          cornerShowTop1: '角标里带 Top-1 模型',
          cornerHint: '贴在输入框右下角的小角标：今日金额 + 峰谷档位（可选 Top-1 模型）。',
          peakHint: '窗口是 **UTC 小时**的半开区间（`1-4` ＝ UTC 01:00–04:00 ＝ 北京 09:00–12:00）；'
            + '假期按**北京日历日**。留空 = 这一项沿用随包默认值（要**停用峰谷档**请关掉上面的开关，'
            + '不是清空窗口）。改这里会换计价依据指纹，**只影响之后的调用**。',
        }
      : {
          type: 'Provider type',
          other: 'Other',
          sub2api: 'Sub2Api',
          workbuddy: 'WorkBuddy (credits)',
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
          mismatchFactor: 'charge ≈ {factor}× the multiplier-based amount ({direction} by {percent}%)',
          mismatchHigher: 'higher',
          mismatchLower: 'lower',
          mismatchUnity: 'the endpoint reports 1 — this station likely does not bill as official price × multiplier',
          mismatchSpread: 'implied per-model multiplier {min}–{max} ({n} models) — priced per model',
          mismatchKeep: 'the endpoint multiplier still wins; the implied value only explains the gap',
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
          creditsTodayCard: 'Credits (today)',
          creditsSiteCard: 'Site total',
          creditsFilterCard: 'Caller filter',
          creditsFilterHint: 'The panel matches UA / source IP by **substring**; leaving it empty falls back to the default UA (deepseek-harness). Empty means you read the whole account pool (all buyers).',
          creditsModelsCard: 'Models with rate',
          creditsUnknownCard: 'No credit record',
          creditsTruncatedCard: 'Archive keeps the latest 1000 rows only — may undercount',
          creditsNoPanel: 'Panel unreachable (no permission / different version): the type still holds, there is just no consumption data.',
          officialRoute: 'Official route: no provider type; balance comes from the official API.',
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
          keyEmpty: 'This provider has no usable key reference yet (the host filters refs by provider). Paste a new key below, or add an existing ref from Balance & Cost → Overview.',
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
          peakNotify: 'Peak reminders',
          notifyInApp: 'In-app banner',
          notifySystem: 'System notification',
          notifyHint: 'Reminds you once when the tier **actually switches**; the **lead time** reminds you *before* the switch '
            + '(each switch point is announced once). Checked on each sidebar poll (up to one poll period late); '
            + 'the first run only records. System notifications need browser permission — if denied, the in-app banner still works.',
          notifyLead: 'Lead time (minutes, 1–30)',
          notifyLeadBad: 'Lead time must be 1–30 minutes',
          notifyType: 'Remind me',
          notifyTypeBoth: 'Both entering peak and entering off-peak',
          notifyTypePeak: 'Only entering peak',
          notifyTypeOff: 'Only entering off-peak',
          notifyPosition: 'Popup position',
          notifyPositionCorner: 'Bottom right',
          notifyPositionCenter: 'Screen center',
          previewPeak: 'Preview entering peak',
          previewOff: 'Preview entering off-peak',
          previewHint: 'Renders the real component once: wording / position / system notification match an actual trigger — no need to wait for the next switch.',
          saveNotifyLead: 'Save lead time',
          retentionHint: 'Detail feeds “today\u2019s sessions / by model”; the rollup feeds month/all totals (max 3650 days). '
            + 'Lowering it **immediately** deletes older data (not recoverable); the rollup is never shorter than the detail.',
          keyDiscovery: 'Key discovery',
          scanCredentialsFile: 'Read ref names from the credentials file',
          scanHint: 'Reads only the **key names** under `refs:` in `~/.dsh/.credentials.yaml` (never the values), so unusual naming is still found; '
            + 'turn it off to fall back to probing candidate names.',
          keyPrefixes: 'Candidate prefixes',
          keyMaxIndex: 'Max index',
          keyPrefixesHint: 'Comma-separated prefixes expand to the prefix plus “prefix_2 … prefix_N” (1–50).',
          saveDiscovery: 'Save discovery',
          accessControl: 'Access control',
          allowedHosts: 'Extra allowed hostnames',
          allowedHostsHint: 'Only loopback (127.0.0.1 / localhost / [::1]) is accepted by default — that is the DNS-rebinding guard. '
            + 'If you reach the host through a reverse proxy, custom domain or LAN IP, list those hostnames here (comma-separated, port optional).',
          saveHosts: 'Save allowlist',
          allowedHostsBad: 'Bad hostname: letters / digits / dots / dashes / underscores only, optional port, IPv6 in [..]',
          uiSection: 'Interface',
          localeLabel: 'Language',
          localeAuto: 'Follow browser',
          localeZh: '简体中文',
          localeEn: 'English',
          refreshSecondsLabel: 'Sidebar refresh (seconds)',
          refreshSecondsHint: '10–60 s. Affects sidebar polling only — never the ledger or the money basis.',
          saveRefreshSeconds: 'Save interval',
          refreshSecondsBad: 'Interval must be 10–60 seconds',
          hideOfficialBalance: 'Hide official balance',
          hideTodayCost: 'Hide today’s cost',
          hideHint: 'The corresponding block is not rendered at all (screen-share / screenshot safety). “Hide official balance” only drops the balance; '
            + '“Hide today’s cost” drops the overview’s today card, the sidebar today line, the model cost card while its period is Today, '
            + 'and today’s amount in the quota strip / corner badge — peak tier, balance, tokens and call counts are unaffected.',
          showSessionId: 'Show full session IDs',
          showSessionIdHint: 'Off by default (first 14 chars); useful when matching logs.',
          sidebarTools: 'Show peak schedule & price table in the sidebar',
          sidebarToolsHint: 'Off by default: price updates live on the Prices tab, the peak schedule in “Official peak pricing” below. '
            + 'Turning this on adds both rows (plus the update result line) to the sidebar footer.',
          peakConfigTitle: 'Official peak pricing',
          peakEnabled: 'Peak tiers enabled',
          peakWindows: 'Peak windows (UTC hours)',
          peakHolidays: 'Holidays (Beijing dates)',
          peakWindowsBad: 'Bad window format: use `1-4,6-10` (UTC hours, 0–23, comma-separated, max 24; '
            + 'start and end must differ, and `22-2` means across midnight)',
          savePeak: 'Save peak config',
          peakSchedule: 'Peak schedule',
          peakScheduleHint: 'Next 6 price-tier switch points (Beijing windows, shown in your local time); affects future calls only',
          peakScheduleEmpty: 'Peak pricing is off (or no switch point can be computed)',
          heatTitle: 'Token usage',
          heatSummary: (weeks, tokensText, calls) => `Last ${weeks} weeks: ${tokensText} tokens · ${calls} calls (daily rollup — visible beyond the ledger detail window)`,
          heatLegend: 'Darker = more tokens that day; hover a cell for the breakdown.',
          modelStatsTitle: 'Per-model stats (tokens & cost)',
          modelStatsToday: 'Today',
          modelStatsHistory: 'All history',
          modelStatsRank: 'Rank by:',
          rankCost: 'Cost',
          rankTokens: 'Tokens',
          rankHit: 'Hit rate',
          rankPerUsd: 'Tokens / $',
          modelStatsEmpty: 'No data in this range',
          modelStatsScope: (since, days, total) => `since ${since} · ${days} day(s) with records · ${total} model(s)`,
          modelStatsGap: days => `${days} day(s) predate 0.8.0 and carry no per-model detail (counted in totals only)`,
          modelStatsUnpriced: count => `${count} unpriced`,
          historySection: 'History',
          historyHint: 'Every call freezes its basis (price table / multiplier / peak tier) **at write time**, so neither importing nor clearing re-prices history — '
            + 'changing prices only affects later calls. Clearing wipes both the ledger (ledger.json) and the daily rollup (days.json) and **cannot be undone**.',
          historyImport: 'Import pre-install history',
          historyClear: 'Clear all history',
          historyClearConfirm: 'Click again to confirm',
          historyClearCancel: 'Cancel',
          historyCleared: (days, records, rollupDays, writeFailed) => {
            const failed = Array.isArray(writeFailed)
              ? writeFailed.filter(reason => String(reason ?? '').length > 0)
              : []
            if (failed.length > 0) return `Memory cleared, but writing to disk failed: ${failed.join('; ')} (the old files are still there — history comes back after a restart)`
            return `Cleared: ${days} day(s) / ${records} record(s) of detail, ${rollupDays} day(s) of rollup`
          },
          historyProbe: (files, projects, reason) => `Scan: ${projects} project(s) / ${files} session log(s) — ${reason}`,
          // ── Display tab: the new controls (section titles / hints / checkbox labels) ──
          modelCardSection: 'Model cost card',
          modelCardEnabled: 'Show the model cost card',
          modelCardDefaultExpanded: 'Expanded by default',
          modelCardRemember: 'Remember expanded state',
          modelCardShowTokens: 'Show tokens',
          modelCardShowShare: 'Show cost share bars',
          modelCardPeriod: 'Default period',
          modelCardPeriodToday: 'Today',
          modelCardPeriodDays90: 'Last 90 days',
          modelCardRows: 'Model rows (1–10)',
          saveCardRows: 'Save rows',
          cardRowsBad: 'Rows must be 1–10',
          modelCardPosition: 'Card position',
          modelCardPositionBottom: 'Bottom',
          modelCardPositionTop: 'Top',
          modelCardHint: 'Top-N models and their share, right in the sidebar (when off, the host sends no data and does no aggregation). '
            + '“Last 90 days” reads the daily rollup, so it reaches further back than ledger detail; unpriced calls are excluded from the share and flagged with ⚠.',
          sessionCostSection: 'This session',
          sessionCostEnabled: 'Show this-session cost',
          sessionCostPosition: 'Position',
          sessionCostPositionComposer: 'Below the input',
          sessionCostPositionHeader: 'Session header',
          sessionCostPositionOff: 'Hidden',
          sessionCostShowHitRate: 'Show cache hit rate',
          sessionCostIncludeSubagent: 'Include subagents',
          sessionCostHint: 'Amounts come from this plugin’s ledger (same basis as everywhere else, frozen at write time) and refresh every 15s. '
            + '“Include subagents” needs the host to pass a parent session id with the call event — without it only this session is counted and the UI says “host gives no subagent attribution” rather than pretending.',
          stripSection: 'Quota strip',
          stripEnabled: 'Show the strip above the input',
          stripShowBalance: 'Also show the balance in the strip',
          stripHint: 'The strip shows: today’s cost / peak tier & countdown / official balance (optional). Click to refresh.',
          cornerSection: 'Corner badge',
          cornerEnabled: 'Show the corner badge',
          cornerShowTop1: 'Include the Top-1 model',
          cornerHint: 'A small badge at the bottom-right of the composer: today’s cost + peak tier (optional Top-1 model).',
          peakHint: 'Windows are half-open **UTC hour** ranges (`1-4` = UTC 01:00–04:00 = Beijing 09:00–12:00); '
            + 'holidays are **Beijing calendar days**. Blank = keep the bundled default for that field '
            + '(to **turn peak tiers off**, untick the switch above — clearing the window is not the way). '
            + 'Changing this changes the basis fingerprint and affects future calls only.',
        }
    let S = buildS(isZh)

    // ── 侧栏底部（余额 / 今日 / 峰谷倒计时条）的文案 ──
    const buildS2 = zh => zh
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
          peakSchedule: '峰谷表',
          peakPreview: '预览',
          peakPreviewHide: '收起',
          intoPeak: '→ 高峰',
          intoOff: '→ 平价',
          peakStarted: '已进入高峰时段',
          offStarted: '已进入平价时段',
          peakSoon: '即将进入高峰时段',
          offSoon: '即将进入平价时段',
          previewTag: '预览',
          cardModels: '模型花费',
          cardTop: 'Top-1',
          cardPeriodToday: '今日',
          cardPeriodDays90: '近 90 天',
          cardTotal: (period, amount, count) => `${period} ${amount} · ${count} 个模型`,
          cardEmpty: '这个周期还没有记录',
          cardUnpriced: count => `${count} 次未定价（金额不计入占比）`,
          zonePeak: '峰时',
          zoneOff: '谷时',
          sessionCost: '本会话',
          sessionCostNoSubagent: '宿主未提供子代理归属',
          sessionCostStale: '读不到本会话数据',
          includeSubagent: '含子代理',
          stripRefresh: '点一下刷新',
          budgetLabel: '预算',
          budgetUsed: '预算已用',
          budgetPeriod: { today: '今日', month: '本月', all: '累计' },
          cornerTop1: 'Top-1',
          dismiss: '关闭提醒',
          scheduleHint: '接下来 6 个档位切换点（北京时间窗口，按本地时区显示）；只影响之后的调用计价',
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
          /**
           * WorkBuddy / 积分倍率型：这一类站**没有余额接口、也没有基准价**，所以「今日」
           * 显示的是积分量而不是钱。积分不换算货币、不进任何金额合计。
           */
          creditsUnit: '积分',
          creditsToday: '{n} 积分',
          creditsSite: '站方全量 {n}',
          creditsFilter: '按 {v} 过滤',
          creditsFiltered: '按 {v} 过滤（含 {ip}）',
          creditsUnknown: '{n} 笔无积分记录',
          creditsTruncated: '归档仅取最近 1000 条，可能漏数',
          creditsUnavailable: '积分读不到',
          creditsRefreshing: '正在读积分…',
          creditsHint: '「积分」是该站自己的计量单位，不是钱：没有基准价可换算，所以不并入任何金额合计。「站方全量」是站长整个账号池（含所有买家）的消耗，只作对照。',
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
          peakSchedule: 'Peak schedule',
          peakPreview: 'Preview',
          peakPreviewHide: 'Hide',
          intoPeak: '→ peak',
          intoOff: '→ off-peak',
          peakStarted: 'Peak hours started',
          offStarted: 'Off-peak started',
          peakSoon: 'Peak hours start soon',
          offSoon: 'Off-peak starts soon',
          previewTag: 'preview',
          cardModels: 'Model cost',
          cardTop: 'Top-1',
          cardPeriodToday: 'Today',
          cardPeriodDays90: 'Last 90 days',
          cardTotal: (period, amount, count) => `${period} ${amount} · ${count} model(s)`,
          cardEmpty: 'Nothing recorded in this period yet',
          cardUnpriced: count => `${count} unpriced (excluded from the share)`,
          zonePeak: 'Peak',
          zoneOff: 'Off-peak',
          sessionCost: 'Session',
          sessionCostNoSubagent: 'host gives no subagent attribution',
          sessionCostStale: 'session data unavailable',
          includeSubagent: 'incl. subagents',
          stripRefresh: 'Click to refresh',
          budgetLabel: 'Budget',
          budgetUsed: 'Budget used',
          budgetPeriod: { today: 'today', month: 'this month', all: 'all time' },
          cornerTop1: 'Top-1',
          dismiss: 'Dismiss',
          scheduleHint: 'Next 6 price-tier switch points (Beijing windows, shown in your local time); affects future calls only',
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
          creditsUnit: 'credits',
          creditsToday: '{n} credits',
          creditsSite: 'site total {n}',
          creditsFilter: 'filtered by {v}',
          creditsFiltered: 'filtered by {v} (incl. {ip})',
          creditsUnknown: '{n} call(s) with no credit record',
          creditsTruncated: 'Archive keeps the latest 1000 rows only — may undercount',
          creditsUnavailable: 'credits unavailable',
          creditsRefreshing: 'Reading credits…',
          creditsHint: 'Credits are this station’s own unit, not money: there is no base price to convert, so they never join any monetary total. “Site total” covers the whole account pool (all buyers) and is shown for reference only.',
        }
    let S2 = buildS2(isZh)

    /** 让三个 store 一起重渲染（语言切换、提醒预览都用它 —— 别让某一块停在旧状态）。 */
    const emitAll = () => {
      for (const target of storeRegistry) {
        try { target.emit?.() } catch { /* 单个 store 出错不影响其它 */ }
      }
    }

    /**
     * 把宿主配置里的语言落下来。**只在真正变化时**重建文案表并广播，
     * 所以每次数据刷新调它都不会触发多余的渲染。
     *
     * @param {unknown} value 宿主 `ui.locale`（`auto` / `zh` / `en`）
     * @returns {boolean} 是否发生了变化
     */
    const syncLocale = value => {
      const mode = normalizeLocale(value)
      const next = resolveIsZh(mode)
      if (mode === localeMode && next === isZh) return false
      localeMode = mode
      isZh = next
      S = buildS(isZh)
      S2 = buildS2(isZh)
      emitAll()
      return true
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
        // `minmax(0, 1fr)`（而不是 `1fr`）：右列的最小宽度不再是内容的 min-content，
        // 长引用名 / 长按钮行才收得住，不会把整张卡片顶出宿主卡片右边缘（截图里「保存 key」被切）。
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        columnGap: 10,
        rowGap: 2,
        marginTop: 6,
      },
      // 键名列：不再 `whiteSpace: nowrap`（长引用名会顶宽整列），窄宽度下允许断行。
      key: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', minWidth: 0, overflowWrap: 'anywhere' },
      val: { wordBreak: 'break-word', minWidth: 0 },
      check: { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' },
      error: { marginTop: 6, color: 'var(--dsw-alias-label-error, #d33)' },
      note: { marginTop: 4, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
    }

    /**
     * 密钥编辑区（`KeyEditor`）专用样式：卡片宽度由宿主决定，可能很窄。
     *
     * 三条规矩（都只用上面那套既有的 `var(--dsw-alias-*)`，不引入新 token / 硬编码颜色）：
     *   1. **不写死宽度**：输入框用 flex 的 `flex: 1 1 160px` + `minWidth: 0`，
     *      行用 `flexWrap: 'wrap'` —— 窄宽度下按钮换行，而不是被卡片右边缘切掉；
     *   2. 值用 `textOverflow: 'ellipsis'` + `minWidth: 0` 收尾（长 key 不撑破布局）；
     *   3. 「主 key（宿主正在用）/ 已配置 / 未配置」**独立一行**，不再和值挤在一行叠字。
     */
    const keyCss = {
      valueCell: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      valueLine: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 },
      valueCode: {
        ...css.note,
        marginTop: 0,
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      stateNote: { ...css.note, marginTop: 0, minWidth: 0, overflowWrap: 'anywhere' },
      addRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 },
      input: { ...css.select, width: 'auto', flex: '1 1 160px', minWidth: 0, maxWidth: 280, boxSizing: 'border-box' },
      /** 一把 key 都没有时的那句话：整行铺满（两列布局里跨列），别缩在第二列。 */
      empty: { ...css.note, gridColumn: '1 / -1', marginTop: 0, overflowWrap: 'anywhere' },
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
      async call(path, init) {        const response = await fetch(`${ROUTE}${path}`, {
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
            const state = await this.call('/state')
            // 语言由宿主配置驱动：先落下来（整表重建）再广播，卡片这一帧就是新语言
            syncLocale(state?.ui?.locale)
            this.state = state
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
    storeRegistry.add(store)

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
      // 第三行：分歧「差在哪」。宿主只给结构化事实（宿主不做本地化），这里按语言拼。
      // 每个事实都单独判可用：倍率报 0 或官方价为 0 时宿主给 null，那一句就不拼，
      // 但结论（以接口倍率为准）无论如何都要留 —— 别让整行静默消失。
      const reason = spend.mismatchReason
      const why = []
      if (spend.mismatch) {
        if (reason && Number.isFinite(reason.factor) && typeof reason.direction === 'string') {
          why.push(S.mismatchFactor
            .replace('{factor}', num(reason.factor))
            .replace('{direction}', reason.direction === 'station-charged-more' ? S.mismatchHigher : S.mismatchLower)
            .replace('{percent}', Number(reason.percent ?? 0).toFixed(1)))
        }
        if (reason?.rateIsUnity === true) why.push(S.mismatchUnity)
        if (reason && reason.modelRateCount > 1 && reason.modelRateMin !== reason.modelRateMax) {
          why.push(S.mismatchSpread
            .replace('{min}', num(reason.modelRateMin))
            .replace('{max}', num(reason.modelRateMax))
            .replace('{n}', String(reason.modelRateCount)))
        }
        why.push(S.mismatchKeep)
      }
      return [lines[0], `${S.effective}${actual}${tail}`, why.join(' · ')]
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
      // 一把 key 都没有（用户还没配 / 宿主按供应商过滤后为空）：明说一句 ——
      // 留一个空列表会让人以为界面坏了。
      if (state.loading !== true && (state.keys ?? []).length === 0) {
        rows.push(h('span', { key: 'keys-empty', style: keyCss.empty }, S.keyEmpty))
      }
      for (const key of state.keys ?? []) {
        const shown = revealed[key.ref]
        rows.push(row(`${S.keyRow} ${key.ref}`,
          // 第一行：值 + 眼睛 / 删除按钮；第二行：状态文案（主 key / 已配置 / 未配置）。
          // 状态文案以前和值挤在同一个 inline-flex 里，窄宽度下会和值叠字（截图里那条）。
          h('span', { style: keyCss.valueCell },
            h('span', { style: keyCss.valueLine },
              // 值默认打码；点小眼睛才去宿主取一次（常规 /keys 列表里不含值）
              key.configured
                ? h('code', { style: keyCss.valueCode }, shown === undefined ? '••••••••' : shown)
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
              key.managed
                ? h('button', { type: 'button', style: css.button, disabled: busy, onClick: () => { void remove(key.ref) } }, S.remove)
                : null),
            h('span', { style: keyCss.stateNote }, key.ref === state.primaryRef
              ? S.keyPrimary
              : key.configured ? S.keyConfigured : S.keyMissing))))
      }
      rows.push(row(S.keyAdd,
        h('span', { style: keyCss.addRow },
          h('input', {
            type: 'password',
            style: keyCss.input,
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

      // 官方路线（`deepseek-official` / `deepseek-account`）在插件里恒等于「没有站方类型」：
      // 它们的余额走官方接口（lib/index.js 的 `queryOneBalance`），不吃 `types` 里的值。
      // 这里再兜一次：`types` 里有历史遗留值也不会让卡片画出站方额度 / 刷新这些控件
      // （真按 sub2api 去探，官方端点只会 404 或「未找到 API Key」）。
      const official = entry.deepseekRoute !== undefined
      const type = official ? 'other' : (entry.type ?? 'other')
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
            if (spend[2].length > 0) rows.push(row('', spend[2]))
          }
          if (entry.updatedAt) rows.push(row('', `${new Date(entry.updatedAt).toLocaleTimeString()}`))
        }
      } else if (type === 'workbuddy') {
        /**
         * WorkBuddy / 积分倍率型：没有余额接口也没有倍率接口，能给的是
         * 「今日积分」——站方口径（整个账号池）与自身口径（按调用来源过滤）分开列，
         * 一眼能看出这只是不是只有我在用。
         */
        const wb = entry.workbuddy
        if (entry.status === 'idle') rows.push(row(S.creditsTodayCard, S.clickRefresh))
        if (entry.status === 'error') rows.push(row(S.creditsTodayCard, entry.error ?? '—'))
        if (entry.status === 'ok' && wb) {
          const own = wb.own ?? {}
          rows.push(row(S.creditsTodayCard, own.ok === true
            ? formatCredits(own.credits)
            : (own.error ?? S.creditsUnavailable)))
          const site = wb.site ?? {}
          if (site.ok === true) rows.push(row(S.creditsSiteCard, formatCredits(site.totals?.credits)))
          else rows.push(row('', S.creditsNoPanel))
          const filter = entry.creditsFilter ?? {}
          rows.push(row(S.creditsFilterCard, [filter.userAgent, filter.clientIp].filter(Boolean).join(' · ') || '—'))
          rows.push(row(S.creditsModelsCard, `${wb.ratedModelCount ?? 0}`))
          if ((own.unknown ?? 0) > 0) rows.push(row(S.creditsUnknownCard, String(own.unknown)))
          if (own.truncated === true || own.windowCapped === true) rows.push(row('', S.creditsTruncatedCard))
          if (wb.origin) rows.push(row('', wb.origin))
          if (entry.updatedAt) rows.push(row('', `${new Date(entry.updatedAt).toLocaleTimeString()}`))
        }
      } else {
        rows.push(row('', official ? S.officialRoute : S.notSub2api))
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
        // 「供应商类型」只在真能选站方类型的卡片上出现：官方路线没有这一格（见上面 `official`）
        h('div', { style: css.head },
          official ? null : h('span', { style: css.label }, S.type),
          official ? null : h('select', {
            style: css.select,
            value: type,
            disabled: busy || view.loading,
            'aria-label': S.type,
            onChange: onType,
          },
            h('option', { value: 'other' }, S.other),
            h('option', { value: 'sub2api' }, S.sub2api),
            h('option', { value: 'workbuddy' }, S.workbuddy)),
          type === 'sub2api' || type === 'workbuddy'
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
        // DeepSeek 的**API Key 路线**才有「多把 key」编辑区（写宿主凭据库）。
        // 账号路线不吃 key（它用 `deepseekAccount` 服务的登录 token，见 lib/index.js 的
        // `queryOneBalance` 账号分支），它的 `apiKeyEnv` 是 undefined → 候选名推不出来、
        // `/keys` 恒回空列表、`nextRef` 也是 null（填了值点保存只会 400）。
        // 之前只判 `deepseekRoute !== undefined`，于是账号卡片上挂着一个死掉的输入框。
        entry.deepseekRoute === 'api-key' ? h(KeyEditor, { provider }) : null,
        view.error ? h('div', { style: css.error }, view.error) : null)
    }

    // ── 侧栏底部：余额（仅官方） / 今日（倍率之后的实际花费） / 峰谷倒计时条 ──
    /** 侧栏轮询间隔（秒）：宿主配置优先，夹在 10–60 之间。 */
    const SIDEBAR_POLL_FALLBACK_S = 30
    const sidebarSeconds = () => {
      const value = Number(sidebar.refreshSeconds)
      return Number.isFinite(value) && value >= 10 && value <= 60 ? Math.trunc(value) : SIDEBAR_POLL_FALLBACK_S
    }
    /** 与 settings 卡片分开的一份状态：侧栏常驻，卡片只在设置页里。 */
    const sidebar = {
      data: null,
      error: null,
      priceMessage: null,
      priceFailed: false,
      updating: false,
      /** 宿主配置的轮询间隔（秒）；拿不到就用默认值。 */
      refreshSeconds: null,
      /** 峰谷切换提醒（跨过切换点才有值；关闭按钮清掉）。 */
      reminder: null,
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
            // 语言与轮询间隔都由宿主配置驱动（`ui` 块随侧栏数据一起下发）
            syncLocale(payload.data?.ui?.locale)
            this.refreshSeconds = payload.data?.ui?.refreshSeconds ?? null
            this.data = payload.data
            this.error = null
            this.checkPeak(payload.data)
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
       * 峰谷提醒，两种触发（都受 `notify.type` 过滤）：
       *
       *   1. **提前量**：距下一个切换点不足 `leadMinutes` 时提醒「即将进入高峰」。
       *      同一个切换点只提醒一次（把该切换点的 `atMs` 记在本地），所以轮询再密也不刷屏。
       *   2. **刚跨过**：档位与上一次不同、且切换点在 `PEAK_REMINDER_FRESH_MS` 内 → 「已进入…」。
       *      页面关着期间跨过的旧切换点**不补报**（几小时前的换档是噪音）。
       *
       * 判定发生在**取数之后**（不在渲染函数里），所以粒度等于侧栏轮询间隔：
       * 切换点最多晚一个轮询周期才提示 —— 要秒级就得在宿主侧挂定时器，本插件不这么做。
       */
      checkPeak(data) {
        if (data === null || typeof data !== 'object' || data.peak === null || data.peak === undefined) return
        const peak = data.peak
        const notify = data.notify ?? {}
        const inPeak = peak.inPeak === true
        const current = inPeak ? 'peak' : 'off'
        let previous = null
        let leadShownAt = null
        try {
          previous = localStorage.getItem(PEAK_STATE_KEY)
          leadShownAt = Number(localStorage.getItem(PEAK_LEAD_KEY))
          localStorage.setItem(PEAK_STATE_KEY, current)
        } catch { /* 隐私模式下 localStorage 会抛，忽略 */ }
        if (notify.enabled !== true) {
          // 关掉提醒时把还挂着的横幅一起收掉，别让它留在侧栏上
          this.reminder = null
          return
        }
        /** 提醒类型过滤：`peak` 只报进入峰、`off` 只报进入谷、其余都报。 */
        const wants = target => (notify.type === 'peak' ? target === 'peak' : notify.type === 'off' ? target === 'off' : true)
        const nowMs = Date.now()
        // ── 1) 提前提醒：下一个切换点就在眼前 ──
        const nextAtMs = Number.isFinite(peak.nextAtMs) ? peak.nextAtMs : null
        const leadMinutes = Number.isFinite(Number(notify.leadMinutes)) ? Number(notify.leadMinutes) : 2
        const leadMs = Math.max(1, leadMinutes) * 60_000
        if (nextAtMs !== null && nextAtMs - nowMs <= leadMs && nextAtMs - nowMs > -60_000) {
          const target = inPeak ? 'off' : 'peak'
          if (wants(target) && leadShownAt !== nextAtMs) {
            try { localStorage.setItem(PEAK_LEAD_KEY, String(nextAtMs)) } catch { /* 同 localStorage 注释 */ }
            this.reminder = {
              inPeak: target === 'peak',
              upcoming: true,
              atMs: nextAtMs,
              leadMinutes: Math.max(0, Math.round((nextAtMs - nowMs) / 60_000)),
            }
            if (notify.system === true) systemNotify(this.reminder)
            return
          }
        }
        // ── 2) 刚跨过切换点 ──
        if (previous !== 'peak' && previous !== 'off') return
        if (previous === current) return
        if (!wants(current)) return
        const atMs = Number.isFinite(peak.prevAtMs) ? peak.prevAtMs : null
        if (atMs === null || nowMs - atMs > PEAK_REMINDER_FRESH_MS) return
        this.reminder = { inPeak, atMs }
        if (notify.system === true) systemNotify(this.reminder)
      },
      /**
       * 「预览弹窗」：用**真实组件**渲染一次提醒（文案 / 位置 / 系统通知与实际触发完全一致），
       * 解决「配完了不知道长什么样、要等到下一次换档才验证」的问题。
       */
      previewReminder(target) {
        this.reminder = { inPeak: target === 'peak', atMs: Date.now(), preview: true, upcoming: false }
        if ((this.data?.notify ?? {}).system === true) systemNotify(this.reminder)
        // 预览要在**设置页**当场看到，所以让三个 store 一起重渲染（侧栏那侧也会跟着弹）
        emitAll()
      },
      dismissReminder() {
        this.reminder = null
        this.emit()
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
    storeRegistry.add(sidebar)

    function useSidebar() {
      const [, bump] = useState(0)
      const seconds = sidebarSeconds()
      useEffect(() => {
        const unsubscribe = sidebar.subscribe(() => bump(n => n + 1))
        if (sidebar.data === null) sidebar.load()
        // 已经有数据（从别的页面切回来）：也判一次 —— 轮询之前的这个间隙里可能刚好换档
        else sidebar.checkPeak(sidebar.data)
        const timer = setInterval(() => { void sidebar.load() }, seconds * 1000)
        // 切回窗口时补一次：别的页面改过配置就该立刻反映出来
        const onFocus = () => { void sidebar.load() }
        window.addEventListener('focus', onFocus)
        return () => {
          unsubscribe()
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
        // 轮询间隔可配：间隔一变就重建定时器（依赖 seconds）
      }, [seconds])
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

    /**
     * token 数格式化（1.2K / 3.4M）。
     *
     * **缺值画 `—`，不画 `0`**：宿主没给（老宿主 / 形状漂移）和「真的用了 0 个 token」
     * 不是一回事 —— 与 `formatAmount` 同一判据。真 0 仍然画 `0`（那是有数据）。
     */
    function formatTokens(value) {
      if (value === null || value === undefined || value === '') return '—'
      const parsed = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(parsed)) return '—'
      const number = Math.max(0, parsed)
      if (number < 1e3) return String(Math.round(number))
      if (number < 1e6) return `${(number / 1e3).toFixed(1)}K`
      return `${(number / 1e6).toFixed(1)}M`
    }

    /**
     * 积分格式化（WorkBuddy 型）。**刻意不套币种符号、不做汇率**：积分是站方自己的
     * 计量单位，与 USD/CNY 是两个体系，借展示符号会把它伪装成钱。
     * 对端面板也用两位小数，这里保持一致便于对账。
     */
    function formatCredits(value) {
      if (value === null || value === undefined || value === '') return '—'
      const parsed = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(parsed)) return '—'
      return parsed.toFixed(2)
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

    /** 本地「月-日 时:分」：峰谷表里的绝对时刻（浏览器与宿主同机，用本地时区才对得上用户的表）。 */
    function formatClock(atMs) {
      if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return '—'
      const date = new Date(atMs)
      const pad = value => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * 系统通知（可选）：只在浏览器**已授权**时发，没授权就静默跳过并返回 false。
     * 权限申请必须由用户手势触发，所以放在设置页的开关上（见 `requestSystemNotify`），不在这里弹窗。
     */
    function systemNotify(reminder) {
      try {
        if (typeof Notification === 'undefined') return false
        if (Notification.permission !== 'granted') return false
        const title = reminder.upcoming
          ? (reminder.inPeak
              ? (isZh ? '即将进入高峰时段' : 'Peak hours start soon')
              : (isZh ? '即将进入平价时段' : 'Off-peak starts soon'))
          : reminder.inPeak
            ? (isZh ? '已进入高峰时段' : 'Peak hours started')
            : (isZh ? '已进入平价时段' : 'Off-peak started')
        const body = reminder.upcoming
          ? (isZh
              ? `距切换还有约 ${reminder.leadMinutes ?? 0} 分钟（${reminder.inPeak ? '进入峰段' : '进入谷段'}）`
              : `Switching in about ${reminder.leadMinutes ?? 0} min (${reminder.inPeak ? 'to peak' : 'to off-peak'})`)
          : reminder.inPeak
            ? (isZh ? 'DeepSeek 官方峰段计价开始' : 'DeepSeek official peak pricing is now in effect')
            : (isZh ? 'DeepSeek 官方谷段计价开始' : 'DeepSeek official off-peak pricing is now in effect')
        new Notification(title, { body, tag: 'balance-monitor-peak' })
        return true
      } catch {
        return false
      }
    }

    /**
     * 勾「系统通知」时申请权限（必须在用户手势里调），再把开关写进配置。
     * 授权被拒也照写 —— 用户确实想开，只是浏览器不放行；应用内提醒不受影响。
     */
    async function requestSystemNotify(checked, view) {
      if (checked === true) {
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission()
        } catch { /* 不支持就算，不影响开关本身 */ }
      }
      await view.saveConfig({ peakNotify: { system: checked } })
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
      schedule: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 },
      reminder: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.18))', color: 'var(--dsw-alias-label-primary, inherit)' },
      reminderText: { flex: '1 1 auto', fontSize: 11 },
      reminderClose: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, lineHeight: 1 },
      /** 提醒弹窗是**浮层**（不是塞在侧栏里的一行），位置由配置决定。 */
      reminderPopup: {
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 2147483000,
        padding: '6px 10px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.28)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
      },
      reminderCenter: { right: 'auto', bottom: 'auto', left: '50%', top: '28%', transform: 'translateX(-50%)', padding: '8px 14px' },
      /** 模型花费卡片 */
      card: { marginTop: 2, padding: '3px 0 1px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))' },
      cardHead: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: 0, border: 'none', background: 'transparent', color: 'inherit', fontSize: 11, cursor: 'pointer', textAlign: 'left' },
      cardRows: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 3 },
      cardRow: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 },
      cardName: { flex: '0 0 96px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      cardBarBg: { flex: '1 1 auto', height: 5, borderRadius: 3, background: 'rgba(128,128,128,0.2)', overflow: 'hidden' },
      cardBar: { height: '100%', borderRadius: 3, background: 'var(--dsw-alias-brand-primary, #4b7bec)' },
      cardAmount: { flex: '0 0 auto', whiteSpace: 'nowrap' },
      error: { color: 'var(--dsw-alias-label-error, #d33)', fontSize: 11 },
    }

    /**
     * 峰谷提醒弹窗（浮层）。
     *
     * 侧栏与设置页的「预览」**共用同一个组件** —— 预览的作用就是「所见即实际触发」，
     * 两处各画一份迟早会走样。位置由 `notify.position` 决定。
     */
    function PeakReminder({ reminder, notify, onDismiss }) {
      const center = notify?.position === 'center'
      const label = reminder?.upcoming
        ? `${reminder.inPeak ? S2.peakSoon : S2.offSoon} · ${formatClock(reminder.atMs)}`
        : `${reminder?.inPeak ? S2.peakStarted : S2.offStarted} · ${formatClock(reminder?.atMs)}`
      return h('div', {
        style: { ...sidebarCss.reminder, ...sidebarCss.reminderPopup, ...(center ? sidebarCss.reminderCenter : {}) },
      },
        h('span', { style: sidebarCss.reminderText }, reminder?.preview === true ? `${label} · ${S2.previewTag}` : label),
        h('button', {
          type: 'button',
          style: sidebarCss.reminderClose,
          title: S2.dismiss,
          'aria-label': S2.dismiss,
          onClick: () => onDismiss(),
        }, '×'))
    }

    function SidebarFooter() {
      const view = useSidebar()
      const [selected, setSelected] = useState('all')
      // 余额显示哪条 DeepSeek 路线（点余额行切换）
      const [balancePick, setBalancePick] = useState(null)
      // 余额明细面板（点余额行展开：各路线 + 每条路线下每把 key 的余额）
      const [showDetail, setShowDetail] = useState(false)
      // 峰谷表一键预览（接下来几个档位切换点）
      const [showSchedule, setShowSchedule] = useState(false)
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
      /**
       * 「模型花费卡片是否展开」。**两个坑叠在一起**：
       *
       * 1. 这个 hook 必须在下面那个 early return **之前** —— 首帧 `data` 是 `null`（只跑到早退），
       *    数据回来同一个实例接着往下跑，hook 数量就变了；真 React 直接抛
       *    `Rendered more hooks than during the previous render`，侧栏整块消失。
       * 2. 也正因为它跑在早退之前，**不能拿配置算初值**（那时 `view.data` 还是 null）：
       *    `useState(fn)` 的初值只算一次，会把卡片永久定死在收起态。所以先给 `false`，
       *    等数据到位后用 effect **应用一次**「记住的展开状态 / 默认展开」。
       */
      const [cardOpen, setCardOpen] = useState(false)
      const [cardInit, setCardInit] = useState(0)
      useEffect(() => {
        const cfg = view.data?.modelCard ?? null
        if (cfg === null || cardInit === 1) return
        setCardInit(1)
        let value = cfg.defaultExpanded === true
        if (cfg.rememberExpanded === true) {
          try {
            const stored = localStorage.getItem(CARD_OPEN_KEY)
            if (stored === '1') value = true
            else if (stored === '0') value = false
          } catch { /* 隐私模式：退回默认展开 */ }
        }
        setCardOpen(value)
      }, [view.data])
      if (data === null) return null

      const providers = Array.isArray(data.providers) ? data.providers : []
      const active = selected === 'all' ? null : providers.find(item => item.provider === selected) ?? null
      const total = data.total ?? {}
      const amount = active === null ? total.amount : active.amount
      const calls = active === null ? total.calls : active.calls
      const tokens = active === null ? total.tokens : active.tokens
      const hitRate = active === null ? total.hitRate : active.hitRate
      const unpriced = active === null ? total.unpriced : active.unpriced
      /**
       * WorkBuddy / 积分倍率型：这一类站没有余额接口，也没有可用于换算的基准价，
       * 所以「今日」显示的是**积分**而不是钱。积分与 USD 账本是两个体系，**不合并**：
       * 这里只换掉「今日」那一行的数值，其余（次数 / token / 命中率）照旧读本地账本。
       *
       * 只在**选中了具体供应商**时显示：积分是按供应商逐站给的，`全部` 那一档没有
       * 可加总的语义（不同站的积分不是同一把尺子）。
       */
      const creditRows = Array.isArray(data.credits) ? data.credits : []
      const creditRow = active === null
        ? null
        : creditRows.find(item => item.provider === active.provider) ?? null
      // 界面偏好（隐藏敏感区块）随侧栏数据下发
      const ui = data.ui ?? {}
      const hideOfficialBalance = ui.hideOfficialBalance === true
      const hideTodayCost = ui.hideTodayCost === true
      /**
       * 两个**操作行**（峰谷表预览 / 价格表更新）默认不渲染：它们是「去改配置」的入口，
       * 不是用量，侧栏那点位置留给余额 / 今日 / 峰谷倒计时。同一件事在设置页
       * 「余额与费用」里都有（「价格」页更新价目、「显示 → 官方峰谷」下看峰谷表），
       * 要常驻侧栏就在「显示 → 界面」里打开这一位。
       */
      const showTools = ui.sidebarTools === true

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
      // 「隐藏官方余额」开启时整行不渲染（截屏防泄露）；token / 调用次数统计不受影响
      const balanceNode = balances.length === 0 || hideOfficialBalance === true
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

      // 峰谷表：一键预览接下来的切换点（数据由宿主算好，客户端只排版）
      // 侧栏默认不显示（`ui.sidebarTools`）；设置页「显示 → 官方峰谷」下有同一份只读表。
      const upcoming = Array.isArray(peak?.upcoming) ? peak.upcoming : []
      const scheduleNode = showTools !== true || upcoming.length === 0
        ? null
        : h('div', { style: sidebarCss.schedule, key: 'schedule' },
            h('div', { style: sidebarCss.priceRow },
              h('span', { style: sidebarCss.label, title: S2.scheduleHint }, S2.peakSchedule),
              h('button', {
                type: 'button',
                style: sidebarCss.priceButton,
                onClick: () => setShowSchedule(!showSchedule),
              }, `${showSchedule ? S2.peakPreviewHide : S2.peakPreview} · ${upcoming.length}`)),
            showSchedule === false
              ? null
              : upcoming.map(item => h('div', { style: sidebarCss.line, key: String(item.atMs) },
                  h('span', { style: sidebarCss.label }, formatClock(item.atMs)),
                  h('span', { style: item.inPeak ? sidebarCss.warn : sidebarCss.value }, item.inPeak ? S2.intoPeak : S2.intoOff),
                  h('span', { style: sidebarCss.label }, formatCountdown(item.atMs - nowMs)))))

      // 峰谷提醒：提前量（即将进入）或刚跨过切换点时出现一次（判定在取数之后，见 store.checkPeak）
      const reminder = view.reminder
      const reminderNode = reminder === null || reminder === undefined
        ? null
        : h(PeakReminder, {
            key: 'peak-reminder',
            reminder,
            notify: data.notify,
            onDismiss: () => view.dismissReminder(),
          })

      /**
       * 模型花费卡片。展开状态：开了「记住」就优先用上次的（localStorage），
       * 否则用「默认展开」；数据（Top-N + 份额）是宿主按配置算好的。
       */
      const card = data.modelCard ?? null
      const cardPosition = card?.position === 'top' ? 'top' : 'bottom'
      const toggleCard = () => {
        const next = !cardOpen
        setCardOpen(next)
        if (card?.rememberExpanded === true) {
          try { localStorage.setItem(CARD_OPEN_KEY, next ? '1' : '0') } catch { /* 同 localStorage 注释 */ }
        }
      }
      const cardItems = Array.isArray(card?.items) ? card.items : []
      // 标题行：展开箭头 + 「周期 · 金额 · 几个模型」；收起时把 Top-1 也露在这行上
      const cardTopItem = cardItems.length > 0 ? cardItems[0] : null
      const cardHeadParts = [
        h('span', { style: sidebarCss.label, key: 'title' }, `${cardOpen ? '▾' : '▸'} ${S2.cardModels}`),
        h('span', { style: sidebarCss.value, key: 'total' },
          S2.cardTotal(
            card?.period === 'days90' ? S2.cardPeriodDays90 : S2.cardPeriodToday,
            // 宿主给的是**数字**（`toDisplay()` 的返回值），币种符号得在这里补：
            // 直接插值会显示成 `0.5832`（还可能带浮点尾数）。`null` → `—`。
            formatAmount(card?.total?.amount, data.display),
            card?.models ?? 0,
          )),
      ]
      if (cardOpen !== true && cardTopItem !== null) {
        cardHeadParts.push(h('span', {
          key: 'top',
          style: sidebarCss.warn,
          title: `${cardTopItem.provider} / ${cardTopItem.model}`,
        }, `${S2.cardTop} ${cardTopItem.model} ${formatAmount(cardTopItem.amount, data.display)}`))
      }
      /** 一行：模型名 + 占比条（可选）+ 金额 + token（可选）+ 未定价告警。 */
      const cardRowNode = item => {
        const parts = [
          h('span', { style: sidebarCss.cardName, title: `${item.provider} / ${item.model}`, key: 'name' }, item.model),
          h('span', { style: sidebarCss.cardAmount, key: 'amount' }, formatAmount(item.amount, data.display)),
        ]
        if (card?.showShare === true) {
          parts.splice(1, 0, h('div', { style: sidebarCss.cardBarBg, key: 'bar' },
            h('div', { style: { ...sidebarCss.cardBar, width: `${Math.max(2, Math.round((item.share ?? 0) * 100))}%` } })))
        }
        if (card?.showTokens === true) {
          parts.push(h('span', { style: sidebarCss.label, key: 'tokens' }, formatTokens(item.tokens)))
        }
        if ((item.unpriced ?? 0) > 0) {
          parts.push(h('span', { style: sidebarCss.label, title: S2.cardUnpriced(item.unpriced), key: 'unpriced' }, '⚠'))
        }
        return h('div', { style: sidebarCss.cardRow, key: item.key }, parts)
      }
      const cardBodyNode = cardOpen !== true
        ? null
        : (cardItems.length === 0
            ? h('div', { style: sidebarCss.label }, S2.cardEmpty)
            : h('div', { style: sidebarCss.cardRows }, cardItems.map(cardRowNode)))
      /**
       * 「隐藏今日消耗」+ 卡片周期是「今日」→ 卡片整块不渲染：它报的就是今日金额
       * （标题给周期总额、每行给金额），只藏数字、留着标题等于没藏。
       * 周期是「近 90 天」时是历史金额，照常显示（藏的是「今日」，不是「花费」）。
       */
      const cardNode = card === null || (hideTodayCost === true && card.period !== 'days90')
        ? null
        : h('div', { style: sidebarCss.card, key: 'model-card' },
            h('button', { type: 'button', style: sidebarCss.cardHead, onClick: toggleCard }, cardHeadParts),
            cardBodyNode)
      const metaParts = [S2.calls.replace('{n}', String(calls ?? 0))]
      if (typeof hitRate === 'number') metaParts.push(S2.hit.replace('{p}', (hitRate * 100).toFixed(1)))
      if (tokens > 0) metaParts.push(`${formatTokens(tokens)} tok`)
      if (unpriced > 0) metaParts.push(S2.unpriced.replace('{n}', String(unpriced)))
      /**
       * 积分行的旁注：来源口径（按什么条件过滤的）、站方全量对照、以及两种
       * **必须让用户看见的不确定性** —— 归档只取最近 1000 条（可能漏数）、
       * 有请求没带 credit 记录（既不能当 0，也不能当完整）。
       */
      const creditMeta = []
      if (creditRow !== null) {
        if (creditRow.filter?.userAgent !== undefined || creditRow.filter?.clientIp !== undefined) {
          // `userAgent` / `clientIp` 在对端都是包含匹配，显示原文即可，不做二次解释。
          const filter = creditRow.filter?.clientIp === undefined
            ? S2.creditsFilter.replace('{v}', String(creditRow.filter.userAgent ?? '—'))
            : S2.creditsFiltered.replace('{v}', String(creditRow.filter.userAgent ?? '—')).replace('{ip}', String(creditRow.filter.clientIp))
          creditMeta.push(filter)
        }
        if (typeof creditRow.siteCredits === 'number') {
          creditMeta.push(S2.creditsSite.replace('{n}', formatCredits(creditRow.siteCredits)))
        }
        if ((creditRow.ownUnknown ?? 0) > 0) creditMeta.push(S2.creditsUnknown.replace('{n}', String(creditRow.ownUnknown)))
        if (creditRow.truncated === true || creditRow.windowCapped === true) creditMeta.push(S2.creditsTruncated)
      }

      return h('div', { style: sidebarCss.root, 'data-balance-monitor': 'sidebar' },
        reminderNode,
        balanceNode,
        detailNode,
        // 「隐藏今日消耗」只收掉**今日金额那一行**（截屏防泄露）；模型花费卡片的处理见上面 cardNode
        hideTodayCost === true
          ? null
          : h('div', { style: sidebarCss.line, key: 'today' },
              h('span', { style: sidebarCss.label }, S2.today),
              // 积分型供应商：今日给的是积分量；其余仍是账本金额（缺失画 — 不画 0）。
              creditRow === null
                ? h('span', { style: sidebarCss.value }, formatAmount(amount, data.display))
                : h('span', {
                    style: sidebarCss.value,
                    title: S2.creditsHint,
                  },
                    typeof creditRow.ownCredits === 'number'
                      ? S2.creditsToday.replace('{n}', formatCredits(creditRow.ownCredits))
                      : (creditRow.error ?? S2.creditsUnavailable)),
              h('select', {
                style: sidebarCss.select,
                value: selected,
                'aria-label': S2.provider,
                onChange: onSelect,
              },
                h('option', { value: 'all' }, S2.all),
                providers.map(item => h('option', { key: item.provider, value: item.provider }, item.displayName ?? item.provider)))),
        // 元信息行（次数 / token / 命中率 / 未定价条数）**不受隐藏开关影响**：
        // 这些不是金额，而且界面说明里写明了「token 与调用次数统计不受影响」—— 说明与行为必须一致。
        h('div', { style: sidebarCss.meta, key: 'meta' }, metaParts.join(' · ')),
        // 积分的口径旁注同样不是金额，跟着元信息行一起显示。
        creditMeta.length === 0
          ? null
          : h('div', { style: sidebarCss.meta, key: 'meta-credits' }, creditMeta.join(' · ')),
        // 模型花费卡片：位置可配（top = 紧跟今日行；bottom = 跟在峰谷条后面）
        cardPosition === 'top' ? cardNode : null,
        bar,
        scheduleNode,
        cardPosition === 'top' ? null : cardNode,
        // 价格表：来源等级「站方口径」的价目由这里更新（抓 LiteLLM 镜像 / sub2api 兜底）
        // 同样默认不显示；「价格」页有同一个按钮，更新结果也在那边报。
        showTools !== true ? null : h('div', { style: sidebarCss.priceRow, key: 'prices' },
          h('span', { style: sidebarCss.label },
            `${S2.prices}${data.prices?.fetchedAt ? ` · ${String(data.prices.fetchedAt).slice(5, 10)}` : data.prices?.bundled ? ` · ${S2.bundled}` : ''}`),
          h('button', {
            type: 'button',
            style: sidebarCss.priceButton,
            disabled: view.updating === true,
            title: S2.pricesHint,
            onClick: () => { void view.updatePrices() },
          }, view.updating === true ? S2.updating : S2.updatePrices)),
        showTools !== true || view.priceMessage === null
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
      /** 破坏性操作的按钮：用错误色，别和普通按钮长得一样。 */
      btnDanger: { height: 24, padding: '0 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-label-error, #d33)', background: 'transparent', color: 'var(--dsw-alias-label-error, #d33)', fontSize: 12, cursor: 'pointer' },
      input: { height: 24, width: 110, padding: '0 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))', background: 'transparent', color: 'inherit', fontSize: 12 },
      trend: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 60 },
      /** 热力图：横向铺满，列 = 周、行 = 星期（7 行固定） */
      heatWrap: { overflowX: 'auto', paddingBottom: 2 },
      heatGrid: { display: 'flex', gap: 2, alignItems: 'flex-start' },
      heatColumn: { display: 'flex', flexDirection: 'column', gap: 2 },
      /** 排行行：名称 + 条 + 数值 + 次数 */
      rankRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '1px 0', fontSize: 12 },
      rankName: { width: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rankBarBg: { flex: '1 1 auto', height: 6, borderRadius: 3, background: 'rgba(128,128,128,0.2)', overflow: 'hidden' },
      rankBar: { height: '100%', borderRadius: 3, background: 'var(--dsw-alias-brand-primary, #4b7bec)' },
      rankValue: { width: 96, textAlign: 'right', whiteSpace: 'nowrap' },
      rankCount: { width: 84, textAlign: 'right', whiteSpace: 'nowrap' },
      btnActive: { borderColor: 'var(--dsw-alias-brand-primary, #4b7bec)', color: 'var(--dsw-alias-brand-primary, #4b7bec)' },
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
            syncLocale(payload.data?.ui?.locale)
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
      /** 保存配置：白名单键（display / budget / retention / peakNotify / officialPeak / priceSources / 密钥扫描三项 / deepseekKeys），宿主会回传新指纹。 */
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
    storeRegistry.add(report)

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
      /** 界面偏好（隐藏区块 / 会话 ID 宽度）都从宿主下发的那一块读。 */
      const ui = data?.ui ?? {}
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
          // 「隐藏今日消耗」开启时整张今日卡不渲染（token 与调用次数统计不受影响）
          ui.hideTodayCost === true
            ? null
            : h(CostCard, { title: S.todayCost, amount: formatAmount(today?.amount, display), meta: tokenLine(today?.tokens, today?.calls) }),
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
                  h('td', { style: pageCss.tdLeft, title: row.sessionId },
                    // 默认只给前 14 位（一屏放得下）；「显示完整会话 ID」打开后给全（便于去日志里对）
                    ui.showSessionId === true ? String(row.sessionId) : String(row.sessionId).slice(0, 14)),
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

        // 「隐藏官方余额」开启时整段不渲染（共享屏幕 / 截图防泄露）
        ui.hideOfficialBalance === true ? null : h('div', { style: pageCss.section, key: 'official' },
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

    /**
     * 把逐日序列铺成「周 × 7 天」的列（热力图）。
     *
     * 第一天要对齐到它所在的星期（前面补空格子），否则整块会按天错位 ——
     * 这是热力图最容易做错的地方：日期是连续的，但「行」是星期。
     */
    function heatColumns(series) {
      const rows = Array.isArray(series) ? series : []
      if (rows.length === 0) return []
      const first = Date.parse(`${rows[0].date}T00:00:00Z`)
      const weekday = Number.isFinite(first) ? new Date(first).getUTCDay() : 0
      const cells = Array.from({ length: weekday }, () => null)
      for (const row of rows) cells.push(row)
      const columns = []
      for (let index = 0; index < cells.length; index += 7) columns.push(cells.slice(index, index + 7))
      return columns
    }

    /** 热力图强度分档（0 = 没有用量，1–4 由浅到深）。 */
    function heatLevel(value, max) {
      if (!(value > 0) || !(max > 0)) return 0
      const ratio = value / max
      if (ratio >= 0.75) return 4
      if (ratio >= 0.5) return 3
      if (ratio >= 0.25) return 2
      return 1
    }

    /** 取一整行「按模型」的 token 总数（宿主两侧都给 total，这里仍兜一层）。 */
    function modelTokens(row) {
      const tokens = row?.tokens ?? {}
      if (typeof tokens.total === 'number') return tokens.total
      return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0)
    }

    function UsageTab({ data, view }) {
      const display = data?.display
      const all = data?.totals?.all ?? {}
      const tokens = all.tokens ?? {}
      const trend = data?.trend ?? []
      const peak = Math.max(0, ...trend.map(row => row.usd ?? 0))
      const heat = data?.heatmap ?? []
      const history = data?.modelsHistory ?? {}
      /** 「历史数据」：导入是**能力探测**（不做回放），清除是**两步确认**的破坏性操作。 */
      const [probe, setProbe] = useState(null)
      const [confirming, setConfirming] = useState(false)
      const [historyMessage, setHistoryMessage] = useState(null)
      const runImport = async () => {
        try {
          setProbe(await view.post('/history/import', {}))
          setHistoryMessage(null)
        } catch (error) {
          setHistoryMessage(String(error?.message ?? error))
        }
      }
      const runClear = async () => {
        try {
          const result = await view.post('/history/clear', { confirm: HISTORY_CLEAR_TOKEN })
          setConfirming(false)
          setHistoryMessage(S.historyCleared(result.ledgerDays, result.records, result.rollupDays, result.writeFailed))
          await view.load()
        } catch (error) {
          setHistoryMessage(String(error?.message ?? error))
        }
      }
      /** 「按模型统计」：区间（今日 / 全部历史）+ 排行指标（四种）。默认展开 —— 隐藏入口等于没有。 */
      const [range, setRange] = useState('today')
      const [metric, setMetric] = useState('cost')
      const [openStats, setOpenStats] = useState(true)
      const rows = range === 'today' ? (data?.models ?? []) : (history.rows ?? [])
      const valueOf = row => {
        if (metric === 'tokens') return modelTokens(row)
        if (metric === 'hit') return row.hitRate ?? -1
        if (metric === 'perUsd') return row.perUsd ?? -1
        return row.usd ?? 0
      }
      const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a))
      const max = Math.max(0, ...sorted.map(valueOf))
      const heatMax = Math.max(0, ...heat.map(row => row.tokens ?? 0))
      const columns = heatColumns(heat)
      /**
       * 摘要读的必须是**热力图这一档自己的数**（宿主给的那段日汇总，默认 182 天），
       * 不能借 `totals.all` —— 那是另一档（默认保留 400 天），两边的量差一个数量级，
       * 「近 N 周」下面挂着全历史的数就是错的。数据就在 `heat` 里，自己求和。
       */
      const heatTokens = heat.reduce((sum, row) => sum + (Number(row?.tokens) || 0), 0)
      const heatCalls = heat.reduce((sum, row) => sum + (Number(row?.calls) || 0), 0)
      /**
       * 周数用**渲染出来的列数**：首日要按它所在的星期补位，`ceil(len / 7)` 会少算一列
       * （首日不是周日的 6/7 情况都差一）。空数据（老宿主没给 heatmap）整段不渲染摘要 ——
       * 「近 1 周 0 tokens」是编出来的数，不如什么都不说。
       */
      const heatSummaryNode = heat.length === 0
        ? null
        : h('div', { style: pageCss.note }, S.heatSummary(columns.length, formatTokens(heatTokens), heatCalls))
      const formatMetric = row => {
        if (metric === 'tokens') return formatTokens(modelTokens(row))
        if (metric === 'hit') return row.hitRate === null || row.hitRate === undefined ? '—' : `${(row.hitRate * 100).toFixed(1)}%`
        if (metric === 'perUsd') return row.perUsd === null || row.perUsd === undefined ? '—' : `${formatTokens(row.perUsd)} / $`
        return formatAmount(row.usd, display)
      }
      const cellStyle = level => ({
        width: 12,
        height: 12,
        borderRadius: 2,
        background: level === 0
          ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.22))'
          : `rgba(75, 123, 236, ${[0, 0.3, 0.5, 0.72, 1][level]})`,
      })
      return h('div', { style: pageCss.root, key: 'usage' },
        h('div', { style: pageCss.cards },
          h(CostCard, { title: S.inputTok, amount: formatTokens(tokens.input), meta: `${S.cacheTok} ${formatTokens(tokens.cacheRead)} · ${S.cacheWriteTok} ${formatTokens(tokens.cacheWrite)}` }),
          h(CostCard, { title: S.outputTok, amount: formatTokens(tokens.output), meta: `${S.reasoningTok} ${formatTokens(tokens.reasoning)}（并入输出计费）` }),
          h(CostCard, { title: S.hitRate, amount: all.hitRate === null || all.hitRate === undefined ? '—' : `${(all.hitRate * 100).toFixed(1)}%`, meta: `${S.callsCount} ${all.calls ?? 0} ${S.times} · ${S.days} ${all.days ?? 0}` })),
        // ── 26 周每日用量热力图（数据来自日汇总，比账本明细的保留期长得多）──
        h('div', { style: pageCss.section, key: 'heat' },
          h('div', { style: pageCss.sectionTitle }, S.heatTitle),
          heatSummaryNode,
          h('div', { style: pageCss.heatWrap },
            h('div', { style: pageCss.heatGrid },
              columns.map((column, index) => h('div', { style: pageCss.heatColumn, key: `w${index}` },
                column.map((row, day) => (row === null
                  ? h('div', { style: { ...cellStyle(0), opacity: 0 }, key: `p${day}` })
                  : h('div', {
                      key: row.date,
                      style: cellStyle(heatLevel(row.tokens, heatMax)),
                      title: `${row.date} · ${formatTokens(row.tokens)} · ${row.calls} ${S.times} · ${formatAmount(row.amount, display)}`,
                    })))))),
          h('div', { style: pageCss.note }, S.heatLegend))),
        // ── 按模型统计：今日 / 全部历史 双档 + 四种排行 ──
        h('div', { style: pageCss.section, key: 'models' },
          h('div', { style: pageCss.row },
            h('button', { type: 'button', style: pageCss.btn, onClick: () => setOpenStats(!openStats) }, `${openStats ? '▾' : '▸'} ${S.modelStatsTitle}`)),
          openStats
            ? h('div', { style: pageCss.section },
                h('div', { style: pageCss.row },
                  ...[['today', S.modelStatsToday], ['history', S.modelStatsHistory]].map(([key, label]) => h('button', {
                    type: 'button',
                    key,
                    style: { ...pageCss.btn, ...(range === key ? pageCss.btnActive : {}) },
                    onClick: () => setRange(key),
                  }, label)),
                  h('span', { style: pageCss.note }, S.modelStatsRank)),
                h('div', { style: pageCss.row },
                  ...[['cost', S.rankCost], ['tokens', S.rankTokens], ['hit', S.rankHit], ['perUsd', S.rankPerUsd]].map(([key, label]) => h('button', {
                    type: 'button',
                    key,
                    style: { ...pageCss.btn, ...(metric === key ? pageCss.btnActive : {}) },
                    onClick: () => setMetric(key),
                  }, label))),
                range === 'history'
                  ? h('div', { style: pageCss.note }, [
                      history.since === null || history.since === undefined
                        ? S.modelStatsEmpty
                        : S.modelStatsScope(history.since, history.days ?? 0, history.total ?? 0),
                      (history.daysMissingModels ?? 0) > 0 ? ` · ${S.modelStatsGap(history.daysMissingModels)}` : '',
                    ].join(''))
                  : null,
                sorted.length === 0
                  ? h('div', { style: pageCss.note }, S.modelStatsEmpty)
                  : h('div', null, sorted.map(row => h('div', { style: pageCss.rankRow, key: `${row.provider}/${row.model}` },
                      h('span', { style: pageCss.rankName, title: `${row.provider ?? '—'} / ${row.model}` }, row.model),
                      h('div', { style: pageCss.rankBarBg },
                        h('div', {
                          style: {
                            ...pageCss.rankBar,
                            // 命中率直接用百分比，其它按相对最大值（最大值是 0 时留一条细线，别画成满格）
                            width: `${Math.max(2, Math.min(100, max > 0 ? (Math.max(0, valueOf(row)) / max) * 100 : 0))}%`,
                          },
                        })),
                      h('span', { style: pageCss.rankValue }, formatMetric(row)),
                      h('span', { style: pageCss.rankCount }, `${row.calls ?? 0} ${S.times}${(row.unpriced ?? 0) > 0 ? ` · ${S.modelStatsUnpriced(row.unpriced)}` : ''}`)))))
            : null),
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
        // ── 历史数据：导入（能力探测）/ 清除（两步确认）──
        h('div', { style: pageCss.section, key: 'history' },
          h('div', { style: pageCss.sectionTitle }, S.historySection),
          h('div', { style: pageCss.note }, S.historyHint),
          h('div', { style: pageCss.row },
            h('button', { type: 'button', style: pageCss.btn, disabled: view.busy === true, onClick: () => { void runImport() } }, S.historyImport),
            confirming
              ? [
                  h('button', { type: 'button', key: 'go', style: pageCss.btnDanger, disabled: view.busy === true, onClick: () => { void runClear() } }, S.historyClearConfirm),
                  h('button', { type: 'button', key: 'cancel', style: pageCss.btn, onClick: () => setConfirming(false) }, S.historyClearCancel),
                ]
              : h('button', { type: 'button', style: pageCss.btn, onClick: () => { setConfirming(true); setHistoryMessage(null) } }, S.historyClear)),
          probe === null
            ? null
            : h('div', { style: pageCss.note }, S.historyProbe(probe.sessionFiles, probe.projects, probe.reason)),
          historyMessage === null
            ? null
            : h('div', { style: pageCss.note }, historyMessage)))
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

    /** `1-4,6-10` → `[{start,end}]`；非法回 null（界面据此拒绝提交，不猜）。 */
    function parsePeakWindows(textValue) {
      const out = []
      for (const part of String(textValue ?? '').split(',')) {
        const chunk = part.trim()
        if (chunk.length === 0) continue
        const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(chunk)
        if (match === null) return null
        const start = Number(match[1])
        const end = Number(match[2])
        if (start > 23 || end > 23) return null
        // `5-5` 这种退化窗口在宿主侧会被丢掉（否则跨午夜分支会判成全天高峰），
        // 这里直接当格式不对，让用户当场看出问题。
        if (start === end) return null
        out.push({ start, end })
        // 宿主对窗口有条数上限（48），超了会静默截断 —— 在界面这一侧就拒掉，
        // 别让用户以为「我配了 30 条」而实际只有前 48 条生效。
        if (out.length > PEAK_WINDOW_MAX) return null
      }
      return out
    }
    const formatPeakWindows = windows => (Array.isArray(windows) ? windows : []).map(item => `${item.start}-${item.end}`).join(',')
    const splitList = textValue => String(textValue ?? '').split(',').map(item => item.trim()).filter(item => item.length > 0)

    function DisplayTab({ data, view }) {
      const display = data?.display ?? {}
      // 保留期由宿主算好送来（`data.retention` 总是存在）；这里的数字只是老宿主兜底。
      const retention = data?.retention ?? { ledgerDays: 7, rollupDays: 400 }
      // 峰谷提醒开关同理：宿主总是送，兜底是与宿主一致的默认值。
      const notify = data?.notify ?? { enabled: false, system: false, leadMinutes: 2, type: 'both', position: 'corner' }
      // 密钥扫描设置与峰谷配置同理（老宿主没有这两个键时用与宿主一致的默认值）。
      const discovery = data?.keyDiscovery ?? { scanCredentialsFile: true, prefixes: ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY'], maxIndex: 9 }
      const allowedHosts = Array.isArray(data?.allowedHosts) ? data.allowedHosts : []
      const peakConfig = data?.officialPeak ?? {}
      // 模型花费卡片配置（宿主总是送补齐默认值的形状）
      const modelCard = data?.modelCard ?? { enabled: false, defaultExpanded: false, rememberExpanded: true, showTokens: true, showShare: true, period: 'today', rows: 5, position: 'bottom' }
      // 会话三块（宿主总是送补齐默认值的形状）
      const sessionCost = data?.sessionCost ?? { enabled: false, position: 'composer', showHitRate: true, includeSubagent: false }
      const quotaStrip = data?.quotaStrip ?? { enabled: false, showBalance: true }
      const corner = data?.corner ?? { enabled: false, showTop1: false }
      const [rawDraft, setDraft] = useState(null)
      // 四份编辑态放进**同一个** draft（各自可为 null）。
      // 非对象一律当「没在编辑」：宿主切分页会重建这个组件，状态形状不该被
      // 上一个分页留下的值污染（拿到垃圾就当没改过，回落到宿主送来的值）。
      const draft = rawDraft !== null && typeof rawDraft === 'object' ? rawDraft : {}
      const displayDraft = draft.display ?? null
      const retentionDraft = draft.retention ?? null
      const discoveryDraft = draft.discovery ?? null
      const hostsDraft = draft.hosts ?? null
      const peakDraft = draft.peak ?? null
      const leadDraft = draft.lead ?? null
      const cardRowsDraft = draft.cardRows ?? null
      const currentCardRows = cardRowsDraft ?? { rows: modelCard.rows ?? 5 }
      const cardRowsInvalid = !Number.isInteger(currentCardRows.rows) || currentCardRows.rows < 1 || currentCardRows.rows > 10
      const currentLead = leadDraft ?? { minutes: notify.leadMinutes ?? 2 }
      const leadInvalid = !Number.isInteger(currentLead.minutes) || currentLead.minutes < 1 || currentLead.minutes > 30
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
      const currentDiscovery = discoveryDraft ?? {
        scanCredentialsFile: discovery.scanCredentialsFile !== false,
        prefixes: (Array.isArray(discovery.prefixes) ? discovery.prefixes : []).join(', '),
        maxIndex: discovery.maxIndex ?? 9,
      }
      const currentPeak = peakDraft ?? {
        enabled: peakConfig.enabled !== false,
        windows: formatPeakWindows(peakConfig.windows),
        holidays: (Array.isArray(peakConfig.holidays) ? peakConfig.holidays : []).join(', '),
      }
      // Host 白名单是一行逗号分隔的文本；非法项由这里挡住（宿主那侧是静默过滤，
      // 界面不能跟着静默，否则用户以为加上了其实被丢了）。
      const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d{1,5})?$/i
      const currentHosts = hostsDraft ?? { text: allowedHosts.join(', ') }
      const hostItems = splitList(currentHosts.text).map(item => item.toLowerCase())
      const hostsInvalid = hostItems.filter(item => !HOST_PATTERN.test(item))
      const patch = (key, value) => setDraft({ ...draft, display: { ...current, [key]: value } })
      const patchRetention = (key, value) => setDraft({ ...draft, retention: { ...currentRetention, [key]: value } })
      const patchDiscovery = (key, value) => setDraft({ ...draft, discovery: { ...currentDiscovery, [key]: value } })
      const patchHosts = value => setDraft({ ...draft, hosts: { text: value } })
      const patchPeak = (key, value) => setDraft({ ...draft, peak: { ...currentPeak, [key]: value } })
      const peakWindows = parsePeakWindows(currentPeak.windows)
      // 界面偏好：语言 / 侧栏轮询间隔 / 隐藏敏感区块 / 会话 ID（其余控件各自独立保存）
      const ui = data?.ui ?? {}
      const refreshDraft = draft.refresh ?? null
      const currentRefresh = refreshDraft ?? { seconds: ui.refreshSeconds ?? 30 }
      const refreshInvalid = !Number.isInteger(currentRefresh.seconds)
        || currentRefresh.seconds < 10 || currentRefresh.seconds > 60
      const patchRefresh = value => setDraft({ ...draft, refresh: { seconds: value } })
      /**
       * 峰谷表（只读）：接下来 6 个档位切换点。
       *
       * 原来只有侧栏那行「峰谷表 · 预览 · N」能看 —— 那行现在默认不显示，所以这里补一份
       * 同一份数据的只读表（`/report` 的 `peak.upcoming`，与侧栏同一个 `upcomingSwitches`）。
       */
      const upcomingSchedule = Array.isArray(data?.peak?.upcoming) ? data.peak.upcoming : []
      return h('div', { style: pageCss.root, key: 'display' },
        h('div', { style: pageCss.section, gap: 8 },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.uiSection),
            S.localeLabel,
            h('select', {
              style: pageCss.input,
              value: ui.locale ?? 'auto',
              onChange: event => { void view.saveConfig({ ui: { locale: event.target.value } }) },
            },
              h('option', { value: 'auto' }, S.localeAuto),
              h('option', { value: 'zh' }, S.localeZh),
              h('option', { value: 'en' }, S.localeEn))),
          h('div', { style: pageCss.row },
            S.refreshSecondsLabel,
            h('input', {
              style: pageCss.input,
              type: 'number',
              min: '10',
              max: '60',
              value: currentRefresh.seconds,
              onChange: event => patchRefresh(Number(event.target.value)),
            }),
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true || refreshInvalid,
              onClick: () => { void view.saveConfig({ ui: { refreshSeconds: currentRefresh.seconds } }) },
            }, S.saveRefreshSeconds),
            refreshDraft === null ? null : h('button', { type: 'button', style: pageCss.btn, onClick: () => setDraft({ ...draft, refresh: null }) }, S.reset)),
          refreshInvalid ? h('div', { style: pageCss.error }, S.refreshSecondsBad) : null,
          h('div', { style: pageCss.note }, S.refreshSecondsHint),
          h('div', { style: pageCss.row },
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: ui.hideOfficialBalance === true,
                onChange: event => { void view.saveConfig({ ui: { hideOfficialBalance: event.target.checked } }) },
              }),
              S.hideOfficialBalance),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: ui.hideTodayCost === true,
                onChange: event => { void view.saveConfig({ ui: { hideTodayCost: event.target.checked } }) },
              }),
              S.hideTodayCost),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: ui.showSessionId === true,
                onChange: event => { void view.saveConfig({ ui: { showSessionId: event.target.checked } }) },
              }),
              S.showSessionId),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: ui.sidebarTools === true,
                onChange: event => { void view.saveConfig({ ui: { sidebarTools: event.target.checked } }) },
              }),
              S.sidebarTools)),
          h('div', { style: pageCss.note }, S.hideHint),
          h('div', { style: pageCss.note }, S.showSessionIdHint),
          h('div', { style: pageCss.note }, S.sidebarToolsHint)),
        // ── 模型花费卡片（侧栏那块）──
        h('div', { style: pageCss.section, gap: 8 },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.modelCardSection),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: modelCard.enabled === true,
                onChange: event => { void view.saveConfig({ modelCard: { enabled: event.target.checked } }) },
              }),
              S.modelCardEnabled)),
          h('div', { style: pageCss.row },
            ...[['defaultExpanded', S.modelCardDefaultExpanded], ['rememberExpanded', S.modelCardRemember],
              ['showTokens', S.modelCardShowTokens], ['showShare', S.modelCardShowShare]].map(([key, label]) => h('label', { style: pageCss.row, key },
                h('input', {
                  type: 'checkbox',
                  checked: modelCard[key] === true,
                  onChange: event => { void view.saveConfig({ modelCard: { [key]: event.target.checked } }) },
                }),
                label))),
          h('div', { style: pageCss.row },
            S.modelCardPeriod,
            h('select', {
              style: pageCss.input,
              value: modelCard.period ?? 'today',
              onChange: event => { void view.saveConfig({ modelCard: { period: event.target.value } }) },
            },
              h('option', { value: 'today' }, S.modelCardPeriodToday),
              h('option', { value: 'days90' }, S.modelCardPeriodDays90)),
            S.modelCardPosition,
            h('select', {
              style: pageCss.input,
              value: modelCard.position ?? 'bottom',
              onChange: event => { void view.saveConfig({ modelCard: { position: event.target.value } }) },
            },
              h('option', { value: 'bottom' }, S.modelCardPositionBottom),
              h('option', { value: 'top' }, S.modelCardPositionTop))),
          h('div', { style: pageCss.row },
            S.modelCardRows,
            h('input', {
              style: pageCss.input,
              type: 'number',
              min: '1',
              max: '10',
              value: currentCardRows.rows,
              onChange: event => setDraft({ ...draft, cardRows: { rows: Number(event.target.value) } }),
            }),
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true || cardRowsInvalid,
              onClick: () => { void view.saveConfig({ modelCard: { rows: currentCardRows.rows } }) },
            }, S.saveCardRows),
            cardRowsDraft === null ? null : h('button', { type: 'button', style: pageCss.btn, onClick: () => setDraft({ ...draft, cardRows: null }) }, S.reset)),
          cardRowsInvalid ? h('div', { style: pageCss.error }, S.cardRowsBad) : null,
          h('div', { style: pageCss.note }, S.modelCardHint)),
        // ── 输入区那三块：本会话费用 / 额度横条 / 右下角角标 ──
        h('div', { style: pageCss.section, gap: 8 },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.sessionCostSection),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: sessionCost.enabled === true,
                onChange: event => { void view.saveConfig({ sessionCost: { enabled: event.target.checked } }) },
              }),
              S.sessionCostEnabled),
            S.sessionCostPosition,
            h('select', {
              style: pageCss.input,
              value: sessionCost.position ?? 'composer',
              onChange: event => { void view.saveConfig({ sessionCost: { position: event.target.value } }) },
            },
              h('option', { value: 'composer' }, S.sessionCostPositionComposer),
              h('option', { value: 'header' }, S.sessionCostPositionHeader),
              h('option', { value: 'off' }, S.sessionCostPositionOff))),
          h('div', { style: pageCss.row },
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: sessionCost.showHitRate === true,
                onChange: event => { void view.saveConfig({ sessionCost: { showHitRate: event.target.checked } }) },
              }),
              S.sessionCostShowHitRate),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: sessionCost.includeSubagent === true,
                onChange: event => { void view.saveConfig({ sessionCost: { includeSubagent: event.target.checked } }) },
              }),
              S.sessionCostIncludeSubagent)),
          h('div', { style: pageCss.note }, S.sessionCostHint)),
        h('div', { style: pageCss.section, gap: 8 },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.stripSection),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: quotaStrip.enabled === true,
                onChange: event => { void view.saveConfig({ quotaStrip: { enabled: event.target.checked } }) },
              }),
              S.stripEnabled),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: quotaStrip.showBalance === true,
                onChange: event => { void view.saveConfig({ quotaStrip: { showBalance: event.target.checked } }) },
              }),
              S.stripShowBalance)),
          h('div', { style: pageCss.note }, S.stripHint)),
        h('div', { style: pageCss.section, gap: 8 },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.cornerSection),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: corner.enabled === true,
                onChange: event => { void view.saveConfig({ corner: { enabled: event.target.checked } }) },
              }),
              S.cornerEnabled),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: corner.showTop1 === true,
                onChange: event => { void view.saveConfig({ corner: { showTop1: event.target.checked } }) },
              }),
              S.cornerShowTop1)),
          h('div', { style: pageCss.note }, S.cornerHint)),
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
        h('div', { style: pageCss.section, gap: 8 },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.peakNotify),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: notify.enabled === true,
                // 勾选即写（与「概览」的预算开关同一套做法）；关掉时不动 system 这一位
                onChange: event => { void view.saveConfig({ peakNotify: { enabled: event.target.checked } }) },
              }),
              S.notifyInApp),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: notify.system === true,
                onChange: event => { void requestSystemNotify(event.target.checked, view) },
              }),
              S.notifySystem)),
          // 提前量 / 类型 / 位置：各自独立保存（局部补丁，改一个不带掉别的位）
          h('div', { style: pageCss.row },
            S.notifyLead,
            h('input', {
              style: pageCss.input,
              type: 'number',
              min: '1',
              max: '30',
              value: currentLead.minutes,
              onChange: event => setDraft({ ...draft, lead: { minutes: Number(event.target.value) } }),
            }),
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true || leadInvalid,
              onClick: () => { void view.saveConfig({ peakNotify: { leadMinutes: currentLead.minutes } }) },
            }, S.saveNotifyLead),
            leadDraft === null ? null : h('button', { type: 'button', style: pageCss.btn, onClick: () => setDraft({ ...draft, lead: null }) }, S.reset)),
          leadInvalid ? h('div', { style: pageCss.error }, S.notifyLeadBad) : null,
          h('div', { style: pageCss.row },
            S.notifyType,
            h('select', {
              style: pageCss.input,
              value: notify.type ?? 'both',
              onChange: event => { void view.saveConfig({ peakNotify: { type: event.target.value } }) },
            },
              h('option', { value: 'both' }, S.notifyTypeBoth),
              h('option', { value: 'peak' }, S.notifyTypePeak),
              h('option', { value: 'off' }, S.notifyTypeOff))),
          h('div', { style: pageCss.row },
            S.notifyPosition,
            h('select', {
              style: pageCss.input,
              value: notify.position ?? 'corner',
              onChange: event => { void view.saveConfig({ peakNotify: { position: event.target.value } }) },
            },
              h('option', { value: 'corner' }, S.notifyPositionCorner),
              h('option', { value: 'center' }, S.notifyPositionCenter))),
          h('div', { style: pageCss.row },
            h('button', { type: 'button', style: pageCss.btn, onClick: () => sidebar.previewReminder('peak') }, S.previewPeak),
            h('button', { type: 'button', style: pageCss.btn, onClick: () => sidebar.previewReminder('off') }, S.previewOff)),
          // 预览就渲染在设置页里（所见即实际触发），关闭按钮清掉它
          sidebar.reminder === null || sidebar.reminder === undefined
            ? null
            : h(PeakReminder, { reminder: sidebar.reminder, notify, onDismiss: () => sidebar.dismissReminder() }),
          h('div', { style: pageCss.note }, S.previewHint),
          h('div', { style: pageCss.note }, S.notifyHint)),
        h('div', { style: pageCss.section, gap: 8 },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.keyDiscovery),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: currentDiscovery.scanCredentialsFile === true,
                onChange: event => patchDiscovery('scanCredentialsFile', event.target.checked),
              }),
              S.scanCredentialsFile)),
          h('div', { style: pageCss.row },
            S.keyPrefixes, h('input', {
              style: { ...pageCss.input, width: 260 },
              value: currentDiscovery.prefixes,
              onChange: event => patchDiscovery('prefixes', event.target.value),
            }),
            S.keyMaxIndex, h('input', {
              style: pageCss.input,
              type: 'number',
              min: '1',
              max: '50',
              value: currentDiscovery.maxIndex,
              onChange: event => patchDiscovery('maxIndex', Number(event.target.value)),
            })),
          h('div', { style: pageCss.row },
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true,
              // 单独提交：这三个键不进计价指纹（只影响「能发现哪些 key」）
              onClick: () => {
                void view.saveConfig({
                  scanCredentialsFile: currentDiscovery.scanCredentialsFile === true,
                  deepseekKeyPrefixes: splitList(currentDiscovery.prefixes),
                  deepseekKeyMaxIndex: Number(currentDiscovery.maxIndex),
                })
              },
            }, S.saveDiscovery),
            discoveryDraft === null ? null : h('button', { type: 'button', style: pageCss.btn, onClick: () => setDraft({ ...draft, discovery: null }) }, S.reset)),
          h('div', { style: pageCss.note }, S.scanHint),
          h('div', { style: pageCss.note }, S.keyPrefixesHint)),
        h('div', { style: pageCss.section, gap: 8 },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.accessControl),
            h('label', { style: pageCss.row }, S.allowedHosts)),
          h('div', { style: pageCss.row },
            h('input', {
              style: { ...pageCss.input, width: 420 },
              placeholder: 'panel.example.com, 192.168.1.10:3080',
              value: currentHosts.text,
              onChange: event => patchHosts(event.target.value),
            })),
          h('div', { style: pageCss.row },
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true || hostsInvalid.length > 0,
              onClick: () => { void view.saveConfig({ allowedHosts: hostItems }) },
            }, S.saveHosts),
            hostsDraft === null ? null : h('button', { type: 'button', style: pageCss.btn, onClick: () => setDraft({ ...draft, hosts: null }) }, S.reset)),
          hostsInvalid.length > 0 ? h('div', { style: pageCss.error }, `${S.allowedHostsBad}：${hostsInvalid.join(', ')}`) : null,
          h('div', { style: pageCss.note }, S.allowedHostsHint)),
        h('div', { style: pageCss.section, gap: 8 },
          h('div', { style: pageCss.row },
            h('div', { style: pageCss.sectionTitle }, S.peakConfigTitle),
            h('label', { style: pageCss.row },
              h('input', {
                type: 'checkbox',
                checked: currentPeak.enabled === true,
                onChange: event => patchPeak('enabled', event.target.checked),
              }),
              S.peakEnabled)),
          h('div', { style: pageCss.row },
            S.peakWindows, h('input', {
              style: { ...pageCss.input, width: 200 },
              placeholder: '1-4,6-10',
              value: currentPeak.windows,
              onChange: event => patchPeak('windows', event.target.value),
            })),
          h('div', { style: pageCss.row },
            S.peakHolidays, h('input', {
              style: { ...pageCss.input, width: 340 },
              placeholder: '2026-10-01, 2026-10-02',
              value: currentPeak.holidays,
              onChange: event => patchPeak('holidays', event.target.value),
            })),
          h('div', { style: pageCss.row },
            h('button', {
              type: 'button',
              style: pageCss.btn,
              disabled: view.busy === true || peakWindows === null,
              // 只提交这三个键：另外三个时刻由宿主逐字段回落默认值（部分覆盖）。
              // **留空 = 不下发这个键**（回落默认），而不是提交空数组 —— 空数组在宿主侧
              // 是「有效值」，`windows: []` 会让所有调用静默按谷价计价。
              // 要停用峰谷请关掉上面的「启用峰谷档」。
              onClick: () => {
                if (peakWindows === null) return
                const patch = { enabled: currentPeak.enabled === true }
                if (String(currentPeak.windows ?? '').trim().length > 0) patch.windows = peakWindows
                const holidays = splitList(currentPeak.holidays)
                if (holidays.length > 0) patch.holidays = holidays
                void view.saveConfig({ officialPeak: patch })
              },
            }, S.savePeak),
            peakDraft === null ? null : h('button', { type: 'button', style: pageCss.btn, onClick: () => setDraft({ ...draft, peak: null }) }, S.reset)),
          peakWindows === null ? h('div', { style: pageCss.error }, S.peakWindowsBad) : null,
          h('div', { style: pageCss.note }, S.peakHint),
          // 峰谷表：与侧栏那张同一份数据（侧栏那行默认不显示，这里是常驻入口）。
          // 方向标签（→ 高峰 / → 平价）直接用侧栏那张表的文案，别在两张表里各译一份。
          h('div', { style: pageCss.row }, h('div', { style: pageCss.sectionTitle }, S.peakSchedule)),
          upcomingSchedule.length === 0
            ? h('div', { style: pageCss.note }, S.peakScheduleEmpty)
            : h('table', { style: pageCss.table },
                h('tbody', null, upcomingSchedule.map(item => h('tr', { key: String(item.atMs) },
                  h('td', { style: pageCss.tdLeft }, formatClock(item.atMs)),
                  h('td', { style: item.inPeak ? { ...pageCss.tdLeft, color: 'var(--dsw-alias-label-warning, #d98c00)' } : pageCss.tdLeft }, item.inPeak ? S2.intoPeak : S2.intoOff),
                  h('td', { style: pageCss.tdLeft }, formatCountdown(item.atMs - Date.now())))))),
          h('div', { style: pageCss.note }, S.peakScheduleHint)),
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
            : view.tab === 'usage' ? h(UsageTab, { data, view })
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

    /** 会话级费用里的短档位名（横条与角标用，比侧栏那句长的更合适）。 */
    // （字符串在 S2 里：zonePeak / zoneOff）

    /**
     * 本会话费用：按 `(sessionId, includeSubagent)` 缓存一份。
     *
     * 同一会话可能同时挂在两个位置上（输入区下方 + 会话标题栏），两处共用一份请求；
     * 15 秒 TTL 独立于侧栏轮询 —— 会话进行中这个数是用户最常盯的。
     */
    const SESSION_TTL_MS = 15_000
    const sessionStore = {
      data: null,
      error: null,
      key: null,
      at: 0,
      inflight: null,
      listeners: new Set(),
      emit() {
        for (const fn of [...this.listeners]) {
          try { fn() } catch { /* 单个订阅者出错不影响别人 */ }
        }
      },
      /** 当前 key 对应的数据（key 不匹配 = 还没拿到这一档，别拿旧档当新档）。 */
      current(sessionId, includeSubagent) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return null
        return this.key === `${sessionId}|${includeSubagent === true ? 1 : 0}` ? this.data : null
      },
      async load(sessionId, includeSubagent, force = false) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return null
        const key = `${sessionId}|${includeSubagent === true ? 1 : 0}`
        if (this.key !== key) {
          /**
           * 换档 = 把**旧档的一切**作废。
           *
           * `inflight` 必须一起清掉：它属于旧 key，复用等于「拿 A 的请求当 B 的请求」——
           * A 一次都不发，B 却把 A 的钱画在自己名下（审计实测的串数据）。
           * 清掉之后下面自然会给新 key 发一次请求。
           */
          this.key = key
          this.data = null
          this.at = 0
          this.error = null
          this.inflight = null
        }
        if (force !== true && this.data !== null && Date.now() - this.at < SESSION_TTL_MS) return this.data
        if (this.inflight !== null) return this.inflight
        // `let` + 先声明：万一 `fetch` 同步抛（假实现 / 非法 URL），`finally` 里那句
        // 身份比较也不会踩到 TDZ。
        let request = null
        request = (async () => {
          try {
            const query = `sessionId=${encodeURIComponent(sessionId)}&includeSubagent=${includeSubagent === true ? 1 : 0}`
            const response = await fetch(`${ROUTE}/session?${query}`, { headers: { accept: 'application/json' } })
            const payload = await response.json().catch(() => null)
            if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
            // 迟到的响应只认「当时那一档」：回来时 key 已经不是它了就直接丢弃，
            // 否则 A 的响应会落到 B 头上（换 key 时已经重新发过 B 的请求，不依赖这一份）。
            if (this.key !== key) return
            this.data = payload.data
            this.error = null
            this.at = Date.now()
          } catch (error) {
            if (this.key === key) this.error = String(error?.message ?? error)
          } finally {
            // 只在「这件事还是当前 in-flight」时才清位置：换 key 后新请求已经占了这里，
            // 旧响应回来不能把新请求的引用抹掉（抹掉会让下一次 load 白打第三次请求）。
            if (this.inflight === request) this.inflight = null
            this.emit()
          }
        })()
        this.inflight = request
        return request
      },
    }

    function useSessionCost(sessionId, includeSubagent, active = true) {
      const [, bump] = useState(0)
      useEffect(() => {
        // 不显示的那一处（位置不是它 / 整块关掉）**不取数也不起定时器**：
        // 宿主会把这些槽位全挂上，隐藏那处跟着一起轮询等于白打一倍请求。
        if (active !== true) return undefined
        const listener = () => bump(value => value + 1)
        sessionStore.listeners.add(listener)
        void sessionStore.load(sessionId, includeSubagent)
        const timer = setInterval(() => { void sessionStore.load(sessionId, includeSubagent, true) }, SESSION_TTL_MS)
        return () => {
          sessionStore.listeners.delete(listener)
          clearInterval(timer)
        }
      }, [sessionId, includeSubagent, active])
      return sessionStore
    }

    /**
     * 本会话费用那行文案（`null` = 还没有数据 / 宿主没给会话 id）。
     *
     * 「包含子代理」打开但宿主没给归属信息时，数字仍是**本会话**的，并明确标一句
     * 「宿主未提供子代理归属」——不能让人以为那个数已经把子代理算进去了。
     *
     * `display` = 展示币种配置（由侧栏 payload 带下来）：宿主给的是**数字**，
     * 币种符号 / 小数位都得在这里补，不能直接插值。
     */
    function sessionCostParts(data, config, display) {
      if (data === null || data === undefined) return []
      const total = config?.includeSubagent === true ? data.total : data.self
      if (total === undefined || total === null) return []
      const priced = Number(total.priced) || 0
      const unpriced = Number(total.unpriced) || 0
      /**
       * 金额：**全部未定价**时宿主给 `amount: 0` / `cost: null` —— 那是「没有价」，
       * 不是「花了 0 元」，所以显示 `—`（与设置页「今日会话」表同一判据）。
       * 一次调用都没有（`calls === 0`）同样给 `—`。
       */
      const amount = total.calls === 0 || (priced === 0 && unpriced > 0)
        ? '—'
        : formatAmount(total.amount, display)
      const parts = [`${S2.sessionCost} ${amount}`]
      if (total.calls > 0) {
        parts.push(S2.calls.replace('{n}', String(total.calls)))
        // 老宿主 / 形状漂移时可能没有 `tokens`：缺了按 0 算，别让整行炸掉。
        parts.push(`${formatTokens(total.tokens?.total)} tok`)
        if (config?.showHitRate === true && typeof total.hitRate === 'number') {
          parts.push(S2.hit.replace('{p}', (total.hitRate * 100).toFixed(1)))
        }
        if (total.unpriced > 0) parts.push(S2.unpriced.replace('{n}', String(total.unpriced)))
      }
      if (config?.includeSubagent === true && data.subagentSupported === false && data.self.calls > 0) {
        parts.push(`⚠ ${S2.sessionCostNoSubagent}`)
      }
      return parts
    }

    /**
     * 本会话费用（输入区下方 / 会话标题栏共用）。
     *
     * `slot` 由注册时的包装传进来：同一份配置里只有一处位置生效，两个槽位各自判断。
     * 宿主没给 `sessionId`（不在会话页）时什么都不渲染。
     */
    function SessionCostInline({ sessionId, slot }) {
      const view = useSidebar()
      const config = view.data?.sessionCost ?? {}
      const hasSession = typeof sessionId === 'string' && sessionId.length > 0
      // 只有「这一处正是配置选中的位置」才取数；另一处（另一个槽位）什么都不做
      const active = config.enabled === true && config.position === slot && hasSession
      const store = useSessionCost(sessionId, config.includeSubagent === true, active)
      if (active !== true) return null
      const data = store.current(sessionId, config.includeSubagent === true)
      // 展示币种在侧栏 payload 里（`/session` 只给数字，不给币种）
      const parts = sessionCostParts(data, config, view.data?.display)
      if (parts.length === 0) return null
      return h('div', {
        // 两个位置共用一套字号，但**列宽不同**：输入区那条要对齐会话内容列，标题栏那条不缩。
        style: slot === 'header' ? dockCss.sessionHeader : dockCss.session,
        title: store.error === null ? parts.join(' · ') : `${S2.sessionCostStale}：${store.error}`,
      }, parts.join(' · '))
    }

    /**
     * 额度横条（输入框上方）：今日金额 / 峰谷档位与倒计时 / 官方余额。
     * 点任意一格 = 刷新一次（与侧栏同一个 store，所以顺手也会把侧栏刷新）。
     */
    function QuotaStrip() {
      const view = useSidebar()
      const data = view.data
      if (data === null || data.quotaStrip?.enabled !== true) return null
      const config = data.quotaStrip
      const ui = data.ui ?? {}
      const chips = []
      // 预算那一格：额度没设（`ratio === null`）就不显示 —— 「没设额度」和「已用 0%」不是一回事
      const budget = data.budget
      if (budget !== null && budget !== undefined && budget.enabled === true && typeof budget.ratio === 'number') {
        const percent = (budget.ratio * 100).toFixed(1)
        chips.push(h('button', {
          type: 'button',
          key: 'budget',
          style: { ...dockCss.chip, ...(budget.ratio >= 1 ? dockCss.chipOver : budget.ratio >= 0.8 ? dockCss.chipWarn : {}) },
          title: `${S2.budgetUsed} ${formatAmount(budget.usedAmount, data.display)} / ${formatAmount(budget.amount, data.display)} · ${(S2.budgetPeriod ?? {})[budget.period] ?? budget.period}`,
          onClick: () => { void view.load() },
        }, `${S2.budgetLabel} ${percent}%`))
      }
      if (ui.hideTodayCost !== true) {
        chips.push(h('button', { type: 'button', key: 'today', style: dockCss.chip, title: S2.stripRefresh, onClick: () => { void view.load() } },
          `${S2.today} ${formatAmount(data.total?.amount, data.display)}`))
      }
      if (data.peak !== null && data.peak !== undefined) {
        /**
         * 倒计时**自己算**，别用宿主预格式化的 `peak.countdown`：宿主按 `Accept-Language`
         * 格式化那个串，而横条上别的文案跟的是 `ui.locale` —— 切到英文时会出现
         * 「整条横条英文、唯独倒计时中文」。自算还顺便让倒计时在轮询间隔里也是准的。
         */
        const countdown = Number.isFinite(data.peak.nextAtMs)
          ? formatCountdown(data.peak.nextAtMs - Date.now())
          : (Number.isFinite(data.peak.countdownMs) ? formatCountdown(data.peak.countdownMs) : '')
        chips.push(h('button', {
          type: 'button',
          key: 'peak',
          style: { ...dockCss.chip, ...(data.peak.inPeak === true ? dockCss.chipPeak : {}) },
          title: S2.stripRefresh,
          onClick: () => { void view.load() },
        }, `${data.peak.inPeak === true ? S2.zonePeak : S2.zoneOff}${countdown === '' ? '' : ` · ${countdown}`}`))
      }
      if (config?.showBalance !== false && ui.hideOfficialBalance !== true) {
        const balances = Array.isArray(data.balances) ? data.balances : []
        // 横条要跟侧栏余额行显示**同一条路线**：那个选择记在 localStorage（`ui` 里没有这个键），
        // 早先误读 `ui.balancePick`（永远是 undefined）→ 两处可能显示不同路线的钱。
        let picked = null
        try { picked = localStorage.getItem(BALANCE_PICK_KEY) } catch { /* 隐私模式下 localStorage 会抛 */ }
        const shown = balances.find(item => item.provider === picked) ?? data.balance ?? balances[0] ?? null
        if (shown !== null) {
          chips.push(h('button', { type: 'button', key: 'balance', style: dockCss.chip, title: S2.stripRefresh, onClick: () => { void view.load() } },
            `${S2.balance} ${typeof shown.amount === 'number' ? formatMoney(shown.amount, shown.currency, { ...data.display, decimals: 2 }) : '—'}`))
        }
      }
      if (chips.length === 0) return null
      return h('div', { style: dockCss.strip }, chips)
    }

    /** 右下角角标：今日金额 + 峰谷档位（可选 Top-1 模型）。 */
    function CornerBadge() {
      const view = useSidebar()
      const data = view.data
      if (data === null || data.corner?.enabled !== true) return null
      const config = data.corner
      const ui = data.ui ?? {}
      /**
       * 角标是「今日金额 + 峰谷档位（+ Top-1）」。「隐藏今日消耗」只该藏**金额那一段** ——
       * 档位和 Top-1 不是金额，整块 return null 会把它们一起干掉（用户就看不到自己在峰段了）。
       */
      const parts = []
      if (ui.hideTodayCost !== true) {
        parts.push(`${S2.today} ${formatAmount(data.total?.amount, data.display)}`)
      }
      if (data.peak !== null && data.peak !== undefined) {
        parts.push(data.peak.inPeak === true ? S2.zonePeak : S2.zoneOff)
      }
      // Top-1 模型**不依赖「模型花费卡片」那个开关** —— 否则开关打开了也不显示，
      // 用户看不出为什么（那是另一块配置）。这里用侧栏 payload 自带的今日按模型明细算。
      let top = null
      for (const row of Array.isArray(data.providers) ? data.providers : []) {
        for (const item of Array.isArray(row.models) ? row.models : []) {
          const usd = Number(item?.usd)
          if (!Number.isFinite(usd)) continue
          if (top === null || usd > top.usd) top = { model: item.model, usd }
        }
      }
      if (config?.showTop1 === true && top !== null) parts.push(`${S2.cornerTop1} ${top.model}`)
      // 全藏光了（关掉金额 + 没有峰谷档 + 没开 Top-1）就不渲染这个空角标
      if (parts.length === 0) return null
      return h('button', {
        type: 'button',
        style: dockCss.corner,
        title: S2.stripRefresh,
        onClick: () => { void view.load() },
      }, parts.join(' · '))
    }

    /**
     * 输入区上方那两条（本会话费用 / 额度横条）挂的是宿主的 `conversation.input.dock`：
     * 它是 `composerStack`（整宽、column flex）里的一条**整宽**行 —— slot 自己的根节点
     * 不会自动跟输入卡片对齐，直接渲染就贴在会话面板最左边（看着像「浮在左下角」）。
     *
     * 宿主自家的 dock（TodoPanel / QueueDock）都自己按这三个变量算宽度再居中：
     *   --dsh-composer-side-clearance（16px，输入卡片外层左右留白）
     *   --dsh-composer-dock-inset（8px，dock 相对卡片再往里缩一道）
     *   --dsh-composer-card-max-width（卡片最大宽 = 会话内容列宽 + 32px）
     * 这里照抄同一套算法（`var(…, 回退值)`：宿主哪天不给这些变量也不至于贴边），
     * 算出来的内容左边正好落在**会话内容列**（消息正文 / 卡片正文）的左边。
     * 变量名与取值来自宿主 `@deepseek-ai/dsh-client-ui-conversation` 的 ConversationRoot.module.css。
     */
    const dockColumn = {
      boxSizing: 'border-box',
      width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px)'
        + ' - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))',
      maxWidth: 'calc(var(--dsh-composer-card-max-width, 952px)'
        + ' - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))',
      margin: '0 auto',
      padding: '0 var(--dsh-composer-dock-inset, 8px)',
      flex: 'none',
    }
    /** 会话相关那三块（横条 / 角标 / 本会话费用）的样式：都贴在输入区附近，字号偏小。 */
    const dockCss = {
      // 竖向外边距自己给（横向内缩由 `dockColumn` 决定，所以 padding 在这里整条重写）
      session: { ...dockColumn, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', padding: '2px var(--dsh-composer-dock-inset, 8px)' },
      // 标题栏那处挂在会话标题栏里（不是输入区那条 dock），**不能**吃上面那套列宽：
      // 否则那行会被压到卡片宽，在标题栏里缩成一小条。
      sessionHeader: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      strip: { ...dockColumn, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '2px var(--dsh-composer-dock-inset, 8px)' },
      chip: {
        height: 20,
        padding: '0 8px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      chipPeak: { borderColor: 'var(--dsw-alias-label-warning, #d98c00)', color: 'var(--dsw-alias-label-warning, #d98c00)' },
      /** 预算 ≥80% 预警、≥100% 超支（与设置页概览同一套阈值）。 */
      chipWarn: { borderColor: 'var(--dsw-alias-label-warning, #d98c00)', color: 'var(--dsw-alias-label-warning, #d98c00)' },
      chipOver: { borderColor: 'var(--dsw-alias-label-error, #d33)', color: 'var(--dsw-alias-label-error, #d33)' },
      corner: {
        marginLeft: 'auto',
        padding: '1px 8px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
        fontSize: 11,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
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

        // ── 会话相关三块（都读侧栏 store 的同一份数据；order 参照实现用的是 5 / 9 / -5）──
        // 本会话费用：两个位置都注册，由配置里的 `position` 决定哪一处真正渲染
        //（配置随时可改，注册只发生一次，所以判断放在渲染时）。
        const withSlot = (slot, Component) => props => h(Component, { ...props, slot })
        for (const [slot, order] of [['conversation.input.dock', 4], ['conversation.session.header.actions', -5]]) {
          ctx.slots.inject(slot, () => ctx.slots.register({
            name: slot,
            id: `balance-monitor:session-cost-${slot.split('.').join('-')}`,
            order,
          }, withSlot(slot === 'conversation.input.dock' ? 'composer' : 'header', SessionCostInline)))
        }
        // 额度横条：输入框上方
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'balance-monitor:quota-strip',
          order: 5,
        }, QuotaStrip))
        // 右下角角标
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'balance-monitor:corner',
          order: 9,
        }, CornerBadge))
      },
    }
  },
})
