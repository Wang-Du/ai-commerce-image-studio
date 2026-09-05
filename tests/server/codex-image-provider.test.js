import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

test('closes Codex stdin so non-interactive execution can start immediately', async () => {
  const module = await import('../../server/codex-image-provider.js')
  assert.equal(typeof module.runCodexCommand, 'function')
  let stdinEnded = false
  const execFileImpl = (_executable, _args, _options, callback) => {
    queueMicrotask(() => callback(null, 'ok', ''))
    return { stdin: { end: () => { stdinEnded = true } } }
  }

  const result = await module.runCodexCommand('codex', ['exec'], { execFileImpl })
  assert.equal(stdinEnded, true)
  assert.equal(result.exitCode, 0)
})

test('runs one Codex batch, reads all generated files, and removes its temporary workspace', async () => {
  const module = await import('../../server/codex-image-provider.js').catch(() => null)
  assert.ok(module?.createCodexImageProvider, 'Codex image provider is not implemented')

  let workdir = ''
  let receivedArgs = []
  const provider = module.createCodexImageProvider({
    runCommand: async (_executable, args) => {
      receivedArgs = args
      workdir = args[args.indexOf('-C') + 1]
      await fs.writeFile(path.join(workdir, 'result-01.png'), Buffer.from('first'))
      await fs.writeFile(path.join(workdir, 'result-02.png'), Buffer.from('second'))
      return { exitCode: 0, stdout: 'RESULT_FILES=result-01.png,result-02.png', stderr: '' }
    },
  })

  const results = await provider.generateBatch({
    imageBuffer: Buffer.from('source'),
    mimeType: 'image/png',
    jobs: [
      { prompt: '生成对比图', width: 1200, height: 1200 },
      { prompt: '生成卖点图', width: 900, height: 1200 },
    ],
  })

  assert.deepEqual(results.map((result) => result.ok), [true, true])
  assert.deepEqual(results.map((result) => result.bytes.toString()), ['first', 'second'])
  assert.equal(receivedArgs.includes('-i'), true)
  await assert.rejects(fs.access(workdir))
})

test('returns a clear provider error when Codex produces no image file', async () => {
  const module = await import('../../server/codex-image-provider.js').catch(() => null)
  assert.ok(module?.createCodexImageProvider, 'Codex image provider is not implemented')
  const provider = module.createCodexImageProvider({
    runCommand: async () => ({ exitCode: 1, stdout: '', stderr: 'generation failed' }),
  })

  await assert.rejects(
    provider.generateBatch({
      imageBuffer: Buffer.from('source'),
      mimeType: 'image/png',
      jobs: [{ prompt: '生成商品图', width: 1200, height: 1200 }],
    }),
    (error) => error.code === 'AGENT_GENERATION_FAILED' && /没有产出可读取的图片/.test(error.message),
  )
})
