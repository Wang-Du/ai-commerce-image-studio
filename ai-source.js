export const AI_SOURCES = [
  {
    id: 'openai',
    title: 'OpenAI API',
    description: '自动调用图片模型，生成后直接回到画布。',
    action: '填写 API Key',
  },
  {
    id: 'codex',
    title: 'Codex 桌面 Agent',
    description: '使用本机 ChatGPT 登录，点击一次直接生成全部图片。',
    action: '先测试连通性',
  },
  {
    id: 'demo',
    title: '演示模式',
    description: '只验证流程和尺寸，不会生成新的 AI 图片。',
    action: '不消耗额度',
  },
]

export function sourceUsesHandoff(source) {
  return false
}

export function canSelectSource(source, agentStatus) {
  if (source === 'codex') return Boolean(agentStatus?.tested && agentStatus?.connected && agentStatus?.imageGeneration)
  return source === 'openai' || source === 'demo'
}

export function getRequiredSetup(settings = {}, agentStatus = null) {
  const requestedSource = settings.source || (settings.mode === 'demo' ? 'demo' : 'openai')
  const source = canSelectSource(requestedSource, agentStatus) || requestedSource === 'codex'
    ? requestedSource
    : 'openai'
  if (source === 'openai' && !settings.configured) return 'openai'
  if (source === 'codex' && !canSelectSource('codex', agentStatus)) return 'codex'
  return null
}

export function getSourcePresentation(settings = {}, agentStatus = null) {
  const requestedSource = settings.source || (settings.mode === 'demo' ? 'demo' : 'openai')
  const source = ['openai', 'codex', 'demo'].includes(requestedSource) ? requestedSource : 'openai'
  if (source === 'codex') {
    return {
      badge: agentStatus?.connected ? 'Codex Agent · 已连接' : 'Codex Agent · 待测试',
      resultLabel: 'Codex Agent 生成',
      generateLabel: '一键生成',
    }
  }
  if (source === 'demo') {
    return {
      badge: '演示模式',
      resultLabel: '演示结果',
      generateLabel: '运行演示任务',
    }
  }
  return {
    badge: settings.configured ? `${settings.imageModel || 'OpenAI'} · 已配置` : 'OpenAI · 待配置',
    resultLabel: 'OpenAI API 生成',
    generateLabel: '同时生成',
  }
}
