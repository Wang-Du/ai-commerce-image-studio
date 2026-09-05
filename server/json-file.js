import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return structuredClone(fallback)
    throw error
  }
}

export async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tempPath, filePath)
}
