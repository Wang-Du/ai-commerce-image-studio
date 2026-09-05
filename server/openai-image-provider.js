import OpenAI, { toFile } from 'openai'

function providerError(error) {
  if (error?.code && String(error.code).toUpperCase() === error.code) return error

  const status = Number(error?.status)
  const providerCode = String(error?.code || '')
  let code = 'PROVIDER_ERROR'
  let message = '图片模型暂时不可用，请稍后重试'

  if (status === 401 || status === 403) {
    code = 'AUTHENTICATION_FAILED'
    message = 'API Key 无效或没有该图片模型的访问权限'
  } else if (status === 429) {
    code = 'RATE_LIMITED'
    message = '模型请求过快或额度暂时受限，请稍后重试'
  } else if (status === 402 || providerCode.includes('billing') || providerCode.includes('quota')) {
    code = 'BILLING_REQUIRED'
    message = '模型账户余额或额度不足，请检查 API 账户'
  } else if (providerCode.includes('content') || providerCode.includes('safety')) {
    code = 'CONTENT_BLOCKED'
    message = '本次内容被模型安全规则拦截，请调整图片或提示词'
  }

  return Object.assign(new Error(message), { code, status: status || 502, cause: error })
}

export function createOpenAIImageProvider({
  apiKey,
  baseUrl = 'https://api.openai.com/v1',
  imageModel = 'gpt-image-2',
  clientFactory = (options) => new OpenAI(options),
  toFileImpl = toFile,
}) {
  const client = clientFactory({ apiKey, baseURL: String(baseUrl).replace(/\/+$/, '') })

  return {
    async testConnection() {
      try {
        await client.models.retrieve(imageModel)
        return { ok: true, model: imageModel }
      } catch (error) {
        throw providerError(error)
      }
    },
    async edit({ imageBuffer, mimeType, prompt, size, quality }) {
      try {
        const image = await toFileImpl(imageBuffer, 'product-reference', { type: mimeType })
        const response = await client.images.edit({
          model: imageModel,
          image,
          prompt,
          size,
          quality,
        })
        const encoded = response?.data?.[0]?.b64_json
        if (!encoded) throw Object.assign(new Error('图片模型没有返回图片数据'), { code: 'EMPTY_MODEL_OUTPUT' })
        return Buffer.from(encoded, 'base64')
      } catch (error) {
        throw providerError(error)
      }
    },
  }
}
