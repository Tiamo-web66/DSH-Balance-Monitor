/**
 * 侧栏「进行中」轨道的纯推导。客户端半身（lib/client.js）里有一份同逻辑拷贝，
 * 因为 ModuleLoader 半身不能 import ESM；本文件给离线测试用。
 */

export function visiblePendingKind(kind) {
  if (kind === 'approval' || kind === 'plan-review' || kind === 'question') return kind
}

export function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function pathIsAncestor(parent, child) {
  const a = normalizePath(parent)
  const b = normalizePath(child)
  if (!a || !b || a === b) return false
  return b.startsWith(`${a}/`)
}

export function workspaceLabel(path, fallback = '') {
  if (typeof path !== 'string' || path.length === 0) return fallback
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || fallback
}

export function runningChildCount(list, parentId, statuses) {
  const catalog = list?.projectionsBySession?.[parentId]?.values?.subagentCatalog
  if (!Array.isArray(catalog) || catalog.length === 0) return 0
  return catalog.reduce((count, child) => {
    const id = child?.id
    if (!id) return count
    const running = statuses?.get?.(id)?.running ?? list.byId?.[id]?.running
    return count + (running === true ? 1 : 0)
  }, 0)
}

export function sessionTitleOf(session, fallback) {
  const title = session?.title?.trim?.() || session?.displayTitle?.trim?.()
  return title || fallback || session?.id || ''
}

export function collectLiveSessions({ list, workspaces, statuses, archivedIds }) {
  const archived = new Set(archivedIds ?? [])
  const items = []
  for (const id of list?.ids ?? []) {
    const session = list.byId?.[id]
    if (!session) continue
    if (session.origin === 'subagent') continue
    if (session.blank) continue
    if (archived.has(id)) continue
    const status = statuses?.get?.(id)
    const pending = visiblePendingKind(status?.pendingInteraction?.kind)
    const running = status?.running ?? session.running
    const subagentCount = runningChildCount(list, id, statuses)
    if (!pending && running !== true && subagentCount === 0) continue
    const workspace = (workspaces ?? []).find((row) => row.sessionIds?.includes(id))
    items.push({
      id,
      title: sessionTitleOf(session, id),
      updatedAt: Number(session.updatedAt) || 0,
      pending: pending || undefined,
      running: running === true,
      subagentCount,
      current: (session.retainedBy?.mainView ?? 0) > 0,
      workspaceId: workspace?.workspaceId,
      workspaceTitle: workspace?.title?.trim?.() || workspaceLabel(workspace?.path, ''),
      workspacePath: workspace?.path,
    })
  }
  items.sort((a, b) => {
    const pa = a.pending ? 0 : 1
    const pb = b.pending ? 0 : 1
    if (pa !== pb) return pa - pb
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return items
}

export function workspaceLiveCounts(live, workspaces, visibleWorkspaceIds) {
  const visible = new Set(visibleWorkspaceIds ?? [])
  const counts = new Map()
  for (const workspace of workspaces ?? []) {
    const own = live.filter((row) => row.workspaceId === workspace.workspaceId)
    let count = own.length
    let pending = own.some((row) => row.pending)
    for (const other of workspaces ?? []) {
      if (other.workspaceId === workspace.workspaceId) continue
      if (!pathIsAncestor(workspace.path, other.path)) continue
      if (visible.has(other.workspaceId)) continue
      const nested = live.filter((row) => row.workspaceId === other.workspaceId)
      count += nested.length
      if (nested.some((row) => row.pending)) pending = true
    }
    if (count > 0) counts.set(workspace.workspaceId, { count, pending })
  }
  return counts
}
