import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSettingsStore } from '../../server/settings-store.js'

async function withTempStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-settings-'))
  try {
    return await run(createSettingsStore({ filePath: path.join(root, 'settings.json') }), root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('stores the API key without exposing it through public settings', async () => {
  await withTempStore(async (store, root) => {
    await store.update({
      apiKey: 'secret-value',
      mode: 'api',
      baseUrl: 'https://relay.example/v1/',
      imageModel: 'gpt-image-2',
      quality: 'medium',
    })

    assert.deepEqual(await store.getPublic(), {
      mode: 'api',
      source: 'openai',
      baseUrl: 'https://relay.example/v1',
      imageModel: 'gpt-image-2',
      quality: 'medium',
      configured: true,
    })
    assert.equal((await fs.stat(path.join(root, 'settings.json'))).mode & 0o777, 0o600)
  })
})

test('preserves an existing key when a later settings update omits it', async () => {
  await withTempStore(async (store) => {
    await store.update({ apiKey: 'secret-value', mode: 'api', quality: 'low' })
    await store.update({ mode: 'demo', quality: 'high', imageModel: 'gpt-image-2' })

    const privateSettings = await store.getPrivate()
    assert.equal(privateSettings.apiKey, 'secret-value')
    assert.equal(privateSettings.mode, 'demo')
    assert.equal(privateSettings.source, 'demo')
    assert.equal(privateSettings.quality, 'high')
  })
})

test('uses safe defaults when the settings file does not exist', async () => {
  await withTempStore(async (store) => {
    assert.deepEqual(await store.getPublic(), {
      mode: 'api',
      source: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      imageModel: 'gpt-image-2',
      quality: 'medium',
      configured: false,
    })
  })
})

test('stores an assisted source without exposing or requiring an API key', async () => {
  await withTempStore(async (store) => {
    assert.deepEqual(await store.update({ source: 'codex' }), {
      mode: 'api',
      source: 'codex',
      baseUrl: 'https://api.openai.com/v1',
      imageModel: 'gpt-image-2',
      quality: 'medium',
      configured: false,
    })
    assert.equal((await store.getPrivate()).source, 'codex')
  })
})

test('migrates legacy demo settings to the demo source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-settings-legacy-'))
  try {
    const filePath = path.join(root, 'settings.json')
    await fs.writeFile(filePath, JSON.stringify({ mode: 'demo', quality: 'low' }))
    const store = createSettingsStore({ filePath })
    assert.equal((await store.getPublic()).source, 'demo')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('migrates the removed desktop source back to OpenAI', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-settings-desktop-'))
  try {
    const filePath = path.join(root, 'settings.json')
    await fs.writeFile(filePath, JSON.stringify({ source: 'desktop', imageModel: 'relay-image-model' }))
    const store = createSettingsStore({ filePath })
    const settings = await store.getPublic()
    assert.equal(settings.source, 'openai')
    assert.equal(settings.imageModel, 'relay-image-model')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
