import crypto from 'node:crypto'
import { readJsonFile, writeJsonFile } from './json-file.js'

const active = (job) => ['queued', 'running'].includes(job.status)
const now = () => new Date().toISOString()

function failRemaining(job, code, message) {
  const finished = [...job.results, ...job.failures]
  for (const task of job.tasks) {
    for (let index = 0; index < task.quantity; index++) {
      if (!finished.some((item) => item.taskId === task.id && item.index === index)) {
        job.failures.push({ taskId: task.id, index, code, message })
      }
    }
  }
  job.status = job.results.length ? 'partial' : 'error'
  job.finishedAt = now()
}

export async function createGenerationQueue({ filePath, generationService, historyRepository }) {
  let records = await readJsonFile(filePath, [])
  if (!Array.isArray(records)) records = []
  const preparedBatches = new Map()
  const deletedWhileFinishing = new Set()
  let writes = Promise.resolve()
  let submissions = Promise.resolve()
  let running = false

  function persist() {
    const snapshot = structuredClone(records)
    const operation = writes.then(() => writeJsonFile(filePath, snapshot))
    writes = operation.catch(() => {})
    return operation
  }

  // A browser disconnect is harmless. A server restart cannot safely repeat a paid request.
  const history = await historyRepository.list()
  for (const job of records.filter(active)) {
    const saved = history.find((batch) => batch.id === job.id)
    if (saved) Object.assign(job, saved, { finishedAt: saved.createdAt })
    else {
      failRemaining(job, 'SERVER_RESTARTED', '本地服务已关闭或重启，本批任务中断。请检查已有图片，再手动提交需要重做的任务。')
      await historyRepository.append(job)
    }
  }
  await persist()

  async function processQueue() {
    if (running) return
    running = true
    try {
      let job
      while ((job = records.find((item) => item.status === 'queued' && preparedBatches.has(item.id)))) {
        const prepared = preparedBatches.get(job.id)
        try {
          job.status = 'running'
          job.startedAt = now()
          await persist()
          const batch = await generationService.generateBatch(null, {
            prepared,
            batchId: job.id,
            onProgress: async (progress) => { Object.assign(job, progress); await persist() },
          })
          Object.assign(job, batch, { submittedAt: job.submittedAt, finishedAt: now() })
        } catch (error) {
          failRemaining(job, error.code || 'GENERATION_FAILED', error.code ? error.message : '生成失败，请检查本地服务后重试。')
          await historyRepository.append(job)
        } finally {
          if (deletedWhileFinishing.has(job.id)) await historyRepository.remove(job.id)
          deletedWhileFinishing.delete(job.id)
          preparedBatches.delete(job.id)
          await persist()
        }
      }
    } finally {
      running = false
    }
  }

  return {
    list: () => structuredClone([...records].reverse()),
    async forgetHistory(recordIds) {
      const ids = new Set(recordIds)
      // IDs come from existing history, not from active jobs. Handle the small interval
      // between writing a completed history entry and marking its queue item done.
      for (const job of records) {
        if (ids.has(job.id) && active(job)) deletedWhileFinishing.add(job.id)
      }
      records = records.filter((job) => !ids.has(job.id))
      await persist()
    },
    submit(payload) {
      // Copy immediately, before asynchronous validation or another request can mutate it.
      const input = structuredClone(payload)
      const operation = submissions.then(async () => {
        if (records.filter(active).length >= 20) {
          throw Object.assign(new Error('后台最多保留 20 批待完成任务，请等一批完成后再提交'), { code: 'QUEUE_FULL', status: 429 })
        }
        const prepared = await generationService.prepareBatch(input)
        const { asset, normalizedTasks: tasks, settings } = prepared
        const job = {
          id: crypto.randomUUID(), createdAt: now(), submittedAt: now(), status: 'queued',
          assetId: asset.id, assetName: asset.name, tasks, taskCount: tasks.length,
          imageCount: tasks.reduce((sum, task) => sum + task.quantity, 0),
          source: settings.source,
          mode: settings.source === 'openai' ? 'api' : settings.source === 'codex' ? 'agent' : 'demo',
          model: settings.source === 'openai' ? settings.imageModel : settings.source === 'codex' ? 'gpt-5.6-sol + ImageGen' : 'demo',
          results: [], failures: [],
        }
        records.push(job)
        records = records.filter((item, index) => active(item) || index >= records.length - 100)
        try { await persist() } catch (error) { records = records.filter((item) => item !== job); throw error }
        preparedBatches.set(job.id, prepared)
        const accepted = structuredClone(job)
        // The queue belongs to the server, never to an HTTP connection.
        void processQueue().catch(() => { console.error('后台任务状态保存失败，请检查本地磁盘空间和权限。') })
        return accepted
      })
      submissions = operation.catch(() => {})
      return operation
    },
  }
}
