import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { createAssetStore } from '../../server/asset-store.js'
import { createSettingsStore } from '../../server/settings-store.js'
import { createHistoryRepository } from '../../server/history-repository.js'
import { createGenerationService } from '../../server/generation-service.js'

const task = { id: 'task-1', type: 'feature', ratio: '1:1', width: 1200, height: 1200, quantity: 1, prompt: '原始商品' }
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
async function waitFor(read, predicate) {
  for (let i = 0; i < 200; i++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('background job did not reach expected state')
}

async function fixture(t, edit, { source = 'openai', codexGenerate } = {}) {
  const module = await import('../../server/generation-queue.js').catch(() => ({}))
  assert.equal(typeof module.createGenerationQueue, 'function', 'background queue must accept a job before generation finishes')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-queue-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const assetStore = createAssetStore({ rootDir: path.join(root, 'assets') })
  const settingsStore = createSettingsStore({ filePath: path.join(root, 'settings.json') })
  const historyRepository = createHistoryRepository({ filePath: path.join(root, 'history.json') })
  await settingsStore.update({ source, apiKey: 'test-private-key', imageModel: 'original-model', baseUrl: 'https://relay.example/v1' })
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer()
  const asset = await assetStore.createFromDataUrl({ name: '商品.png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` })
  const generationService = createGenerationService({ assetStore, settingsStore, historyRepository, generatedDir: path.join(root, 'generated'), providerFactory: (settings) => ({ edit: (input) => edit ? edit(input, settings, bytes) : bytes }), codexProviderFactory: () => ({ generateBatch: (input) => codexGenerate(input, bytes) }) })
  const options = { filePath: path.join(root, 'jobs.json'), generationService, historyRepository }
  const queue = await module.createGenerationQueue(options)
  return { root, queue, options, asset, assetStore, settingsStore, historyRepository, createQueue: module.createGenerationQueue }
}

test('accepts another batch while generating, freezes source/settings/tasks, and persists both results', async (t) => {
  const gate = deferred()
  let calls = 0
  const f = await fixture(t, async ({ imageBuffer, prompt }, settings, bytes) => {
    calls++
    if (calls === 1) await gate.promise
    assert.equal(settings.imageModel, 'original-model')
    assert.equal(settings.apiKey, 'test-private-key')
    assert.match(prompt, /原始商品/)
    assert.deepEqual(imageBuffer, bytes)
    return bytes
  })
  const payload = { assetId: f.asset.id, tasks: [{ ...task }] }
  const first = await f.queue.submit(payload)
  await waitFor(() => f.queue.list(), (jobs) => jobs.find((j) => j.id === first.id)?.status === 'running')
  const second = await f.queue.submit(payload)
  payload.tasks[0].prompt = '不能改变已提交任务'
  await f.settingsStore.update({ imageModel: 'changed-model', apiKey: 'changed-key' })
  await f.assetStore.remove(f.asset.id)
  assert.equal(f.queue.list().find((j) => j.id === second.id).status, 'queued')
  const disk = await fs.readFile(f.options.filePath, 'utf8')
  assert.equal(disk.includes('test-private-key'), false)
  assert.equal(disk.includes('sourceBuffer'), false)
  gate.resolve()
  const finished = await waitFor(() => f.queue.list(), (jobs) => jobs.every((j) => j.status === 'done'))
  assert.equal(finished.length, 2)
  assert.equal(calls, 2)
  assert.equal((await f.historyRepository.list()).length, 2)
  const meta = await sharp(path.join(f.root, 'generated', finished[0].results[0].filename)).metadata()
  assert.deepEqual([meta.width, meta.height], [1200, 1200])
  const reloaded = await f.createQueue(f.options)
  assert.equal(reloaded.list().length, 2)
  assert.equal(reloaded.list().every((j) => j.status === 'done'), true)
})

test('reports only actual output progress and continues queued jobs after failure', async (t) => {
  const gate = deferred()
  let calls = 0
  const f = await fixture(t, async (_input, _settings, bytes) => {
    calls++
    if (calls === 2) { await gate.promise; throw Object.assign(new Error('限流'), { code: 'RATE_LIMITED' }) }
    return bytes
  })
  const first = await f.queue.submit({ assetId: f.asset.id, tasks: [{ ...task, quantity: 2 }] })
  const second = await f.queue.submit({ assetId: f.asset.id, tasks: [task] })
  const progress = await waitFor(() => f.queue.list().find((j) => j.id === first.id), (j) => j.results.length === 1)
  assert.equal(progress.status, 'running')
  assert.equal(progress.failures.length, 0)
  assert.equal(f.queue.list().find((j) => j.id === second.id).status, 'queued')
  gate.resolve()
  const finished = await waitFor(() => f.queue.list(), (jobs) => jobs.every((j) => !['queued', 'running'].includes(j.status)))
  assert.equal(finished.find((j) => j.id === first.id).status, 'partial')
  assert.equal(finished.find((j) => j.id === second.id).status, 'done')
  assert.equal(finished.find((j) => j.id === first.id).failures[0].code, 'RATE_LIMITED')
})

test('rejects invalid submissions and missing configuration without queuing work', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.queue.submit({ assetId: f.asset.id, tasks: [] }), { code: 'INVALID_TASKS' })
  await assert.rejects(f.queue.submit({ assetId: 'missing', tasks: [task] }), { code: 'ASSET_NOT_FOUND' })
  await fs.writeFile(path.join(f.root, 'settings.json'), JSON.stringify({ source: 'openai', apiKey: '' }))
  await assert.rejects(f.queue.submit({ assetId: f.asset.id, tasks: [task] }), { code: 'MODEL_NOT_CONFIGURED' })
  assert.equal(f.queue.list().length, 0)
})

test('an Agent batch exception is recorded and does not block the next batch', async (t) => {
  let attempts = 0
  const f = await fixture(t, null, { source: 'codex', codexGenerate: async ({ jobs }, bytes) => {
    if (++attempts === 1) throw Object.assign(new Error('Agent 网络中断'), { code: 'AGENT_UNAVAILABLE' })
    return jobs.map(() => ({ ok: true, bytes }))
  } })
  const first = await f.queue.submit({ assetId: f.asset.id, tasks: [task] })
  const second = await f.queue.submit({ assetId: f.asset.id, tasks: [task] })
  const jobs = await waitFor(() => f.queue.list(), (items) => items.length === 2 && items.every((j) => !['queued', 'running'].includes(j.status)))
  assert.equal(jobs.find((j) => j.id === first.id).failures[0].code, 'AGENT_UNAVAILABLE')
  assert.equal(jobs.find((j) => j.id === second.id).status, 'done')
  assert.equal((await f.historyRepository.list()).length, 2)
})

test('marks jobs interrupted after a server restart instead of silently repeating paid requests', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.options.filePath, JSON.stringify([{ id: 'interrupted', assetId: f.asset.id, assetName: '商品.png', source: 'openai', status: 'running', tasks: [task], imageCount: 1, results: [], failures: [] }]))
  const restored = await f.createQueue(f.options)
  assert.equal(restored.list()[0].status, 'error')
  assert.equal(restored.list()[0].failures[0].code, 'SERVER_RESTARTED')
  assert.equal((await f.historyRepository.list())[0].id, 'interrupted')
})

test('forgetting completed history survives reload without discarding active batches', async (t) => {
  const gate = deferred()
  let calls = 0
  const f = await fixture(t, async (_input, _settings, bytes) => { if (++calls > 1) await gate.promise; return bytes })
  const first = await f.queue.submit({ assetId: f.asset.id, tasks: [task] })
  await waitFor(() => f.queue.list(), (jobs) => jobs[0].status === 'done')
  await f.queue.submit({ assetId: f.asset.id, tasks: [task] })
  await f.queue.submit({ assetId: f.asset.id, tasks: [task] })
  await f.historyRepository.remove(first.id)
  await f.queue.forgetHistory([first.id])
  assert.equal(f.queue.list().length, 2)
  assert.equal(f.queue.list().every((job) => ['queued', 'running'].includes(job.status)), true)
  gate.resolve()
  await waitFor(() => f.queue.list(), (jobs) => jobs.every((job) => job.status === 'done'))
  const reloaded = await f.createQueue(f.options)
  assert.equal(reloaded.list().some((job) => job.id === first.id), false)
  assert.equal(reloaded.list().length, 2)
})
