import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHistoryRepository } from '../../server/history-repository.js'

async function withRepository(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-history-'))
  const filePath = path.join(root, 'history.json')
  try {
    return await run(createHistoryRepository({ filePath }), filePath)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('keeps newest generation batches first across repository instances', async () => {
  await withRepository(async (repository, filePath) => {
    await repository.append({ id: 'one', createdAt: '2026-09-04T10:00:00.000Z', results: [] })
    await repository.append({ id: 'two', createdAt: '2026-09-04T11:00:00.000Z', results: [] })

    const reopened = createHistoryRepository({ filePath })
    assert.deepEqual((await reopened.list()).map((item) => item.id), ['two', 'one'])
  })
})

test('removes one history batch without affecting the others', async () => {
  await withRepository(async (repository) => {
    await repository.append({ id: 'one', createdAt: '2026-09-04T10:00:00.000Z', results: [] })
    await repository.append({ id: 'two', createdAt: '2026-09-04T11:00:00.000Z', results: [] })
    assert.equal(await repository.remove('two'), true)
    assert.deepEqual((await repository.list()).map((item) => item.id), ['one'])
  })
})

test('clears all persisted history', async () => {
  await withRepository(async (repository) => {
    await repository.append({ id: 'one', createdAt: '2026-09-04T10:00:00.000Z', results: [] })
    await repository.clear()
    assert.deepEqual(await repository.list(), [])
  })
})
