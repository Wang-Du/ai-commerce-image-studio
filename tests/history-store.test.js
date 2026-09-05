import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultTasks, patchTask } from '../task-model.js'
import {
  appendHistoryRecord,
  createHistoryRecord,
  normalizeHistory,
} from '../history-store.js'

test('creates a generation record from the current task snapshot', () => {
  const tasks = patchTask(createDefaultTasks(), 'task-2', { quantity: 2 })
  const record = createHistoryRecord(tasks, {
    id: 'batch-1',
    createdAt: '2026-09-04T12:00:00.000Z',
  })

  assert.equal(record.id, 'batch-1')
  assert.equal(record.taskCount, 3)
  assert.equal(record.imageCount, 4)
  assert.deepEqual(record.tasks.map((task) => task.ratio), ['1:1', '3:4', '4:5'])
})

test('stores newest records first and limits history to thirty items', () => {
  const records = Array.from({ length: 30 }, (_, index) => ({ id: `old-${index}` }))
  const updated = appendHistoryRecord(records, { id: 'new' })

  assert.equal(updated.length, 30)
  assert.equal(updated[0].id, 'new')
  assert.equal(updated.at(-1).id, 'old-28')
})

test('recovers invalid stored history as an empty list', () => {
  assert.deepEqual(normalizeHistory('broken'), [])
  assert.deepEqual(normalizeHistory('{"bad":true}'), [])
})
