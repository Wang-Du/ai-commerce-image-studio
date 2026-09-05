const DEFAULT_SETTINGS = {
  mode: 'demo',
  baseUrl: 'http://127.0.0.1:8787',
  textModel: '',
  imageModel: '',
}

export function normalizeApiSettings(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS }
    return {
      mode: parsed.mode === 'api' ? 'api' : 'demo',
      baseUrl: String(parsed.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ''),
      textModel: String(parsed.textModel || ''),
      imageModel: String(parsed.imageModel || ''),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

async function readResponse(response) {
  let payload = {}
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }

  if (!response.ok) {
    throw Object.assign(
      new Error(payload.message || `API 请求失败（HTTP ${response.status}）`),
      { code: payload.code || 'API_REQUEST_FAILED', status: response.status },
    )
  }
  return payload
}

export class ApiGatewayClient {
  constructor({
    baseUrl,
    textModel = '',
    imageModel = '',
    fetchImpl,
  }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.textModel = textModel
    this.imageModel = imageModel
    this.fetchImpl = fetchImpl || globalThis.fetch.bind(globalThis)
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined
        ? { Accept: 'application/json' }
        : { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return readResponse(response)
  }

  async health() {
    return this.request('/api/health')
  }

  async getSettings() { return this.request('/api/settings') }

  async saveSettings(settings) { return this.request('/api/settings', { method: 'PUT', body: settings }) }

  async testSettings() { return this.request('/api/settings/test', { method: 'POST', body: {} }) }

  async getDesktopAgentStatus() { return this.request('/api/agent/status') }

  async testDesktopAgent() { return this.request('/api/agent/test', { method: 'POST', body: {} }) }

  async listAssets() { return this.request('/api/assets') }

  async uploadAsset(asset) { return this.request('/api/assets', { method: 'POST', body: asset }) }

  async deleteAsset(id) { return this.request(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }) }

  async listHistory() { return this.request('/api/history') }

  async clearHistory() { return this.request('/api/history', { method: 'DELETE' }) }

  async deleteHistory(id) { return this.request(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' }) }

  async generateBatch(payload) { return this.request('/api/generate', { method: 'POST', body: payload }) }

  async submitGeneration(payload) { return this.request('/api/jobs', { method: 'POST', body: payload }) }

  async listGenerationJobs() { return this.request('/api/jobs') }

  async createHandoff(payload) { return this.request('/api/handoffs', { method: 'POST', body: payload }) }

  async importResults(payload) { return this.request('/api/import-results', { method: 'POST', body: payload }) }

  async generate(task, onProgress, { productImage = null } = {}) {
    onProgress(10)
    const response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        task,
        productImage,
        textModel: this.textModel,
        imageModel: this.imageModel,
      }),
    })
    onProgress(75)
    const payload = await readResponse(response)
    if (!Array.isArray(payload.results)) {
      throw new Error('API 返回格式不正确：缺少 results 数组')
    }
    onProgress(100)
    return payload.results
  }
}
