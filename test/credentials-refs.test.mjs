#!/usr/bin/env node
/**
 * 凭据文件「只取键名」解析验证（不出网、不碰真凭据文件）。
 *
 *   node test/credentials-refs.test.mjs
 */
import assert from 'node:assert/strict'

import { REF_NAME_PATTERN, parseRefNames, readRefNames } from '../lib/credentials-refs.js'

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

/** 照宿主真实写法的样本（值用假串，断言里会检查它们没被带出来）。 */
const SAMPLE = `version: 1
refs:
  JIUHAOCHE_API_KEY: fake-jiuhaoche-SECRET
  DEEPSEEK_API_KEY: fake-deepseek-SECRET
  DSK_BACKUP_1: fake-backup-SECRET
  weird-name.suffix: fake-weird-SECRET
  # 注释行不算
records:
  deepseek-account-platform/default:
    kind: grant
    payload:
      version: 1
      token: fake-token-SECRET
      issuer: https://platform.deepseek.com
  deepseek-account-platform/device:
    kind: grant
`

console.log('\n[parseRefNames：只取 refs 段的键名]')
test('取出全部引用名，且**不含任何值**', () => {
  const names = parseRefNames(SAMPLE)
  assert.deepEqual(names, ['JIUHAOCHE_API_KEY', 'DEEPSEEK_API_KEY', 'DSK_BACKUP_1'])
  const leaked = JSON.stringify({ names }).includes('SECRET')
  assert.equal(leaked, false, '返回值里不该出现任何值片段')
  return names.join(', ')
})
test('只覆盖 refs 段：records 段里的 token 一律不进结果', () => {
  const names = parseRefNames(SAMPLE)
  assert.equal(names.includes('token'), false)
  assert.equal(names.includes('payload'), false)
  assert.equal(JSON.stringify(names).includes('fake-token'), false)
  return `records 段被跳过（${names.length} 个引用名）`
})
test('引用名带 `-`/`.`（不合键名文法）被跳过，不会污染候选', () => {
  const names = parseRefNames(SAMPLE)
  assert.equal(names.includes('weird-name.suffix'), false)
  assert.equal(REF_NAME_PATTERN.test('weird-name.suffix'), false)
  assert.equal(REF_NAME_PATTERN.test('DSK_BACKUP_1'), true)
})
test('嵌套在引用下面的结构化内容不当作引用名', () => {
  const text = ['refs:', '  MAIN_KEY:', '    nested: 1', '    deeper:', '  SECOND_KEY: v'].join('\n')
  assert.deepEqual(parseRefNames(text), ['MAIN_KEY', 'SECOND_KEY'])
})
test('空 / 内联空映射 / 缺 refs 段 / 脏输入都不炸', () => {
  assert.deepEqual(parseRefNames(''), [])
  assert.deepEqual(parseRefNames('refs: {}\n'), [])
  assert.deepEqual(parseRefNames('version: 1\nrecords:\n  a:\n    kind: grant\n'), [])
  for (const bad of [null, undefined, 42, {}, []]) assert.deepEqual(parseRefNames(bad), [])
})
test('CRLF 与 BOM 也能解析', () => {
  const text = '\uFEFFversion: 1\r\nrefs:\r\n  CRLF_KEY: v\r\n'
  assert.deepEqual(parseRefNames(text), ['CRLF_KEY'])
})

console.log('\n[readRefNames：读文件]')
test('读得到：返回 ok + 名字，且不含值', () => {
  const result = readRefNames('/tmp/whatever.yaml', { readImpl: () => SAMPLE })
  assert.equal(result.ok, true)
  assert.deepEqual(result.names, ['JIUHAOCHE_API_KEY', 'DEEPSEEK_API_KEY', 'DSK_BACKUP_1'])
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
})
test('读不到（文件不存在 / 权限不足）→ ok:false + 空名单 + 原因，不抛', () => {
  const result = readRefNames('/tmp/missing.yaml', {
    readImpl: () => { throw new Error('ENOENT: no such file or directory') },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.names, [])
  assert.match(result.error, /ENOENT/)
  return result.error.slice(0, 40)
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
