import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { createAssetStore } from '../../server/asset-store.js'
import { createHistoryRepository } from '../../server/history-repository.js'
import { createSettingsStore } from '../../server/settings-store.js'
import { createGenerationService } from '../../server/generation-service.js'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3rQAAAAASUVORK5CYII='

async function createFixture({
  mode = 'api',
  source = mode === 'demo' ? 'demo' : 'openai',
  apiKey = 'secret',
  baseUrl = 'https://relay.example/v1',
  providerEdit,
  codexGenerateBatch,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-generation-'))
  const assetStore = createAssetStore({ rootDir: path.join(root, 'assets') })
  const historyRepository = createHistoryRepository({ filePath: path.join(root, 'history.json') })
  const settingsStore = createSettingsStore({ filePath: path.join(root, 'settings.json') })
  await settingsStore.update({ mode, source, apiKey, baseUrl, imageModel: 'gpt-image-2', quality: 'low' })
  const asset = await assetStore.createFromDataUrl({ name: 'product.png', dataUrl: PNG_DATA_URL })
  const generatedBytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#e8f2ed' } }).png().toBuffer()
  let providerOptions
  const service = createGenerationService({
    assetStore,
    historyRepository,
    settingsStore,
    generatedDir: path.join(root, 'generated'),
    providerFactory: (options) => {
      providerOptions = options
      return { edit: providerEdit || (async () => generatedBytes) }
    },
    codexProviderFactory: () => ({
      generateBatch: codexGenerateBatch || (async ({ jobs }) => jobs.map(() => ({ ok: true, bytes: generatedBytes }))),
    }),
  })
  return { root, asset, historyRepository, service, getProviderOptions: () => providerOptions }
}

test('generates a Codex batch directly and preserves each requested output size', async () => {
  const fixture = await createFixture({ source: 'codex', apiKey: '' })
  try {
    const batch = await fixture.service.generateBatch({
      assetId: fixture.asset.id,
      tasks: [
        { id: 'task-1', type: 'compare', width: 1200, height: 1200, quantity: 1, prompt: '前后对比' },
        { id: 'task-2', type: 'feature', width: 900, height: 1200, quantity: 1, prompt: '卖点' },
        { id: 'task-3', type: 'review', width: 1200, height: 1500, quantity: 1, prompt: '评价' },
      ],
    })

    assert.equal(batch.status, 'done')
    assert.equal(batch.results.length, 3)
    assert.equal(batch.source, 'codex')
    assert.equal(batch.results.every((result) => result.source === 'codex'), true)
    const metadata = await Promise.all(batch.results.map((result) =>
      sharp(path.join(fixture.root, 'generated', result.filename)).metadata(),
    ))
    assert.deepEqual(metadata.map((item) => [item.width, item.height]), [
      [1200, 1200],
      [900, 1200],
      [1200, 1500],
    ])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('writes exact-size results and a persistent batch record', async () => {
  const fixture = await createFixture()
  try {
    const batch = await fixture.service.generateBatch({
      assetId: fixture.asset.id,
      tasks: [{ id: 'task-1', type: 'feature', width: 900, height: 1200, quantity: 1, prompt: '清爽' }],
    })
    const resultPath = path.join(fixture.root, 'generated', batch.results[0].filename)
    const metadata = await sharp(resultPath).metadata()

    assert.deepEqual([metadata.width, metadata.height], [900, 1200])
    assert.equal(batch.results[0].imageUrl, `/generated/${batch.results[0].filename}`)
    assert.equal((await fixture.historyRepository.list())[0].id, batch.id)
    assert.deepEqual(fixture.getProviderOptions(), {
      apiKey: 'secret',
      baseUrl: 'https://relay.example/v1',
      imageModel: 'gpt-image-2',
    })
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('records successful outputs when another output fails', async () => {
  let calls = 0
  const fixture = await createFixture({
    providerEdit: async () => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('请求过快'), { code: 'RATE_LIMITED' })
      return sharp({ create: { width: 32, height: 32, channels: 4, background: '#ffffff' } }).png().toBuffer()
    },
  })
  try {
    const batch = await fixture.service.generateBatch({
      assetId: fixture.asset.id,
      tasks: [{ id: 'task-1', type: 'feature', width: 1200, height: 1200, quantity: 2, prompt: '清爽' }],
    })
    assert.equal(batch.results.length, 1)
    assert.equal(batch.failures.length, 1)
    assert.equal(batch.failures[0].code, 'RATE_LIMITED')
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects real generation when the API key is missing', async () => {
  const fixture = await createFixture({ apiKey: '' })
  try {
    await assert.rejects(
      fixture.service.generateBatch({
        assetId: fixture.asset.id,
        tasks: [{ id: 'task-1', type: 'feature', width: 1200, height: 1200, quantity: 1, prompt: '清爽' }],
      }),
      (error) => error.code === 'MODEL_NOT_CONFIGURED',
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('builds a task-aligned handoff package for a desktop Agent', async () => {
  const fixture = await createFixture({ source: 'codex', apiKey: '' })
  try {
    const handoff = await fixture.service.createHandoff({
      source: 'codex',
      assetId: fixture.asset.id,
      tasks: [{ id: 'task-1', type: 'feature', width: 900, height: 1200, quantity: 2, prompt: '突出清爽质感' }],
    })
    assert.equal(handoff.source, 'codex')
    assert.equal(handoff.imageCount, 2)
    assert.equal(handoff.entries[1].index, 1)
    assert.deepEqual([handoff.entries[0].width, handoff.entries[0].height], [900, 1200])
    assert.match(handoff.promptText, /突出清爽质感/)
    assert.match(handoff.promptText, /900 × 1200/)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('imports assisted results at exact task dimensions and records their source', async () => {
  const fixture = await createFixture({ source: 'codex', apiKey: '' })
  try {
    const imported = await sharp({ create: { width: 48, height: 32, channels: 4, background: '#d7ebe2' } }).png().toBuffer()
    const batch = await fixture.service.importBatch({
      source: 'codex',
      assetId: fixture.asset.id,
      tasks: [{ id: 'task-1', type: 'feature', width: 900, height: 1200, quantity: 1, prompt: '清爽' }],
      files: [{ name: 'agent-result.png', dataUrl: `data:image/png;base64,${imported.toString('base64')}` }],
    })
    const metadata = await sharp(path.join(fixture.root, 'generated', batch.results[0].filename)).metadata()
    assert.deepEqual([metadata.width, metadata.height], [900, 1200])
    assert.equal(batch.source, 'codex')
    assert.equal(batch.results[0].mode, 'codex')
    assert.equal((await fixture.historyRepository.list())[0].id, batch.id)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects an assisted import when the file count does not match the task plan', async () => {
  const fixture = await createFixture({ source: 'codex', apiKey: '' })
  try {
    await assert.rejects(
      fixture.service.importBatch({
        source: 'codex',
        assetId: fixture.asset.id,
        tasks: [{ id: 'task-1', type: 'feature', width: 1200, height: 1200, quantity: 2, prompt: '清爽' }],
        files: [{ name: 'one.png', dataUrl: PNG_DATA_URL }],
      }),
      (error) => error.code === 'IMPORT_COUNT_MISMATCH',
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
