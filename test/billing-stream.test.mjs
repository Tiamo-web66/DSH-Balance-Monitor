#!/usr/bin/env node
/**
 * `llm/stream` 包装器的顺序保证（不出网）：
 *   1. prepare 必须在 next() 之前跑完 —— 自动换 key 靠这条顺序；
 *   2. 流里的 usage 照常交给 account()；
 *   3. finish/error 里的 QUOTA / 402 通知 onQuota 一次。
 *
 *   node test/billing-stream.test.mjs
 */
import assert from 'node:assert/strict'
import { createLlmStreamBilling } from '../lib/billing-stream.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    const note = await fn()
    passed++
    console.log(`  ok   ${name}${note === undefined ? '' : `  → ${note}`}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

console.log('\n[llm/stream 包装器：prepare → next → 记账 / QUOTA]')
await test('prepare 完成之前不调用 next（当前请求才能用上新 key）', async () => {
  const order = []
  const listener = createLlmStreamBilling({
    prepare: async () => {
      await Promise.resolve()
      order.push('prepare')
    },
    account: () => order.push('account'),
  })
  const stream = listener({ provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 's' }, () => {
    order.push('next')
    return (async function* () {
      yield { type: 'text', text: 'hi' }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }
    })()
  })
  for await (const _chunk of stream) { /* drain */ }
  assert.deepEqual(order, ['prepare', 'next', 'account'])
})

await test('finish/error 的 QUOTA 只通知一次，流仍原样透传', async () => {
  const chunks = []
  const failures = []
  const listener = createLlmStreamBilling({
    onQuota: (_options, failure) => failures.push(failure),
  })
  const stream = listener({ provider: 'deepseek-official' }, () => (async function* () {
    yield { type: 'text', text: 'partial' }
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Insufficient Balance', code: 'QUOTA', status: 402 } } }
  })())
  for await (const chunk of stream) chunks.push(chunk.type)
  assert.deepEqual(chunks, ['text', 'finish'], '错误块不能被吞掉')
  assert.equal(failures.length, 1)
  assert.equal(failures[0].status, 402)
})

await test('prepare 抛错不阻断请求（只记日志）', async () => {
  let called = false
  const listener = createLlmStreamBilling({
    prepare: () => { throw new Error('switch failed') },
  })
  const stream = listener({}, () => {
    called = true
    return (async function* () { yield { type: 'text', text: 'ok' } })()
  })
  for await (const _chunk of stream) { /* drain */ }
  assert.equal(called, true)
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
