/**
 * `llm/stream` 计费包裹（纯包装器，零依赖，可用假流单测）。
 *
 * 宿主的 `llm/stream` 是一条监听器瀑布：每次 `ctx.llm.stream()` 都会把全部监听器
 * 按注册序串起来。本包装器只做两件事：
 *   1. 透传数据块（不改流协议），顺手记住最后一个 `type === 'usage'` 的 usage 块；
 *   2. 流结束时把这次调用交给 `account()`（含发起时刻，供峰谷档位判定）。
 *
 * 三个必须保留的细节（都是踩过的坑）：
 *   - **按请求发起时刻计价**：一次流式调用可能跨峰谷整点，用完成时刻会把几分钟前
 *     发起的请求算进另一档。
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
 * @param {(usage: object, model: string, sessionId: string, atMs: number, provider: string) => void} deps.account
 *   计费回调（五参签名与 usage 桶映射对齐，见 lib/index.js 的 account）。
 * @param {() => number} [deps.now] 时钟源（测试注入用）。
 * @returns {(options: object, next: () => AsyncIterable) => AsyncIterable} 宿主监听器
 */
export function createLlmStreamBilling({ account, now = Date.now } = {}) {
  return (options, next) => {
    const downstream = next()
    // 嵌套内层：外层已经记过账，直接透传。
    if (llmStreamDepth.getStore() !== undefined) return downstream
    const startedAtMs = now()
    return (async function* balanceMonitorStream() {
      let usage = null
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
