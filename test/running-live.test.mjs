// 侧栏「进行中 / 待查看」两段的纯推导：完成未读分区、优先级、子代理、归档与排序。
import assert from 'node:assert/strict'
import {
  collectCompletedSessions,
  collectLiveSessions,
  pathIsAncestor,
  workspaceLabel,
  workspaceLiveCounts,
} from '../lib/running-live.js'

const statuses = new Map([
  ['wait', { running: true, pendingInteraction: { kind: 'approval' } }],
  ['run', { running: true }],
  ['idle', { running: false }],
  ['child', { running: true }],
])

const list = {
  ids: ['wait', 'run', 'idle', 'blank', 'arch', 'child', 'subrun'],
  byId: {
    wait: { id: 'wait', title: 'Need yes', running: true, updatedAt: 10, retainedBy: { mainView: 1 } },
    run: { id: 'run', displayTitle: 'Busy', running: true, updatedAt: 30, retainedBy: {} },
    idle: { id: 'idle', title: 'Done', running: false, updatedAt: 40, retainedBy: {} },
    blank: { id: 'blank', title: 'New', blank: true, running: true, updatedAt: 50, retainedBy: {} },
    arch: { id: 'arch', title: 'Old', running: true, updatedAt: 60, retainedBy: {} },
    child: { id: 'child', title: 'Worker', origin: 'subagent', running: true, updatedAt: 70, retainedBy: {} },
    subrun: { id: 'subrun', title: 'Parent', running: false, updatedAt: 20, retainedBy: {} },
  },
  projectionsBySession: {
    subrun: { values: { subagentCatalog: [{ id: 'child' }] } },
  },
}

const workspaces = [
  { workspaceId: 'root', title: 'Root', path: 'D:/ws', sessionIds: ['wait'] },
  { workspaceId: 'child-ws', title: 'Child', path: 'D:/ws/app', sessionIds: ['run', 'subrun'] },
]

const live = collectLiveSessions({
  list,
  workspaces,
  statuses,
  archivedIds: ['arch'],
})

assert.deepEqual(live.map((row) => row.id), ['wait', 'run', 'subrun'])
assert.equal(live[0].pending, 'approval')
assert.equal(live[0].current, true)
assert.equal(live[1].workspaceTitle, 'Child')
assert.equal(live[2].subagentCount, 1)
assert.equal(pathIsAncestor('D:\\ws', 'D:\\ws\\app'), true)
assert.equal(pathIsAncestor('D:/ws/app', 'D:/ws'), false)
assert.equal(workspaceLabel('D:\\ws\\app\\'), 'app')

const collapsedParent = workspaceLiveCounts(live, workspaces, ['root'])
assert.equal(collapsedParent.get('root')?.count, 3)
assert.equal(collapsedParent.get('root')?.pending, true)

const bothVisible = workspaceLiveCounts(live, workspaces, ['root', 'child-ws'])
assert.equal(bothVisible.get('root')?.count, 1)
assert.equal(bothVisible.get('child-ws')?.count, 2)

// ── 待查看：只收 completionUnread，且不能和进行中重叠 ──────────────────────
const completedStatuses = new Map([
  ['done-new', { running: false, completionUnread: true }],
  ['done-old', { running: false, completionUnread: true }],
  ['done-pending', { running: false, completionUnread: true, pendingInteraction: { kind: 'question' } }],
  ['done-running', { running: true, completionUnread: true }],
  ['done-parent', { running: false, completionUnread: true }],
  ['done-arch', { running: false, completionUnread: true }],
  ['done-child', { running: false, completionUnread: true }],
  ['done-blank', { running: false, completionUnread: true }],
  ['idle', { running: false }],
  ['kid', { running: true }],
])
const completedList = {
  ids: [
    'done-new', 'done-old', 'done-pending', 'done-running',
    'done-parent', 'done-arch', 'done-child', 'done-blank', 'idle',
  ],
  byId: {
    'done-new': { id: 'done-new', title: 'Newest done', running: false, updatedAt: 300, retainedBy: {} },
    'done-old': { id: 'done-old', title: 'Older done', running: false, updatedAt: 200, retainedBy: {} },
    'done-pending': { id: 'done-pending', title: 'Needs answer', running: false, updatedAt: 500, retainedBy: {} },
    'done-running': { id: 'done-running', title: 'Still running', running: true, updatedAt: 400, retainedBy: {} },
    'done-parent': { id: 'done-parent', title: 'Parent with child', running: false, updatedAt: 250, retainedBy: {} },
    'done-arch': { id: 'done-arch', title: 'Archived', running: false, updatedAt: 600, retainedBy: {} },
    'done-child': { id: 'done-child', title: 'Subagent', origin: 'subagent', running: false, updatedAt: 700, retainedBy: {} },
    'done-blank': { id: 'done-blank', title: 'Blank', blank: true, running: false, updatedAt: 800, retainedBy: {} },
    'idle': { id: 'idle', title: 'Idle', running: false, updatedAt: 900, retainedBy: {} },
  },
  projectionsBySession: {
    'done-parent': { values: { subagentCatalog: [{ id: 'kid' }] } },
  },
}
const completedWorkspaces = [
  { workspaceId: 'alpha', title: 'Alpha', path: 'D:/alpha', sessionIds: ['done-new', 'done-old', 'done-pending'] },
  { workspaceId: 'beta', title: 'Beta', path: 'D:/beta', sessionIds: ['done-parent'] },
]
const completed = collectCompletedSessions({
  list: completedList,
  workspaces: completedWorkspaces,
  statuses: completedStatuses,
  archivedIds: ['done-arch'],
})
// 只留真正的完成未读；按 updatedAt 倒序
assert.deepEqual(completed.map((row) => row.id), ['done-new', 'done-old'])
assert.equal(completed[0].completed, true)
assert.equal(completed[0].running, false)
assert.equal(completed[0].workspaceTitle, 'Alpha')

const completedLive = collectLiveSessions({
  list: completedList,
  workspaces: completedWorkspaces,
  statuses: completedStatuses,
  archivedIds: ['done-arch'],
})
// 有待处理 / 正在跑 / 带运行中子代理的仍归「进行中」
assert.deepEqual(completedLive.map((row) => row.id), ['done-pending', 'done-running', 'done-parent'])
const overlap = completedLive.filter((row) => completed.some((done) => done.id === row.id))
assert.deepEqual(overlap, [])
// 归档 / 子代理 / 空白会话两边都不出现
for (const id of ['done-arch', 'done-child', 'done-blank']) {
  assert.equal(completed.some((row) => row.id === id), false, `${id} 不该进待查看`)
  assert.equal(completedLive.some((row) => row.id === id), false, `${id} 不该进进行中`)
}

console.log('ok')
