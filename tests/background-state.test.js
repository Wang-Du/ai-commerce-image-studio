import test from 'node:test'
import assert from 'node:assert/strict'
import * as state from '../frontend-state.js'

const task = { id: 'task-1', type: 'feature', ratio: '1:1', width: 1200, height: 1200, quantity: 1, prompt: '保温杯', status: 'ready' }
const result = { taskId: 'task-1', index: 0, imageUrl: '/generated/one.png' }
const job = { id: 'old', assetId: 'asset-1', status: 'done', tasks: [task], results: [result], failures: [] }
function reconcile(input) {
  assert.equal(typeof state.reconcileBackgroundJobs, 'function', 'background results must be matched to the submitted draft')
  return state.reconcileBackgroundJobs({ tasks: [task], assetId: 'asset-1', jobs: [job], results: [], failures: [], ...input })
}
test('does not apply a finished job to a different product or edited task', () => {
  assert.equal(reconcile({ assetId: 'asset-2' }).results.length, 0)
  assert.equal(reconcile({ tasks: [{ ...task, prompt: '已经换了提示词' }] }).results.length, 0)
  assert.equal(reconcile({ tasks: [{ ...task, width: 900 }] }).results.length, 0)
})
test('newest attempt wins and queues are not falsely shown as completed', () => {
  const next = reconcile({ jobs: [{ ...job, id: 'new', status: 'queued', results: [] }, job], results: [result] })
  assert.equal(next.tasks[0].status, 'queued')
  assert.equal(next.results.length, 0)
  assert.equal(next.tasks[0].progress, 0)
})
test('partial live progress uses real output counts and preserves unrelated task results', () => {
  const other = { ...task, id: 'task-2', status: 'done' }
  const otherResult = { ...result, taskId: 'task-2' }
  const next = reconcile({ tasks: [{ ...task, quantity: 2 }, other], results: [otherResult], jobs: [{ ...job, status: 'running', tasks: [{ ...task, quantity: 2 }] }] })
  assert.equal(next.tasks[0].status, 'generating')
  assert.equal(next.tasks[0].progress, 50)
  assert.equal(next.tasks[1].status, 'done')
  assert.equal(next.results.length, 2)
})
