import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeTaskGenerationState } from '../frontend-state.js'

test('restores done, partial, error and ready task states from persisted results', () => {
  const tasks = [
    { id: 'done', quantity: 1, status: 'ready' },
    { id: 'partial', quantity: 2, status: 'ready' },
    { id: 'error', quantity: 1, status: 'ready' },
    { id: 'ready', quantity: 1, status: 'ready' },
  ]
  const results = [
    { taskId: 'done', index: 0 },
    { taskId: 'partial', index: 0 },
  ]
  const failures = [
    { taskId: 'partial', index: 1 },
    { taskId: 'error', index: 0 },
  ]

  assert.deepEqual(
    mergeTaskGenerationState(tasks, results, failures).map((task) => task.status),
    ['done', 'partial', 'error', 'ready'],
  )
})

test('starts a retry by clearing only the requested tasks previous outputs', async () => {
  const module = await import('../frontend-state.js')
  assert.equal(typeof module.beginTaskGeneration, 'function')
  const state = module.beginTaskGeneration({
    tasks: [
      { id: 'retry', status: 'done', progress: 100 },
      { id: 'keep', status: 'done', progress: 100 },
    ],
    results: [{ taskId: 'retry' }, { taskId: 'keep' }],
    failures: [{ taskId: 'retry' }, { taskId: 'keep' }],
    taskIds: ['retry'],
  })

  assert.deepEqual(state.tasks.map((task) => [task.id, task.status]), [['retry', 'generating'], ['keep', 'done']])
  assert.deepEqual(state.results.map((result) => result.taskId), ['keep'])
  assert.deepEqual(state.failures.map((failure) => failure.taskId), ['keep'])
})
