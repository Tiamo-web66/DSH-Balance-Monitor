#!/usr/bin/env node
/**
 * 模态补全纯函数验证（不出网、不碰宿主）。
 *
 *   node test/vision.test.mjs
 */
import assert from 'node:assert/strict'

import { IMAGE_MODALITY, TEXT_MODALITY, VISION_FIELD, VISION_SETTINGS_NS, imageState, planVisionOps, readModels } from '../lib/vision.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    const note = fn()
    passed++
    console.log(`  ok   ${name}${note === undefined ? '' : `  → ${note}`}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

console.log('\n[imageState：三种声明状态]')
test('缺 input / 空数组都算「没声明」', () => {
  assert.equal(imageState({ id: 'a' }), 'undeclared')
  assert.equal(imageState({ id: 'b', input: [] }), 'undeclared')
  assert.equal(imageState({ id: 'c', input: null }), 'undeclared')
  assert.equal(imageState(undefined), 'undeclared')
})
test('非空且无 image 算「显式纯文本」', () => {
  assert.equal(imageState({ input: ['text'] }), 'explicit-text')
  assert.equal(imageState({ input: ['text', 'audio'] }), 'explicit-text')
  assert.equal(imageState({ input: ['audio'] }), 'explicit-text')
})
test('含 image 就算已声明（顺序无关，脏值忽略）', () => {
  assert.equal(imageState({ input: ['image'] }), 'yes')
  assert.equal(imageState({ input: ['text', IMAGE_MODALITY] }), 'yes')
  assert.equal(imageState({ input: ['image', 42, null] }), 'yes')
})

console.log('\n[readModels：带上原下标]')
test('下标保留（写入要用原位置），id 缺失退化成空串', () => {
  const models = readModels({ models: [{ id: 'a' }, {}, { id: 'c', input: ['text', 'image'] }] })
  assert.deepEqual(models, [
    { index: 0, id: 'a', image: 'undeclared' },
    { index: 1, id: '', image: 'undeclared' },
    { index: 2, id: 'c', image: 'yes' },
  ])
})
test('models 不是数组时给空清单', () => {
  assert.deepEqual(readModels({}), [])
  assert.deepEqual(readModels({ models: 'nope' }), [])
})

console.log('\n[planVisionOps：补哪些、写成什么]')
test('默认只补「没声明过」的，显式纯文本跳过', () => {
  const models = readModels({ models: [{ id: 'a' }, { id: 'b', input: ['text'] }, { id: 'c', input: ['text', 'image'] }] })
  const plan = planVisionOps('wbfd', models, { force: false })
  assert.deepEqual(plan.ops, [
    { op: 'set', path: ['providers', 'wbfd', 'models', '0', VISION_FIELD], value: [TEXT_MODALITY, IMAGE_MODALITY] },
  ])
  assert.deepEqual(plan.models, [{ index: 0, id: 'a' }])
})
test('force 时连显式纯文本也补，已声明 image 的仍然不动', () => {
  const models = readModels({ models: [{ id: 'a' }, { id: 'b', input: ['text'] }, { id: 'c', input: ['text', 'image'] }] })
  const plan = planVisionOps('wbfd', models, { force: true })
  assert.deepEqual(plan.ops.map(op => op.path.join('.')), [
    'providers.wbfd.models.0.input',
    'providers.wbfd.models.1.input',
  ])
  assert.deepEqual(plan.models.map(model => model.id), ['a', 'b'])
})
test('全部已声明时返回空计划（调用方据此零写入）', () => {
  const models = readModels({ models: [{ id: 'a', input: ['text', 'image'] }] })
  assert.deepEqual(planVisionOps('wbfd', models, { force: true }), { ops: [], models: [] })
})
test('provider 非法就什么都不写', () => {
  const models = readModels({ models: [{ id: 'a' }] })
  assert.deepEqual(planVisionOps('', models), { ops: [], models: [] })
  assert.deepEqual(planVisionOps(undefined, models), { ops: [], models: [] })
})
test('路径常量对得上（写的是 llm-pi-ai 段的 providers.<id>.models[].input）', () => {
  assert.equal(VISION_SETTINGS_NS, 'llm-pi-ai')
  assert.equal(VISION_FIELD, 'input')
  const [op] = planVisionOps('p', [{ index: 7, id: 'm', image: 'undeclared' }]).ops
  assert.deepEqual(op.path.slice(0, 2), ['providers', 'p'])
  assert.equal(op.path[3], '7', '数组下标必须是十进制字符串（applyPathOp 的校验）')
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
