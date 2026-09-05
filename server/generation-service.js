import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { buildGenerationPrompt, toModelSize } from './image-rules.js'

function appError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 5) {
    throw appError('INVALID_TASKS', '每次需要提交 1 到 5 个生成任务')
  }
  return tasks.map((task) => {
    const quantity = Number(task?.quantity)
    if (!task?.id || !Number.isInteger(quantity) || quantity < 1 || quantity > 4) {
      throw appError('INVALID_TASK', '每个任务必须包含 ID，且生成数量为 1 到 4 张')
    }
    const width = Number(task.width)
    const height = Number(task.height)
    toModelSize(width, height)
    return {
      id: String(task.id),
      type: ['compare', 'feature', 'review'].includes(task.type) ? task.type : 'feature',
      ratio: String(task.ratio || `${width}:${height}`),
      width,
      height,
      quantity,
      prompt: String(task.prompt || '').slice(0, 1000),
    }
  })
}

const HANDOFF_SOURCES = new Set(['codex'])
const IMPORT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function decodeImportedImage(file) {
  const match = String(file?.dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/)
  if (!match || !IMPORT_TYPES.has(match[1])) {
    throw appError('INVALID_IMPORT', '导入结果只支持 JPG、PNG 或 WebP 图片')
  }
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
  if (bytes.length < 1 || bytes.length > 20 * 1024 * 1024) {
    throw appError('INVALID_IMPORT', '单张导入结果必须小于 20 MB')
  }
  return bytes
}

function buildJobs(tasks) {
  return tasks.flatMap((task) =>
    Array.from({ length: task.quantity }, (_, index) => ({ task, index })),
  )
}

function sourceLabel() { return 'Codex Desktop Agent' }

