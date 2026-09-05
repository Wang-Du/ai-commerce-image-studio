import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAssetStore } from '../../server/asset-store.js'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3rQAAAAASUVORK5CYII='

async function withStore(run) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-assets-'))
  try {
    return await run(createAssetStore({ rootDir }), rootDir)
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true })
  }
}

test('persists an uploaded PNG and returns safe metadata', async () => {
  await withStore(async (store, rootDir) => {
    const asset = await store.createFromDataUrl({ name: 'product.png', dataUrl: PNG_DATA_URL })

    assert.equal(asset.name, 'product.png')
    assert.equal(asset.width, 1)
    assert.equal(asset.height, 1)
    assert.match(asset.url, /^\/asset-files\//)
    assert.equal((await store.list()).length, 1)
    assert.equal((await fs.stat(path.join(rootDir, 'files', asset.filename))).isFile(), true)
  })
})

test('rejects unsupported and oversized asset data', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      store.createFromDataUrl({ name: 'note.txt', dataUrl: 'data:text/plain;base64,SGVsbG8=' }),
      /仅支持 JPG、PNG 和 WebP/,
    )
    const tooLarge = `data:image/png;base64,${Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64')}`
    await assert.rejects(store.createFromDataUrl({ name: 'large.png', dataUrl: tooLarge }), /不能超过 20 MB/)
  })
})

test('removes both asset metadata and its file', async () => {
  await withStore(async (store, rootDir) => {
    const asset = await store.createFromDataUrl({ name: 'product.png', dataUrl: PNG_DATA_URL })
    assert.equal(await store.remove(asset.id), true)
    assert.deepEqual(await store.list(), [])
    await assert.rejects(fs.stat(path.join(rootDir, 'files', asset.filename)), { code: 'ENOENT' })
  })
})
