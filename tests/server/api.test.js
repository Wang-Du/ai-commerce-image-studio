import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { createAssetStore } from '../../server/asset-store.js'
import { createHistoryRepository } from '../../server/history-repository.js'
import { createSettingsStore } from '../../server/settings-store.js'
import { createGenerationService } from '../../server/generation-service.js'
import { createApp } from '../../server/create-app.js'
import { createGenerationQueue } from '../../server/generation-queue.js'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3rQAAAAASUVORK5CYII='
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function withServer(run, { agentConnected = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-api-'))
  const settingsStore = createSettingsStore({ filePath: path.join(root, 'settings.json') })
  const assetStore = createAssetStore({ rootDir: path.join(root, 'assets') })
  const historyRepository = createHistoryRepository({ filePath: path.join(root, 'history.json') })
  const providerFactory = () => ({
    testConnection: async () => ({ ok: true, model: 'gpt-image-2' }),
    edit: async () => Buffer.from(''),
  })
  const generatedBytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#e8f2ed' } }).png().toBuffer()
  const codexProviderFactory = () => ({
    generateBatch: async ({ jobs }) => jobs.map(() => ({ ok: true, bytes: generatedBytes })),
  })
  const generationService = createGenerationService({
    assetStore,
    historyRepository,
    settingsStore,
    providerFactory,
    codexProviderFactory,
    generatedDir: path.join(root, 'generated'),
  })
  const agentStatus = {
    installed: true,
    authenticated: true,
    reachable: agentConnected,
    imageGeneration: true,
    connected: agentConnected,
    tested: true,
    version: '0.153.0',
    workflow: 'direct',
    message: agentConnected ? 'Codex 桌面 Agent 已连接，可直接生成图片' : '网络未连接',
  }
  const desktopAgentService = {
    getStatus: async () => ({ ...agentStatus, tested: false, connected: false }),
    testConnection: async () => agentStatus,
    canSelect: () => agentConnected,
  }
  const app = createApp({
    settingsStore,
    assetStore,
    historyRepository,
    generationService,
    generationQueue: await createGenerationQueue({ filePath: path.join(root, 'jobs.json'), generationService, historyRepository }),
    desktopAgentService,
    providerFactory,
    publicDir: projectDir,
    assetFilesDir: path.join(root, 'assets', 'files'),
    generatedDir: path.join(root, 'generated'),
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    await run({ baseUrl, settingsStore, assetStore, historyRepository })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('submits a persistent background job and reads its results from a fresh request', async () => {
  await withServer(async ({ baseUrl, settingsStore, assetStore }) => {
    await settingsStore.update({ source: 'demo' })
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer()
    const asset = await assetStore.createFromDataUrl({ name: '后台测试.png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` })
    const response = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: asset.id, tasks: [{ id: 't', type: 'feature', ratio: '1:1', width: 1200, height: 1200, quantity: 1 }] }),
    })
    assert.equal(response.status, 202)
    const accepted = await response.json()
    assert.equal(accepted.status, 'queued')
    let job
    for (let i = 0; i < 100; i++) {
      const jobs = await (await fetch(`${baseUrl}/api/jobs`)).json()
      job = jobs.find((item) => item.id === accepted.id)
      if (job.status === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(job.status, 'done')
    const image = await fetch(`${baseUrl}${job.results[0].imageUrl}`)
    assert.equal(image.status, 200)
    const meta = await sharp(Buffer.from(await image.arrayBuffer())).metadata()
    assert.deepEqual([meta.width, meta.height], [1200, 1200])
    const deleted = await fetch(`${baseUrl}/api/history/${accepted.id}`, { method: 'DELETE' })
    assert.equal(deleted.status, 204)
    assert.deepEqual(await (await fetch(`${baseUrl}/api/jobs`)).json(), [])
    assert.deepEqual(await (await fetch(`${baseUrl}/api/history`)).json(), [])
  })
})

test('clearing history also removes completed background jobs from subsequent reads', async () => {
  await withServer(async ({ baseUrl, settingsStore, assetStore }) => {
    await settingsStore.update({ source: 'codex' })
    const asset = await assetStore.createFromDataUrl({ name: '商品.png', dataUrl: PNG_DATA_URL })
    await fetch(`${baseUrl}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id, tasks: [{ id: 't', type: 'feature', ratio: '1:1', width: 1200, height: 1200, quantity: 1 }] }) })
    for (let i = 0; i < 100; i++) {
      const jobs = await (await fetch(`${baseUrl}/api/jobs`)).json()
      if (jobs[0].status === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await (await fetch(`${baseUrl}/api/history`)).json()).length, 1)
    assert.equal((await fetch(`${baseUrl}/api/history`, { method: 'DELETE' })).status, 204)
    assert.deepEqual(await (await fetch(`${baseUrl}/api/jobs`)).json(), [])
  })
})

test('serves the application and health information from one origin', async () => {
  await withServer(async ({ baseUrl }) => {
    const health = await fetch(`${baseUrl}/api/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), {
      ok: true,
      service: 'ai-commerce-image-studio',
      configured: false,
      mode: 'api',
      source: 'openai',
    })

    const page = await fetch(baseUrl)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /AI 商品图生成器/)
  })
})

test('tests the desktop Agent connection and returns only public capability fields', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/agent/test`, { method: 'POST' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.connected, true)
    assert.equal(body.imageGeneration, true)
    assert.equal(body.workflow, 'direct')
    assert.doesNotMatch(JSON.stringify(body), /auth\.json|backend-api|token/i)
  })
})

test('generates three configured tasks directly through a connected Codex Agent', async () => {
  await withServer(async ({ baseUrl, assetStore }) => {
    const asset = await assetStore.createFromDataUrl({ name: 'product.png', dataUrl: PNG_DATA_URL })
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'codex' }),
    })
    assert.equal(settingsResponse.status, 200)

    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: asset.id,
        tasks: [
          { id: 'task-1', type: 'compare', ratio: '1:1', width: 1200, height: 1200, quantity: 1, prompt: '前后对比' },
          { id: 'task-2', type: 'feature', ratio: '3:4', width: 900, height: 1200, quantity: 1, prompt: '卖点' },
          { id: 'task-3', type: 'review', ratio: '4:5', width: 1200, height: 1500, quantity: 1, prompt: '评价' },
        ],
      }),
    })
    const batch = await response.json()
    assert.equal(response.status, 200, JSON.stringify(batch))
    assert.equal(batch.results.length, 3)
    assert.equal(batch.source, 'codex')
  })
})

test('requires a successful Agent connection test before selecting Codex', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'codex' }),
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'AGENT_TEST_REQUIRED')
  }, { agentConnected: false })
})

test('creates a handoff package and imports its result through the web API', async () => {
  await withServer(async ({ baseUrl, assetStore }) => {
    const asset = await assetStore.createFromDataUrl({ name: 'product.png', dataUrl: PNG_DATA_URL })
    const payload = {
      source: 'codex',
      assetId: asset.id,
      tasks: [{ id: 'task-1', type: 'feature', ratio: '1:1', width: 1200, height: 1200, quantity: 1, prompt: '清爽' }],
    }
    const handoffResponse = await fetch(`${baseUrl}/api/handoffs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert.equal(handoffResponse.status, 201)
    assert.match((await handoffResponse.json()).promptText, /1200 × 1200/)

    const resultBytes = await sharp({ create: { width: 24, height: 24, channels: 4, background: '#dceee6' } }).png().toBuffer()
    const importResponse = await fetch(`${baseUrl}/api/import-results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, files: [{ name: 'result.png', dataUrl: `data:image/png;base64,${resultBytes.toString('base64')}` }] }),
    })
    const batch = await importResponse.json()
    assert.equal(importResponse.status, 201, JSON.stringify(batch))
    assert.equal(batch.results[0].mode, 'codex')
  })
})

test('saves settings without echoing the API key', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'secret-value', mode: 'api', imageModel: 'gpt-image-2', quality: 'low' }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.configured, true)
    assert.equal('apiKey' in body, false)
    assert.doesNotMatch(JSON.stringify(body), /secret-value/)
  })
})

test('persists an uploaded asset and lists it', async () => {
  await withServer(async ({ baseUrl }) => {
    const upload = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'product.png', dataUrl: PNG_DATA_URL }),
    })
    assert.equal(upload.status, 201)
    const asset = await upload.json()
    const listing = await fetch(`${baseUrl}/api/assets`).then((response) => response.json())
    assert.equal(listing[0].id, asset.id)
  })
})

test('rejects real generation when the key is not configured', async () => {
  await withServer(async ({ baseUrl, assetStore }) => {
    const asset = await assetStore.createFromDataUrl({ name: 'product.png', dataUrl: PNG_DATA_URL })
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: asset.id,
        tasks: [{ id: 'task-1', type: 'feature', ratio: '1:1', width: 1200, height: 1200, quantity: 1, prompt: '清爽' }],
      }),
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      code: 'MODEL_NOT_CONFIGURED',
      message: '请先在模型设置中填写并保存 API Key',
    })
  })
})

test('rejects cross-origin writes', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'https://malicious.example' },
      body: JSON.stringify({ mode: 'demo' }),
    })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'CROSS_ORIGIN_WRITE_BLOCKED')
  })
})
