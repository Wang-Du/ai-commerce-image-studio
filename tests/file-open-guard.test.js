import test from 'node:test'
import assert from 'node:assert/strict'

test('replaces dead file navigation with a local-service launch instruction', async () => {
  let readyHandler
  globalThis.window = {
    location: { protocol: 'file:' },
    addEventListener: (_name, handler) => { readyHandler = handler },
  }
  globalThis.document = { body: { innerHTML: '' } }
  try {
    await import(`../file-open-guard.js?test=${Date.now()}`)
    readyHandler()
    assert.match(document.body.innerHTML, /需要先启动本地服务/)
    assert.match(document.body.innerHTML, /启动 AI 商品图生成器\.command/)
  } finally {
    delete globalThis.window
    delete globalThis.document
  }
})
