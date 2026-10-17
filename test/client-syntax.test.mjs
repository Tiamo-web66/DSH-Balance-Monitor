// 语法检查：把 ModuleLoader 的 factory 体切出来，包成一个普通函数再 parse。
// （lib/client.js 顶层是 `window.__ModuleLoader__.load({...})`，Node 里直接 require 会炸。）
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = src.indexOf('factory(require) {')
if (start < 0) throw new Error('找不到 factory(require) {')
const bodyStart = start + 'factory(require) {'.length
const bodyEnd = src.lastIndexOf('},\n})')
if (bodyEnd < 0) throw new Error('找不到收尾')
const body = src.slice(bodyStart, bodyEnd)
const script = `(function (require) {${body}})`
// eslint-disable-next-line no-new-func
new Function('require', `return ${script}`)
console.log('client.js parse OK ·', body.split('\n').length, '行')
