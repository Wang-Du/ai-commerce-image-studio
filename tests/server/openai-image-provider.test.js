import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAIImageProvider } from '../../server/openai-image-provider.js'

test('sends a reference image and returns decoded image bytes', async () => {
  let captured
  let clientOptions
  const clientFactory = (options) => {
    clientOptions = options
    return ({
    images: {
      edit: async (request) => {
        captured = request
        return { data: [{ b64_json: Buffer.from('generated').toString('base64') }] }
      },
    },
    models: { retrieve: async () => ({ id: 'gpt-image-2' }) },
    })
  }
  const provider = createOpenAIImageProvider({
    apiKey: 'secret',
    baseUrl: 'https://relay.example/v1/',
    imageModel: 'gpt-image-2',
    clientFactory,
    toFileImpl: async (buffer, name, options) => ({ buffer, name, ...options }),
  })

  const result = await provider.edit({
    imageBuffer: Buffer.from('source'),
    mimeType: 'image/png',
    prompt: 'prompt',
    size: '1200x1200',
    quality: 'medium',
  })

  assert.equal(result.toString(), 'generated')
  assert.equal(captured.model, 'gpt-image-2')
  assert.equal(captured.size, '1200x1200')
  assert.equal(captured.quality, 'medium')
  assert.equal(captured.input_fidelity, undefined)
  assert.equal(captured.image.type, 'image/png')
  assert.deepEqual(clientOptions, { apiKey: 'secret', baseURL: 'https://relay.example/v1' })
})

test('maps provider authentication failures to a stable error code', async () => {
  const provider = createOpenAIImageProvider({
    apiKey: 'invalid',
    clientFactory: () => ({
      images: { edit: async () => { throw Object.assign(new Error('invalid key'), { status: 401 }) } },
      models: { retrieve: async () => ({}) },
    }),
    toFileImpl: async () => ({}),
  })

  await assert.rejects(provider.edit({
    imageBuffer: Buffer.from('source'), mimeType: 'image/png', prompt: 'prompt', size: '1024x1024', quality: 'low',
  }), (error) => error.code === 'AUTHENTICATION_FAILED' && /API Key/.test(error.message))
})

test('tests access to the configured image model', async () => {
  let retrieved
  const provider = createOpenAIImageProvider({
    apiKey: 'secret',
    imageModel: 'gpt-image-2',
    clientFactory: () => ({
      images: { edit: async () => ({ data: [] }) },
      models: { retrieve: async (model) => { retrieved = model; return { id: model } } },
    }),
  })
  assert.deepEqual(await provider.testConnection(), { ok: true, model: 'gpt-image-2' })
  assert.equal(retrieved, 'gpt-image-2')
})
