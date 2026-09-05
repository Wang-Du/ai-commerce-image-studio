import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { readJsonFile, writeJsonFile } from './json-file.js'

const MAX_ASSET_BYTES = 20 * 1024 * 1024
const MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''))
  if (!match || !MIME_EXTENSIONS[match[1]]) {
    throw new Error('仅支持 JPG、PNG 和 WebP 图片')
  }
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
  if (buffer.length > MAX_ASSET_BYTES) throw new Error('单张素材不能超过 20 MB')
  if (buffer.length === 0) throw new Error('图片文件为空')
  return { mimeType: match[1], buffer }
}

function displayName(value) {
  const name = path.basename(String(value || '商品素材')).slice(0, 120).trim()
  return name || '商品素材'
}

export function createAssetStore({ rootDir }) {
  const filesDir = path.join(rootDir, 'files')
  const indexPath = path.join(rootDir, 'assets.json')

  async function list() {
    const records = await readJsonFile(indexPath, [])
    return Array.isArray(records) ? records : []
  }

  async function save(records) {
    await writeJsonFile(indexPath, records)
  }

  return {
    list,
    async createFromDataUrl({ name, dataUrl }) {
      const { mimeType, buffer } = parseDataUrl(dataUrl)
      let metadata
      try {
        metadata = await sharp(buffer).metadata()
      } catch {
        throw new Error('图片文件无法读取或已经损坏')
      }
      if (!metadata.width || !metadata.height) throw new Error('无法识别图片尺寸')

      const id = crypto.randomUUID()
      const filename = `${id}.${MIME_EXTENSIONS[mimeType]}`
      await fs.mkdir(filesDir, { recursive: true })
      await fs.writeFile(path.join(filesDir, filename), buffer, { mode: 0o600 })
      const record = {
        id,
        name: displayName(name),
        filename,
        mimeType,
        width: metadata.width,
        height: metadata.height,
        size: buffer.length,
        createdAt: new Date().toISOString(),
        url: `/asset-files/${filename}`,
      }
      await save([record, ...(await list())])
      return record
    },
    async get(id) {
      return (await list()).find((record) => record.id === id) || null
    },
    async readBuffer(id) {
      const asset = await this.get(id)
      if (!asset) return null
      return fs.readFile(path.join(filesDir, asset.filename))
    },
    async remove(id) {
      const records = await list()
      const asset = records.find((record) => record.id === id)
      if (!asset) return false
      await fs.rm(path.join(filesDir, asset.filename), { force: true })
      await save(records.filter((record) => record.id !== id))
      return true
    },
    async ensureSeed({ sourcePath, name = '演示商品素材' }) {
      const records = await list()
      if (records.length > 0) return records.at(-1)
      const extension = path.extname(sourcePath).toLowerCase()
      const mimeType = extension === '.jpg' || extension === '.jpeg'
        ? 'image/jpeg'
        : extension === '.webp'
          ? 'image/webp'
          : 'image/png'
      const buffer = await fs.readFile(sourcePath)
      return this.createFromDataUrl({ name, dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` })
    },
  }
}
