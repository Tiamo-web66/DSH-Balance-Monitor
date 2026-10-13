/**
 * 从凭据文件里读**引用名**（`~/.dsh/.credentials.yaml` 的 `refs:` 段）。
 *
 * ## 为什么需要它
 *
 * 宿主凭据服务没有枚举 refs 的公开接口（`listRecords()` 只管 `records:` 段），
 * 而 API Key 存在 `refs:` 里。于是「你都配了哪些 key」只能靠猜候选名
 * （`DEEPSEEK_API_KEY_2…_9` 那种）——命名不落规律就扫不到。
 * 本模块把 refs 段的**键名**直接读出来，命名再怪也列得全。
 *
 * ## 边界（写死在实现里）
 *
 * - **只取键名**：解析函数从不把「值」放进返回值，只用正则匹配 `名字:` 这一层；
 *   嵌套在某个引用下面的结构（grant payload 之类）一律不进结果。
 * - 只读 `refs:` 段：`records:` 段（登录 grant）完全跳过。
 * - 失败即空：文件不存在 / 读不了 / 结构怪 → 返回 `ok: false` 与空名单，**不抛**。
 * - 关掉的方式：`state.json` 里 `scanCredentialsFile: false`，插件就退回纯候选名探测。
 */
import { readFileSync } from 'node:fs'

/** 合法引用名（与宿主 `credentialKey` 的文法一致）。 */
export const REF_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 解析 YAML 文本里 `refs:` 段的键名。
 *
 * 只认块状写法（宿主就是这么写的）：
 * ```yaml
 * refs:
 *   DEEPSEEK_API_KEY: sk-...
 *   DSK_BACKUP_1:
 * ```
 * 同一个缩进层级上、看起来像 `名字:` 的行才算引用；再深一层的行（某个引用的结构化内容）
 * 一律忽略。值是**连读都不读**的（正则只捕获冒号前的名字）。
 *
 * @param {string} text 文件内容
 * @returns {string[]} 引用名（去重、保序）
 */
export function parseRefNames(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const names = []
  let inRefs = false
  let refIndent = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '')
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    // 顶层的 `refs:` / 其它顶层键
    if (indent === 0) {
      const top = /^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/.exec(trimmed)
      inRefs = top !== null && top[1] === 'refs' && !/^\{\s*\}/.test(top[2].trim())
      refIndent = null
      continue
    }
    if (!inRefs) continue
    if (refIndent === null) refIndent = indent
    // 只认与第一条引用同缩进、且形如 `名字:` 的行；更深层的内容不进结果
    if (indent !== refIndent) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(trimmed)
    if (match === null) continue
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

/**
 * 读凭据文件里的引用名。
 *
 * @param {string} file 凭据文件路径（通常是 `$DSH_HOME/.credentials.yaml`）
 * @param {{ readImpl?: (file: string, encoding: string) => string }} [options]
 * @returns {{ ok: boolean, file: string, names: string[], error?: string }}
 */
export function readRefNames(file, { readImpl = readFileSync } = {}) {
  try {
    const text = readImpl(file, 'utf8')
    return { ok: true, file, names: parseRefNames(text) }
  } catch (error) {
    // 文件不存在 / 权限不足都走这里：探测退回候选名，不影响任何其它功能
    return { ok: false, file, names: [], error: String(error?.message ?? error) }
  }
}
