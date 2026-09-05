import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IMAGE_TYPES,
  addTask,
  createDefaultTasks,
  getTotalImageCount,
  normalizeStoredTasks,
  patchTask,
  duplicateTask,
  removeTask,
} from '../task-model.js'

test('defines a semantic color for every image type', () => {
  assert.equal(IMAGE_TYPES.every((type) => /^#[0-9a-f]{6}$/i.test(type.color)), true)
})

test('creates three independent default tasks', () => {
  const tasks = createDefaultTasks()
  assert.equal(tasks.length, 3)
  assert.equal(getTotalImageCount(tasks), 3)
  assert.deepEqual(tasks.map((task) => task.ratio), ['1:1', '3:4', '4:5'])
})

test('patches only the target task', () => {
  const tasks = createDefaultTasks()
  const updated = patchTask(tasks, tasks[1].id, {
    ratio: '9:16',
    width: 1080,
    height: 1920,
  })

  assert.equal(updated[0].ratio, '1:1')
  assert.equal(updated[1].ratio, '9:16')
  assert.equal(updated[1].width, 1080)
  assert.notEqual(updated, tasks)
})

test('clamps task quantity between one and four', () => {
  const tasks = createDefaultTasks()
  assert.equal(patchTask(tasks, tasks[0].id, { quantity: 8 })[0].quantity, 4)
  assert.equal(patchTask(tasks, tasks[0].id, { quantity: 0 })[0].quantity, 1)
})

test('adds tasks until the five task limit', () => {
  let tasks = createDefaultTasks()
  tasks = addTask(tasks)
  tasks = addTask(tasks)
  tasks = addTask(tasks)
  assert.equal(tasks.length, 5)
  assert.equal(new Set(tasks.map((task) => task.id)).size, 5)
})

test('recovers invalid stored task data', () => {
  assert.equal(normalizeStoredTasks('broken').length, 3)
  assert.equal(normalizeStoredTasks('[{"bad":true}]').length, 3)
})

test('duplicates the selected task with a new id and ready state', () => {
  const tasks = createDefaultTasks()
  const next = duplicateTask(tasks, tasks[0].id)
  assert.equal(next.length, 4)
  assert.notEqual(next.at(-1).id, tasks[0].id)
  assert.equal(next.at(-1).prompt, tasks[0].prompt)
  assert.equal(next.at(-1).status, 'ready')
})

test('removes a task but always keeps at least one task', () => {
  const tasks = createDefaultTasks()
  assert.equal(removeTask(tasks, tasks[1].id).length, 2)
  assert.equal(removeTask([tasks[0]], tasks[0].id).length, 1)
})
