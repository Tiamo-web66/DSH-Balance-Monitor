/**
 * `llm/stream` 计费包裹（纯包装器，零依赖，可用假流单测）。
 *
 * 宿主的 `llm/stream` 是一条监听器瀑布：每次 `ctx.llm.stream()` 都会把全部监听器
 * 按注册序串起来。本包装器只做三件事：
 *   1. **发请求前**跑一次 `prepare(options)`（自动换 key 用；在 `next()` 之前，
 *      这样宿主适配器解析凭据时看到的是换过之后的值）；
 *   2. 透传数据块（不改流协议），顺手记住最后一个 `type === 'usage'` 的 usage 块；
 *   3. 流结束时把这次调用交给 `account()`；遇到 `QUOTA` / 402 时额外通知 `onQuota()`。
 *
 * 三个必须保留的细节（都是踩过的坑）：
 *   - **按请求发起时刻计价**：一次流式调用可能跨峰谷整点，用完成时刻会把几分钟前
 *     发起的请求算进另一档。`prepare` 之后再取时刻，所以换 key 的耗时不算进请求。
 *   - **嵌套只记一次**：包装路由（在自己 `stream()` 体内再调 `ctx.llm.stream()`）会让
 *     同一次请求沿瀑布每层各走一遍；用 `AsyncLocalStorage` 深度标记识别嵌套，内层
 *     直接透传不再包一层。ALS 按异步上下文隔离，并发请求互不误伤。
 *   - **提前中断要显式关流**：手写 `for(;;)` 没有 `for await` 的自动关闭语义，消费方
 *     break/throw 时必须向下游传播 `return()`，否则上游流跑完、usage 无人读。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const llmStreamDepth = new AsyncLocalStorage()

/**
 * 造一个计费监听器。
 *
 * @param {object} deps
 * @param {(usage: object, model: string, sessionId: string, atMs: number, provider: string, options?: object) => void} deps.account
 *   计费回调（五参签名与 usage 桶映射对齐，见 lib/index.js 的 account）。
 * @param {() => number} [deps.now] 时钟源（测试注入用）。
 * @param {(options: object) => Promise<void> | void} [deps.prepare]
 *   真正发请求之前的钩子（自动换 key）。抛错只记日志，不阻断请求。
 * @param {(options: object, failure: object) => void} [deps.onQuota]
 *   流里出现 QUOTA / 402 时通知一次（给下一次请求换 key 用）。
 * @returns {(options: object, next: () => AsyncIterable) => AsyncIterable} 宿主监听器
 */
export function createLlmStreamBilling({ account, now = Date.now, prepare, onQuota } = {}) {
  return (options, next) => {
    // 嵌套内层：外层已经记账 / 已经 prepare 过，直接透传。
    if (llmStreamDepth.getStore() !== undefined) return next()
    return (async function* balanceMonitorStream() {
      if (typeof prepare === 'function') {
        try {
          await prepare(options)
        } catch (error) {
          console.warn(`[dsh-balance-monitor] 请求前检查失败：${String(error?.message ?? error)}`)
        }
      }
      const startedAtMs = now()
      // 注意：next() 必须等 prepare 完成后再调用 —— 宿主适配器在这条链里解析
      // 凭据；先换 key 再 next()，当前这次请求就能直接用上新 key。
      const downstream = next()
      let usage = null
      let quotaNotified = false
      const iterator = downstream[Symbol.asyncIterator]()
      let completed = false
      try {
        for (;;) {
          // 在深度标记内拉取下游：下游适配器体内再发起的 llm/stream 会继承这个标记，
          // 其监听器据此判定为嵌套调用，不再重复记账。
          const result = await llmStreamDepth.run(1, () => iterator.next())
          if (result.done) break
          const chunk = result.value
          if (chunk !== null && chunk !== undefined && chunk.type === 'usage' && chunk.usage != null) {
            usage = chunk.usage
          }
          if (!quotaNotified && chunk !== null && chunk !== undefined
            && chunk.type === 'finish' && chunk.reason?.kind === 'error') {
            const failure = chunk.reason.failure ?? chunk.reason.error
            if (failure?.code === 'QUOTA' || Number(failure?.status) === 402) {
              quotaNotified = true
              try {
                onQuota?.(options, failure)
              } catch (error) {
                console.warn(`[dsh-balance-monitor] QUOTA 通知失败：${String(error?.message ?? error)}`)
              }
            }
          }
          yield chunk
        }
        completed = true
      } finally {
        if (!completed) {
          try {
            await iterator.return?.()
          } catch {
            // 下游已经在退出，忽略关闭错误
          }
        }
        if (usage !== null && typeof account === 'function') {
          try {
            // 第 6 个参数把整个 options 交给记账方：宿主给了什么（比如子代理的
            // 父会话 id）就让记账自己挑，包裹层不做字段白名单。
            account(usage, options?.model, options?.sessionId, startedAtMs, options?.provider, options)
          } catch (error) {
            console.warn(`[dsh-balance-monitor] 计费失败：${String(error?.message ?? error)}`)
          }
        }
      }
    })()
  }
}

/** 把宿主的 usage 块裁成五个 token 桶（非有限/负数按 0）。 */
export function usageBuckets(usage) {
  const count = value => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : 0
  }
  return {
    input: count(usage?.inputTokens),
    output: count(usage?.outputTokens),
    cacheRead: count(usage?.cacheReadTokens),
    cacheWrite: count(usage?.cacheWriteTokens),
    reasoning: count(usage?.reasoningTokens),
  }
}
