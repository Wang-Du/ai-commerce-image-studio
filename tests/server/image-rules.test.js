import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGenerationPrompt, toModelSize } from '../../server/image-rules.js'

test('builds a product-preserving prompt from the task', () => {
  const text = buildGenerationPrompt({
    type: 'feature',
    prompt: '突出轻盈肤感',
    width: 900,
    height: 1200,
  })

  assert.match(text, /保持商品包装、商标、文字和核心配色/)
  assert.match(text, /突出轻盈肤感/)
  assert.match(text, /900 × 1200/)
})

test('maps commerce dimensions to the nearest valid GPT Image dimensions', () => {
  assert.equal(toModelSize(900, 1200), '896x1200')
  assert.equal(toModelSize(1080, 1350), '1088x1344')
  assert.equal(toModelSize(1080, 1920), '1088x1920')
})

test('rejects unsupported target dimensions', () => {
  assert.throws(() => toModelSize(0, 1200), /图片尺寸必须是正整数/)
  assert.throws(() => toModelSize(5000, 1000), /最长边不能超过 3840/)
  assert.throws(() => toModelSize(3000, 500), /长宽比不能超过 3:1/)
})
