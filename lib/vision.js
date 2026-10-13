/**
 * 模态补全（纯函数，零依赖，可独立测试）。
 *
 * 解决的问题：在「设置 → 模型」里手工声明一个中转站供应商时，每个模型条目都没有
 * `input`，而 pi-ai 对没有 `input` 的条目回落 `DEFAULT_INPUT = ["text"]`
 * （`@deepseek-ai/dsh-llm-pi-ai`），宿主于是把图片**投影成文本占位**发给模型，
 * 模型根本收不到图 —— 表现就是「能拖图进去，但模型看不见」。
 * 中转站的模型基本都是多模态的，缺的只是这一行声明，本模块把它自动补上。
 *
 * 两条不变量：
 *   1. **只加不减**：已经声明 `image` 的条目一个字都不动。
 *   2. **显式优先**：`input: ["text"]` 是用户明确勾掉的纯文本模型，自动补全省略它
 *      （只有手动「立即补图片」的 force 模式才覆盖），免得和用户的显式选择来回打架。
 */

export const IMAGE_MODALITY = 'image'
export const TEXT_MODALITY = 'text'
/** 承载这些模型条目的 settings 段 = `llm-pi-ai` 在 profile 里的 Loader entry id。 */
export const VISION_SETTINGS_NS = 'llm-pi-ai'
/** 补全写进模型条目的字段名（pi-ai 侧是 `input`，发现接口才叫 `inputModalities`）。 */
export const VISION_FIELD = 'input'

/**
 * 一个模型条目的图片声明状态。
 *   `yes`           已声明图片
 *   `explicit-text` 显式声明了非空模态但没图片（用户勾了纯文本）
 *   `undeclared`    没声明过（`input` 缺失或空数组 —— 两者 schema 上一回事）
 * @param {object} model 一个 `providers.<id>.models[]` 条目
 * @returns {'yes' | 'explicit-text' | 'undeclared'}
 */
export function imageState(model) {
  const input = Array.isArray(model?.[VISION_FIELD])
    ? model[VISION_FIELD].filter(item => typeof item === 'string')
    : []
  if (input.includes(IMAGE_MODALITY)) return 'yes'
  return input.length > 0 ? 'explicit-text' : 'undeclared'
}

/**
 * 把一个 provider profile 的模型清单裁成补全需要的形状（带原下标，写入要用）。
 * @param {object} profile `providers.<id>`
 * @returns {Array<{ index: number, id: string, image: string }>}
 */
export function readModels(profile) {
  const models = Array.isArray(profile?.models) ? profile.models : []
  return models.map((model, index) => ({
    index,
    id: typeof model?.id === 'string' ? model.id : '',
    image: imageState(model),
  }))
}

/**
 * 一个供应商的补全计划：要写哪几条 op、动了哪几个模型。
 *
 * 路径是相对 settings 段（`llm-pi-ai`）的 volatile 投影写的 —— `dsh-settings` 的
 * `mutate(ns, ops, revision)` 只接受落在 volatile 节点下的路径，而 `providers`
 * 正是 `.volatile()` 的那个节点，所以 `providers.<id>.models.<n>.input` 合法。
 * 数组下标按 `applyPathOp` 的要求写成十进制字符串。
 *
 * @param {string} provider provider id（settings 里 `providers` 的键）
 * @param {Array<{ index: number, id: string, image: string }>} models readModels() 的结果
 * @param {{ force?: boolean }} [options] force=true 连显式纯文本也一起补
 * @returns {{ ops: object[], models: Array<{ index: number, id: string }> }}
 */
export function planVisionOps(provider, models, { force = false } = {}) {
  if (typeof provider !== 'string' || provider.length === 0) return { ops: [], models: [] }
  const targets = (Array.isArray(models) ? models : []).filter(model => {
    if (model?.image === 'yes') return false
    return force === true || model?.image === 'undeclared'
  })
  return {
    ops: targets.map(model => ({
      op: 'set',
      path: ['providers', provider, 'models', String(model.index), VISION_FIELD],
      value: [TEXT_MODALITY, IMAGE_MODALITY],
    })),
    models: targets.map(model => ({ index: model.index, id: model.id })),
  }
}