async function runWithConcurrency(jobs, limit, worker) {
  let cursor = 0
  const output = new Array(jobs.length)
  async function run() {
    while (cursor < jobs.length) {
      const index = cursor
      cursor += 1
      output[index] = await worker(jobs[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, run))
  return output
}

export function createGenerationService({
  assetStore,
  historyRepository,
  settingsStore,
  providerFactory,
  codexProviderFactory,
  generatedDir,
}) {
  async function saveOutput(bytes, task, { index, mode }) {
    const outputBytes = await sharp(bytes)
      .resize(task.width, task.height, { fit: 'cover', position: 'centre' })
      .png({ compressionLevel: 8 })
      .toBuffer()
    const filename = `${crypto.randomUUID()}.png`
    await fs.writeFile(path.join(generatedDir, filename), outputBytes, { mode: 0o600 })
    return {
      id: crypto.randomUUID(),
      taskId: task.id,
      index,
      filename,
      imageUrl: `/generated/${filename}`,
      width: task.width,
      height: task.height,
      createdAt: new Date().toISOString(),
      mode,
      source: mode,
    }
  }

  async function prepareBatch({ assetId, tasks } = {}) {
    const normalizedTasks = validateTasks(tasks)
    const asset = await assetStore.get(String(assetId || ''))
    if (!asset) throw appError('ASSET_NOT_FOUND', '请选择一个有效的商品素材', 404)
    const sourceBuffer = await assetStore.readBuffer(asset.id)
    const settings = await settingsStore.getPrivate()
    if (settings.source === 'openai' && !settings.apiKey) {
      throw appError('MODEL_NOT_CONFIGURED', '请先在模型设置中填写并保存 API Key', 409)
    }
    return { normalizedTasks, asset, sourceBuffer, settings }
  }

  return {
    prepareBatch,
    async generateBatch(payload, { prepared, batchId, onProgress = async () => {} } = {}) {
      const { normalizedTasks, asset, sourceBuffer, settings } = prepared || await prepareBatch(payload)
      const completed = []
      async function report(outcome) {
        completed.push(outcome)
        await onProgress({
          results: completed.filter((item) => item.ok).map((item) => item.value),
          failures: completed.filter((item) => !item.ok).map((item) => item.value),
        })
        return outcome
      }

      await fs.mkdir(generatedDir, { recursive: true })
      const provider = settings.source === 'openai'
        ? providerFactory({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, imageModel: settings.imageModel })
        : null
      const jobs = buildJobs(normalizedTasks)

      let outcomes
      if (settings.source === 'codex') {
        if (typeof codexProviderFactory !== 'function') {
          throw appError('AGENT_GENERATION_UNAVAILABLE', 'Codex 图片生成器未正确启动', 503)
        }
        const agentOutputs = await codexProviderFactory().generateBatch({
          imageBuffer: sourceBuffer,
          mimeType: asset.mimeType,
          jobs: jobs.map(({ task }) => ({
            prompt: buildGenerationPrompt(task),
            width: task.width,
            height: task.height,
          })),
        })
        outcomes = await Promise.all(jobs.map(async ({ task, index }, jobIndex) => {
          const output = agentOutputs[jobIndex]
          if (!output?.ok) {
            return {
              ok: false,
              value: {
                taskId: task.id,
                index,
                code: output?.code || 'AGENT_OUTPUT_MISSING',
                message: output?.message || 'Codex 未返回这张图片',
              },
            }
          }
          try {
            return { ok: true, value: await saveOutput(output.bytes, task, { index, mode: 'codex' }) }
          } catch (error) {
            return {
              ok: false,
              value: {
                taskId: task.id,
                index,
                code: error.code || 'INVALID_AGENT_OUTPUT',
                message: error.message || 'Codex 返回的图片无法读取',
              },
            }
          }
        }).map((operation) => operation.then(report)))
      } else {
        outcomes = await runWithConcurrency(jobs, 2, async ({ task, index }) => {
        let outcome
        try {
          const modelBytes = settings.source === 'openai'
            ? await provider.edit({
              imageBuffer: sourceBuffer,
              mimeType: asset.mimeType,
              prompt: buildGenerationPrompt(task),
              size: toModelSize(task.width, task.height),
              quality: settings.quality,
            })
            : sourceBuffer
          outcome = {
            ok: true,
            value: await saveOutput(modelBytes, task, { index, mode: settings.source === 'openai' ? 'api' : 'demo' }),
          }
        } catch (error) {
          outcome = {
            ok: false,
            value: {
              taskId: task.id,
              index,
              code: error.code || 'GENERATION_FAILED',
              message: error.message || '图片生成失败',
            },
          }
        }
        return report(outcome)
        })
      }

      const batch = {
        id: batchId || crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        mode: settings.source === 'openai' ? 'api' : settings.source === 'codex' ? 'agent' : 'demo',
        source: settings.source,
        model: settings.source === 'openai' ? settings.imageModel : settings.source === 'codex' ? 'gpt-5.6-sol + ImageGen' : 'demo',
        quality: settings.source === 'codex' ? 'agent' : settings.quality,
        assetId: asset.id,
        assetName: asset.name,
        taskCount: normalizedTasks.length,
        imageCount: jobs.length,
        status: outcomes.every((item) => item.ok)
          ? 'done'
          : outcomes.some((item) => item.ok) ? 'partial' : 'error',
        tasks: normalizedTasks,
        results: outcomes.filter((item) => item.ok).map((item) => item.value),
        failures: outcomes.filter((item) => !item.ok).map((item) => item.value),
      }
      await historyRepository.append(batch)
      return batch
    },
    async createHandoff({ source, assetId, tasks }) {
      if (!HANDOFF_SOURCES.has(source)) throw appError('INVALID_SOURCE', '任务交接只支持 Codex')
      const normalizedTasks = validateTasks(tasks)
      const asset = await assetStore.get(String(assetId || ''))
      if (!asset) throw appError('ASSET_NOT_FOUND', '请选择一个有效的商品素材', 404)
      const entries = buildJobs(normalizedTasks).map(({ task, index }, order) => ({
        order: order + 1,
        taskId: task.id,
        index,
        type: task.type,
        ratio: task.ratio,
        width: task.width,
        height: task.height,
        prompt: buildGenerationPrompt(task),
      }))
      const lines = [
        '# AI 商品图任务交接包',
        '',
        `使用来源：${sourceLabel(source)}`,
        `商品素材：${asset.name}（请将该商品图作为每个任务的参考图）`,
        `共 ${normalizedTasks.length} 个任务、${entries.length} 张结果。请严格按下列顺序输出。`,
        '',
        ...entries.flatMap((entry) => [
          `## ${entry.order}. 任务 ${entry.taskId} / 第 ${entry.index + 1} 张`,
          `目标尺寸：${entry.width} × ${entry.height}px（${entry.ratio}）`,
          entry.prompt,
          '',
        ]),
        '完成后，将图片按上面的编号顺序一次性导回工作台。',
      ]
      return {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        source,
        asset: { id: asset.id, name: asset.name, url: asset.url, width: asset.width, height: asset.height },
        taskCount: normalizedTasks.length,
        imageCount: entries.length,
        tasks: normalizedTasks,
        entries,
        promptText: lines.join('\n'),
      }
    },
    async importBatch({ source, assetId, tasks, files }) {
      if (!HANDOFF_SOURCES.has(source)) throw appError('INVALID_SOURCE', '导入结果必须来自 Codex')
      const normalizedTasks = validateTasks(tasks)
      const asset = await assetStore.get(String(assetId || ''))
      if (!asset) throw appError('ASSET_NOT_FOUND', '请选择一个有效的商品素材', 404)
      const jobs = buildJobs(normalizedTasks)
      if (!Array.isArray(files) || files.length !== jobs.length) {
        throw appError('IMPORT_COUNT_MISMATCH', `需要按任务顺序导入 ${jobs.length} 张图片`)
      }
      const decoded = files.map(decodeImportedImage)
      await Promise.all(decoded.map(async (bytes) => {
        try {
          await sharp(bytes).metadata()
        } catch {
          throw appError('INVALID_IMPORT', '导入文件不是可读取的图片')
        }
      }))
      await fs.mkdir(generatedDir, { recursive: true })
      const results = await runWithConcurrency(jobs, 2, ({ task, index }, jobIndex) =>
        saveOutput(decoded[jobIndex], task, { index, mode: source }),
      )
      const batch = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        mode: 'assisted',
        source,
        model: sourceLabel(source),
        quality: 'imported',
        assetId: asset.id,
        assetName: asset.name,
        taskCount: normalizedTasks.length,
        imageCount: jobs.length,
        status: 'done',
        tasks: normalizedTasks,
        results,
        failures: [],
      }
      await historyRepository.append(batch)
      return batch
    },
  }
}
