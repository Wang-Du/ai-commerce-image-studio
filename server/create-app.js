import express from 'express'

function errorBody(error) {
  return {
    code: error.code || 'INTERNAL_ERROR',
    message: error.code ? error.message : '本地服务处理失败，请稍后重试',
  }
}

export function createApp({
  settingsStore,
  assetStore,
  historyRepository,
  generationService,
  generationQueue,
  desktopAgentService,
  providerFactory,
  publicDir,
  assetFilesDir,
  generatedDir,
}) {
  const app = express()

  app.use(express.json({ limit: '30mb' }))
  app.use((request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next()
    const origin = request.get('origin')
    if (!origin) return next()
    try {
      if (new URL(origin).host === request.get('host')) return next()
    } catch {
      // The stable error response below handles malformed origins.
    }
    return response.status(403).json({
      code: 'CROSS_ORIGIN_WRITE_BLOCKED',
      message: '本地服务拒绝了来自其他网站的写入请求',
    })
  })

  app.get('/api/health', async (_request, response, next) => {
    try {
      const settings = await settingsStore.getPublic()
      response.json({
        ok: true,
        service: 'ai-commerce-image-studio',
        configured: settings.configured,
        mode: settings.mode,
        source: settings.source,
      })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/settings', async (_request, response, next) => {
    try {
      response.json(await settingsStore.getPublic())
    } catch (error) {
      next(error)
    }
  })

  app.put('/api/settings', async (request, response, next) => {
    try {
      if (request.body?.source === 'codex' && !desktopAgentService.canSelect()) {
        throw Object.assign(new Error('请先测试 Codex 桌面 Agent 连通性，通过后再选择'), {
          code: 'AGENT_TEST_REQUIRED',
          status: 409,
        })
      }
      response.json(await settingsStore.update(request.body))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/settings/test', async (_request, response, next) => {
    try {
      const settings = await settingsStore.getPrivate()
      if (settings.source === 'demo') return response.json({ ok: true, mode: 'demo', source: 'demo' })
      if (settings.source === 'codex') return response.json(await desktopAgentService.testConnection())
      if (!settings.apiKey) {
        throw Object.assign(new Error('请先填写并保存 API Key'), {
          code: 'MODEL_NOT_CONFIGURED',
          status: 409,
        })
      }
      response.json(await providerFactory({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        imageModel: settings.imageModel,
      }).testConnection())
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/agent/status', async (_request, response, next) => {
    try {
      response.json(await desktopAgentService.getStatus())
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/agent/test', async (_request, response, next) => {
    try {
      response.json(await desktopAgentService.testConnection())
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/assets', async (_request, response, next) => {
    try {
      response.json(await assetStore.list())
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/assets', async (request, response, next) => {
    try {
      response.status(201).json(await assetStore.createFromDataUrl(request.body))
    } catch (error) {
      next(Object.assign(error, { code: error.code || 'INVALID_ASSET', status: error.status || 400 }))
    }
  })

  app.delete('/api/assets/:id', async (request, response, next) => {
    try {
      const removed = await assetStore.remove(request.params.id)
      if (!removed) return response.status(404).json({ code: 'ASSET_NOT_FOUND', message: '素材不存在' })
      response.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/history', async (_request, response, next) => {
    try {
      response.json(await historyRepository.list())
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/history', async (_request, response, next) => {
    try {
      const recordIds = (await historyRepository.list()).map((record) => record.id)
      await historyRepository.clear()
      await generationQueue?.forgetHistory(recordIds)
      response.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/history/:id', async (request, response, next) => {
    try {
      const removed = await historyRepository.remove(request.params.id)
      if (!removed) return response.status(404).json({ code: 'HISTORY_NOT_FOUND', message: '生成记录不存在' })
      await generationQueue?.forgetHistory([request.params.id])
      response.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/generate', async (request, response, next) => {
    try {
      response.json(await generationService.generateBatch(request.body))
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/jobs', (_request, response) => {
    response.set('Cache-Control', 'no-store').json(generationQueue.list())
  })

  app.post('/api/jobs', async (request, response, next) => {
    try {
      response.status(202).json(await generationQueue.submit(request.body))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/handoffs', async (request, response, next) => {
    try {
      response.status(201).json(await generationService.createHandoff(request.body))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/import-results', async (request, response, next) => {
    try {
      response.status(201).json(await generationService.importBatch(request.body))
    } catch (error) {
      next(error)
    }
  })

  app.use('/asset-files', express.static(assetFilesDir, { dotfiles: 'deny', fallthrough: false }))
  app.use('/generated', express.static(generatedDir, { dotfiles: 'deny', fallthrough: false }))
  app.use(express.static(publicDir, { dotfiles: 'deny', index: 'index.html' }))

  app.use((error, _request, response, _next) => {
    const status = Number(error.status) || (error.type === 'entity.too.large' ? 413 : 500)
    response.status(status).json(errorBody(error))
  })

  return app
}
