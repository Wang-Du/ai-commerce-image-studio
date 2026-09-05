import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultTasks, patchTask } from '../task-model.js'
import { MockImageGenerator } from '../mock-generator.js'

test('reports progress and returns one result per requested image', async () => {
  const generator = new MockImageGenerator({ delay: () => Promise.resolve() })
  const sourceTask = patchTask(createDefaultTasks(), 'task-1', { quantity: 3 })[0]
  const progress = []

  const results = await generator.generate(sourceTask, (value) => progress.push(value))

  assert.equal(progress.at(-1), 100)
  assert.deepEqual(progress, [12, 38, 67, 88, 100])
  assert.equal(results.length, 3)
  assert.equal(results[0].taskId, 'task-1')
  assert.equal(results[2].index, 2)
})

test('surfaces a generation failure for retry handling', async () => {
  const generator = new MockImageGenerator({
    delay: () => Promise.resolve(),
    shouldFail: () => true,
  })

  await assert.rejects(
    generator.generate(createDefaultTasks()[0], () => {}),
    /演示生成失败/,
  )
})
