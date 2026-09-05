import { getTotalImageCount } from './task-model.js'

const HISTORY_LIMIT = 30

export function createHistoryRecord(tasks, {
  id = `batch-${Date.now()}`,
  createdAt = new Date().toISOString(),
  mode = 'demo',
} = {}) {
  return {
    id,
    createdAt,
    mode,
    taskCount: tasks.length,
    imageCount: getTotalImageCount(tasks),
    status: 'done',
    tasks: tasks.map((task) => ({
      id: task.id,
      type: task.type,
      ratio: task.ratio,
      width: task.width,
      height: task.height,
      quantity: task.quantity,
      prompt: task.prompt,
    })),
  }
}

export function appendHistoryRecord(records, record) {
  return [record, ...records].slice(0, HISTORY_LIMIT)
}

export function normalizeHistory(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) return []
    return parsed.filter((record) => (
      record
      && typeof record.id === 'string'
      && typeof record.createdAt === 'string'
      && Array.isArray(record.tasks)
    )).slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}
