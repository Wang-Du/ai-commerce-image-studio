import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_EXECUTABLE = '/Applications/ChatGPT.app/Contents/Resources/codex'
const DEFAULT_MODEL = 'gpt-5.6-sol'

function providerError(message) {
  return Object.assign(new Error(message), { code: 'AGENT_GENERATION_FAILED', status: 502 })
}

export function runCodexCommand(executable, args, { execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    const child = execFileImpl(executable, args, {
      encoding: 'utf8',
      timeout: 20 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout = '', stderr = '') => {
      resolve({
        exitCode: Number.isInteger(error?.code) ? error.code : error ? 1 : 0,
        stdout,
        stderr,
        error,
      })
    })
    child.stdin?.end()
  })
}

function defaultRunCommand(executable, args) {
  return runCodexCommand(executable, args)
}

function inputExtension(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

function buildPrompt(jobs, filenames) {
  const instructions = jobs.map((job, index) => [
    `${index + 1}. 输出文件：${filenames[index]}`,
    `   目标比例：${job.width} × ${job.height}`,
    `   生成要求：${job.prompt}`,
  ].join('\n')).join('\n\n')

  return [
    '你是本地商品图批量生成执行器。',
    '附带的图片是所有任务共用的商品参考图。',
    `请使用图片生成工具生成 ${jobs.length} 张独立图片，每个任务一张，严禁用复制参考图代替生成。`,
    '商品包装、标志、文字和核心配色应尽量保持一致，不得凭空添加价格、二维码或新品牌。',
    '生成后把每张最终图片复制到当前目录，使用以下精确文件名：',
    '',
    instructions,
    '',
    '不要修改其他目录或项目文件。所有文件落盘后，最后只回复 RESULT_FILES=' + filenames.join(','),
  ].join('\n')
}

export function createCodexImageProvider({
  executable = DEFAULT_EXECUTABLE,
  model = DEFAULT_MODEL,
  runCommand = defaultRunCommand,
} = {}) {
  return {
    async generateBatch({ imageBuffer, mimeType, jobs }) {
      if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        throw providerError('商品参考图无法读取')
      }
      if (!Array.isArray(jobs) || jobs.length === 0) {
        throw providerError('没有可生成的图片任务')
      }

      const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-commerce-codex-'))
      const inputPath = path.join(workdir, `product.${inputExtension(mimeType)}`)
      const messagePath = path.join(workdir, 'last-message.txt')
      const filenames = jobs.map((_, index) => `result-${String(index + 1).padStart(2, '0')}.png`)

      try {
        await fs.writeFile(inputPath, imageBuffer, { mode: 0o600 })
        const result = await runCommand(executable, [
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '-s', 'workspace-write',
          '-m', model,
          '-c', 'model_reasoning_effort="low"',
          '--color', 'never',
          '-C', workdir,
          '-i', inputPath,
          '-o', messagePath,
          buildPrompt(jobs, filenames),
        ])

        const outputs = await Promise.all(filenames.map(async (filename) => {
          try {
            return { ok: true, bytes: await fs.readFile(path.join(workdir, filename)) }
          } catch {
            return {
              ok: false,
              code: 'AGENT_OUTPUT_MISSING',
              message: `Codex 未生成 ${filename}，可单独重试对应任务`,
            }
          }
        }))

        if (!outputs.some((output) => output.ok)) {
          const detail = String(result?.stderr || result?.stdout || '').trim().split('\n').at(-1)
          throw providerError(`Codex 没有产出可读取的图片${detail ? `：${detail}` : ''}`)
        }
        return outputs
      } finally {
        await fs.rm(workdir, { recursive: true, force: true })
      }
    },
  }
}
