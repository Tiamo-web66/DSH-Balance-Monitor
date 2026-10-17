import assert from 'node:assert/strict'
import {
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

console.log('ok')
