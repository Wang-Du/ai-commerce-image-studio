import test from 'node:test'
import assert from 'node:assert/strict'
import { AI_SOURCES, canSelectSource, getSourcePresentation, sourceUsesHandoff } from '../ai-source.js'

test('requires a successful connectivity test before Codex can be selected', () => {
  assert.equal(canSelectSource('codex', { connected: false, tested: true }), false)
  assert.equal(canSelectSource('codex', { connected: true, tested: true, imageGeneration: true }), true)
  assert.equal(canSelectSource('codex', { connected: true, tested: true, imageGeneration: false }), false)
  assert.equal(canSelectSource('openai', null), true)
  assert.equal(canSelectSource('desktop', null), false)
})

test('labels automatic and assisted sources truthfully', () => {
  assert.equal(getSourcePresentation({ source: 'openai', configured: false }).badge, 'OpenAI · 待配置')
  assert.equal(getSourcePresentation({ source: 'codex' }, { connected: true }).badge, 'Codex Agent · 已连接')
  assert.equal(getSourcePresentation({ source: 'demo' }).resultLabel, '演示结果')
})

test('exposes only API, Codex, and demo sources', () => {
  assert.deepEqual(AI_SOURCES.map((source) => source.id), ['openai', 'codex', 'demo'])
  assert.equal(sourceUsesHandoff('codex'), false)
  assert.equal(sourceUsesHandoff('desktop'), false)
  assert.equal(sourceUsesHandoff('openai'), false)
})

test('opens setup only when the selected automatic source is not ready', async () => {
  const module = await import('../ai-source.js')
  assert.equal(typeof module.getRequiredSetup, 'function')
  assert.equal(module.getRequiredSetup({ source: 'openai', configured: false }, null), 'openai')
  assert.equal(module.getRequiredSetup({ source: 'openai', configured: true }, null), null)
  assert.equal(module.getRequiredSetup({ source: 'codex' }, { connected: true, tested: true, imageGeneration: false }), 'codex')
  assert.equal(module.getRequiredSetup({ source: 'codex' }, { connected: true, tested: true, imageGeneration: true }), null)
  assert.equal(module.getRequiredSetup({ source: 'desktop' }, null), 'openai')
})
