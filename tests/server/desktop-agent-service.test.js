import test from 'node:test'
import assert from 'node:assert/strict'
import { createDesktopAgentService } from '../../server/desktop-agent-service.js'

function runnerFor({ login = 'Logged in using ChatGPT', websocket = 'ok', features = 'image_generation, apps' } = {}) {
  return async (_executable, args) => {
    if (args[0] === '--version') return { exitCode: 0, stdout: 'codex-cli 0.153.0', stderr: '' }
    if (args[0] === 'login') return { exitCode: login ? 0 : 1, stdout: login, stderr: '' }
    if (args[0] === 'doctor') {
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          checks: {
            'config.load': { status: 'ok', details: { 'enabled feature flags': features } },
            'network.websocket_reachability': { status: websocket },
            'desktop.app_server.handshake': { status: 'ok' },
          },
        }),
        stderr: '',
      }
    }
    throw new Error(`unexpected command: ${args.join(' ')}`)
  }
}

test('reports a redacted ready state after the Codex connection test passes', async () => {
  const service = createDesktopAgentService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    runCommand: runnerFor(),
  })
  const status = await service.testConnection()
  assert.deepEqual(status, {
    installed: true,
    authenticated: true,
    reachable: true,
    imageGeneration: true,
    connected: true,
    tested: true,
    version: '0.153.0',
    workflow: 'direct',
    message: 'Codex 桌面 Agent 已连接，可直接生成图片',
  })
  assert.doesNotMatch(JSON.stringify(status), /auth\.json|backend-api|access.token/i)
})

test('does not mark the Agent connected when authentication is missing', async () => {
  const service = createDesktopAgentService({ executable: 'codex', runCommand: runnerFor({ login: '' }) })
  const status = await service.testConnection()
  assert.equal(status.installed, true)
  assert.equal(status.authenticated, false)
  assert.equal(status.connected, false)
  assert.match(status.message, /登录/)
})

test('recognizes the desktop CLI login message when it is written to stderr', async () => {
  const runCommand = async (_executable, args) => {
    if (args[0] === '--version') return { exitCode: 0, stdout: 'codex-cli 0.153.0', stderr: '' }
    if (args[0] === 'login') return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT' }
    return runnerFor()(_executable, args)
  }
  const service = createDesktopAgentService({ executable: 'codex', runCommand })
  assert.equal((await service.testConnection()).authenticated, true)
})

test('does not mark the Agent connected when the network handshake fails', async () => {
  const service = createDesktopAgentService({ executable: 'codex', runCommand: runnerFor({ websocket: 'warning' }) })
  const status = await service.testConnection()
  assert.equal(status.reachable, false)
  assert.equal(status.connected, false)
  assert.match(status.message, /网络/)
})

test('returns an unavailable state when the Codex executable cannot run', async () => {
  const service = createDesktopAgentService({
    executable: 'codex',
    runCommand: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }) },
  })
  const status = await service.getStatus()
  assert.equal(status.installed, false)
  assert.equal(status.connected, false)
  assert.match(status.message, /未检测到/)
})
