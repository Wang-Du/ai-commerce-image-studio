import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSettingsStore } from './settings-store.js'
import { createAssetStore } from './asset-store.js'
import { createHistoryRepository } from './history-repository.js'
import { createOpenAIImageProvider } from './openai-image-provider.js'
import { createGenerationService } from './generation-service.js'
import { createDesktopAgentService } from './desktop-agent-service.js'
import { createCodexImageProvider } from './codex-image-provider.js'
import { createApp } from './create-app.js'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localDir = path.join(projectDir, '.local')
const assetRoot = path.join(localDir, 'assets')
const generatedDir = path.join(localDir, 'generated')
const settingsStore = createSettingsStore({ filePath: path.join(localDir, 'settings.json') })
const assetStore = createAssetStore({ rootDir: assetRoot })
const historyRepository = createHistoryRepository({ filePath: path.join(localDir, 'history.json') })
const providerFactory = (options) => createOpenAIImageProvider(options)
const desktopAgentService = createDesktopAgentService()
const codexProviderFactory = () => createCodexImageProvider()
const generationService = createGenerationService({
  assetStore,
  historyRepository,
  settingsStore,
  providerFactory,
  codexProviderFactory,
  generatedDir,
})

await assetStore.ensureSeed({
  sourcePath: path.join(projectDir, 'assets', '舒缓精华产品图.png'),
  name: '舒缓精华产品图.png',
})

const app = createApp({
  settingsStore,
  assetStore,
  historyRepository,
  generationService,
  desktopAgentService,
  providerFactory,
  publicDir: projectDir,
  assetFilesDir: path.join(assetRoot, 'files'),
  generatedDir,
})

const host = '127.0.0.1'
const port = Number(process.env.APP_PORT) || 4317
app.listen(port, host, () => {
  console.log(`AI 商品图生成器已启动：http://${host}:${port}/`)
})
