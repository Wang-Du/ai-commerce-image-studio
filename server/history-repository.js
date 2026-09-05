import { readJsonFile, writeJsonFile } from './json-file.js'

const HISTORY_LIMIT = 100

function newestFirst(records) {
  return [...records].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export function createHistoryRepository({ filePath }) {
  async function list() {
    const records = await readJsonFile(filePath, [])
    return Array.isArray(records) ? newestFirst(records).slice(0, HISTORY_LIMIT) : []
  }

  return {
    list,
    async append(record) {
      const records = (await list()).filter((item) => item.id !== record.id)
      await writeJsonFile(filePath, newestFirst([record, ...records]).slice(0, HISTORY_LIMIT))
      return record
    },
    async remove(id) {
      const records = await list()
      if (!records.some((record) => record.id === id)) return false
      await writeJsonFile(filePath, records.filter((record) => record.id !== id))
      return true
    },
    async clear() {
      await writeJsonFile(filePath, [])
    },
  }
}
