import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_SETTINGS = {
  mode: 'api',
  source: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  imageModel: 'gpt-image-2',
  quality: 'medium',
  apiKey: '',
}

const VALID_QUALITIES = new Set(['low', 'medium', 'high'])
const VALID_SOURCES = new Set(['openai', 'codex', 'demo'])

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.baseUrl
}

function normalize(value = {}) {
  const legacySource = value.mode === 'demo' ? 'demo' : 'openai'
  const source = VALID_SOURCES.has(value.source) ? value.source : legacySource
  return {
    mode: source === 'demo' ? 'demo' : 'api',
    source,
    baseUrl: normalizeBaseUrl(value.baseUrl),
    imageModel: String(value.imageModel || DEFAULT_SETTINGS.imageModel).trim() || DEFAULT_SETTINGS.imageModel,
    quality: VALID_QUALITIES.has(value.quality) ? value.quality : DEFAULT_SETTINGS.quality,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
  }
}

export function createSettingsStore({ filePath }) {
  async function read() {
    try {
      return normalize(JSON.parse(await fs.readFile(filePath, 'utf8')))
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return { ...DEFAULT_SETTINGS }
      throw error
    }
  }

  async function write(settings) {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.tmp`
    await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(tempPath, filePath)
    await fs.chmod(filePath, 0o600)
  }

  return {
    async getPrivate() {
      return read()
    },
    async getPublic() {
      const settings = await read()
      return {
        mode: settings.mode,
        source: settings.source,
        baseUrl: settings.baseUrl,
        imageModel: settings.imageModel,
        quality: settings.quality,
        configured: Boolean(settings.apiKey),
      }
    },
    async update(patch = {}) {
      const current = await read()
      const next = normalize({
        ...current,
        ...patch,
        source: VALID_SOURCES.has(patch.source)
          ? patch.source
          : typeof patch.mode === 'string'
            ? patch.mode === 'demo' ? 'demo' : 'openai'
            : current.source,
        apiKey: typeof patch.apiKey === 'string' && patch.apiKey.trim()
          ? patch.apiKey
          : current.apiKey,
      })
      await write(next)
      return this.getPublic()
    },
  }
}
