import { execFile } from 'node:child_process'

const DEFAULT_EXECUTABLE = '/Applications/ChatGPT.app/Contents/Resources/codex'

function defaultRunCommand(executable, args) {
  return new Promise((resolve) => {
    execFile(executable, args, {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout = '', stderr = '') => {
      resolve({
        exitCode: Number.isInteger(error?.code) ? error.code : error ? 1 : 0,
        stdout,
        stderr,
        error,
      })
    })
  })
}

function unavailable(message = '未检测到 Codex 桌面 Agent') {
  return {
    installed: false,
    authenticated: false,
    reachable: false,
    imageGeneration: false,
    connected: false,
    tested: false,
    version: '',
    workflow: 'direct',
    message,
  }
}

function versionNumber(output) {
  return String(output || '').match(/\d+\.\d+\.\d+/)?.[0] || ''
}

export function createDesktopAgentService({
  executable = DEFAULT_EXECUTABLE,
  runCommand = defaultRunCommand,
} = {}) {
  let cachedStatus = null

  async function baseStatus() {
    let versionResult
    try {
      versionResult = await runCommand(executable, ['--version'])
    } catch {
      return unavailable()
    }
    if (versionResult?.error?.code === 'ENOENT' || versionResult?.exitCode !== 0) return unavailable()

    const loginResult = await runCommand(executable, ['login', 'status'])
    const authenticated = loginResult?.exitCode === 0 && /logged in/i.test(`${loginResult.stdout || ''}\n${loginResult.stderr || ''}`)
    return {
      installed: true,
      authenticated,
      reachable: false,
      imageGeneration: false,
      connected: false,
      tested: false,
      version: versionNumber(versionResult.stdout),
      workflow: 'direct',
      message: authenticated
        ? 'Codex 已登录，测试网络后即可选择'
        : 'Codex 已安装，但需要先在桌面端登录',
    }
  }

  return {
    async getStatus() {
      if (cachedStatus) return cachedStatus
      return baseStatus()
    },
    async testConnection() {
      const base = await baseStatus()
      if (!base.installed || !base.authenticated) {
        cachedStatus = { ...base, tested: true }
        return cachedStatus
      }

      const doctorResult = await runCommand(executable, ['doctor', '--json'])
      let report = null
      try {
        report = JSON.parse(doctorResult?.stdout || '{}')
      } catch {
        report = null
      }
      const checks = report?.checks || {}
      const reachable = checks['network.websocket_reachability']?.status === 'ok'
      const featureText = String(checks['config.load']?.details?.['enabled feature flags'] || '')
      const imageGeneration = /(?:^|[,\s])image_generation(?:[,\s]|$)/.test(featureText)
      const connected = reachable
      cachedStatus = {
        ...base,
        reachable,
        imageGeneration,
        connected,
        tested: true,
        message: connected
          ? imageGeneration
            ? 'Codex 桌面 Agent 已连接，可直接生成图片'
            : 'Codex 已连接，可生成提示词；当前未检测到图片工具'
          : 'Codex 已登录，但网络连通性测试未通过',
      }
      return cachedStatus
    },
    canSelect() {
      return Boolean(cachedStatus?.connected && cachedStatus?.imageGeneration)
    },
  }
}
