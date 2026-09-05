import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiGatewayClient, normalizeApiSettings } from '../api-client.js'
import { createDefaultTasks } from '../task-model.js'

const jsonResponse = (value) => ({ ok: true, json: async () => value })

test('normalizes API settings without accepting a browser API key', () => {
  const settings = normalizeApiSettings(JSON.stringify({
    mode: 'api',
    baseUrl: 'https://gateway.example.com/',
    textModel: 'text-model',
    imageModel: 'image-model',
    apiKey: 'must-not-be-kept',
  }))

  assert.equal(settings.baseUrl, 'https://gateway.example.com')
  assert.equal(settings.textModel, 'text-model')
  assert.equal(settings.imageModel, 'image-model')
  assert.equal('apiKey' in settings, false)
})

test('checks the gateway health endpoint', async () => {
  const calls = []
  const client = new ApiGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async (...args) => {
      calls.push(args)
      return { ok: true, json: async () => ({ ok: true }) }
    },
  })

  const result = await client.health()
  assert.equal(calls[0][0], 'https://gateway.example.com/api/health')
  assert.equal(result.ok, true)
})

test('binds the browser fetch implementation to the global context', async () => {
  const originalFetch = globalThis.fetch
  let receiver
  globalThis.fetch = function () {
    receiver = this
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
  }

  try {
    const client = new ApiGatewayClient({ baseUrl: 'https://gateway.example.com' })
    await client.health()
    assert.equal(receiver, globalThis)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('posts generation parameters and reports completion progress', async () => {
  const calls = []
  const progress = []
  const client = new ApiGatewayClient({
    baseUrl: 'https://gateway.example.com',
    textModel: 'text-model',
    imageModel: 'image-model',
    fetchImpl: async (...args) => {
      calls.push(args)
      return { ok: true, json: async () => ({ results: [{ imageUrl: 'https://img.example.com/1.png' }] }) }
    },
  })

  const task = createDefaultTasks()[0]
  const results = await client.generate(task, (value) => progress.push(value))
  const body = JSON.parse(calls[0][1].body)

  assert.equal(calls[0][0], 'https://gateway.example.com/api/generate')
  assert.equal(body.task.id, task.id)
  assert.equal(body.textModel, 'text-model')
  assert.equal(body.imageModel, 'image-model')
  assert.equal(progress.at(-1), 100)
  assert.equal(results[0].imageUrl, 'https://img.example.com/1.png')
})

test('surfaces a readable gateway error', async () => {
  const client = new ApiGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ message: '模型暂时不可用' }) }),
  })

  await assert.rejects(client.health(), /模型暂时不可用/)
})

test('sends a real generation batch using an asset id and tasks', async () => {
  const calls = []
  const client = new ApiGatewayClient({
    baseUrl: '',
    fetchImpl: async (...args) => {
      calls.push(args)
      return { ok: true, json: async () => ({ id: 'batch-1', results: [], failures: [] }) }
    },
  })
  const payload = { assetId: 'asset-1', tasks: [{ id: 'task-1' }] }

  const batch = await client.generateBatch(payload)
  assert.equal(calls[0][0], '/api/generate')
  assert.equal(calls[0][1].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0][1].body), payload)
  assert.equal(batch.id, 'batch-1')
})

test('saves model settings without adding a browser API key header', async () => {
  const calls = []
  const client = new ApiGatewayClient({
    baseUrl: '',
    fetchImpl: async (...args) => {
      calls.push(args)
      return { ok: true, json: async () => ({ configured: true, mode: 'api', imageModel: 'gpt-image-2', quality: 'low' }) }
    },
  })
  await client.saveSettings({ apiKey: 'secret', mode: 'api', imageModel: 'gpt-image-2', quality: 'low' })

  assert.equal(calls[0][0], '/api/settings')
  assert.equal(calls[0][1].method, 'PUT')
  assert.equal('Authorization' in calls[0][1].headers, false)
})

test('uploads and lists persistent assets through the local server', async () => {
  const calls = []
  const client = new ApiGatewayClient({
    baseUrl: '',
    fetchImpl: async (...args) => {
      calls.push(args)
      return { ok: true, json: async () => [] }
    },
  })
  await client.uploadAsset({ name: 'product.png', dataUrl: 'data:image/png;base64,AA==' })
  await client.listAssets()

  assert.deepEqual(calls.map((call) => [call[0], call[1]?.method || 'GET']), [
    ['/api/assets', 'POST'],
    ['/api/assets', 'GET'],
  ])
})

test('tests the desktop Agent and creates an assisted handoff', async () => {
  const calls = []
  const client = new ApiGatewayClient({
    baseUrl: '',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options })
      return jsonResponse(url.includes('/agent/test') ? { connected: true } : { id: 'handoff-1' })
    },
  })
  assert.equal((await client.testDesktopAgent()).connected, true)
  await client.createHandoff({ source: 'codex', assetId: 'asset-1', tasks: [] })
  assert.equal(calls[0].url, '/api/agent/test')
  assert.equal(calls[1].url, '/api/handoffs')
  assert.equal(calls[1].options.method, 'POST')
})

test('imports desktop AI results through the local server', async () => {
  const calls = []
  const client = new ApiGatewayClient({
    baseUrl: '',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options })
      return jsonResponse({ id: 'batch-1', results: [] })
    },
  })
  await client.importResults({ source: 'desktop', assetId: 'asset-1', tasks: [], files: [] })
  assert.equal(calls[0].url, '/api/import-results')
  assert.equal(calls[0].options.method, 'POST')
})
