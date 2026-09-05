import {
  IMAGE_TYPES,
  OUTPUT_RATIOS,
  addTask,
  duplicateTask,
  getImageType,
  getOutputRatio,
  getTotalImageCount,
  normalizeStoredTasks,
  patchTask,
  removeTask,
} from './task-model.js'
import { ApiGatewayClient } from './api-client.js'
import { beginTaskGeneration, mergeTaskGenerationState } from './frontend-state.js'
import { canSelectSource, getRequiredSetup, getSourcePresentation } from './ai-source.js'

const TASK_STORAGE_KEY = 'commerce-image-workspace-v2'
const ASSET_STORAGE_KEY = 'commerce-image-selected-asset-v1'
const DEFAULT_PRODUCT_SOURCE = './assets/舒缓精华产品图.png'
const client = new ApiGatewayClient({ baseUrl: '' })

function readStorage(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

let tasks = normalizeStoredTasks(readStorage(TASK_STORAGE_KEY))
let assets = []
let historyRecords = []
let apiSettings = { mode: 'api', source: 'openai', baseUrl: 'https://api.openai.com/v1', imageModel: 'gpt-image-2', quality: 'medium', configured: false }
let settingsDraft = { ...apiSettings }
let agentStatus = { installed: false, authenticated: false, reachable: false, imageGeneration: false, connected: false, tested: false, version: '', workflow: 'direct', message: '尚未检测' }
let selectedAssetId = readStorage(ASSET_STORAGE_KEY)
let generatedResults = []
let generationFailures = []
let activeTaskId = tasks[0].id
let activeResult = 'all'
let activeView = 'workspace'
let isGenerating = false
let pendingHandoff = null
let pendingResultFiles = []
let pendingGenerationTaskIds = []
let activeHistoryRecordId = null
let toastTimer = null

const $ = (selector) => document.querySelector(selector)
const currentTask = () => tasks.find((task) => task.id === activeTaskId) ?? tasks[0]
const selectedAsset = () => assets.find((asset) => asset.id === selectedAssetId) ?? assets[0] ?? null

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function showToast(message, duration = 2600) {
  const toast = $('#toast')
  toast.textContent = message
  toast.classList.add('is-visible')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), duration)
}

function saveTasks() {
  try {
    const storedTasks = tasks.map((task) => ({ ...task, status: 'ready', progress: 0 }))
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(storedTasks))
    $('#saveStateText').textContent = '已保存'
    window.setTimeout(() => { $('#saveStateText').textContent = '自动保存' }, 900)
  } catch {
    showToast('浏览器没有保存任务参数，本次修改只在当前页面保留')
  }
}

function saveSelectedAsset() {
  try {
    if (selectedAssetId) localStorage.setItem(ASSET_STORAGE_KEY, selectedAssetId)
    else localStorage.removeItem(ASSET_STORAGE_KEY)
  } catch {
    // The selected asset still remains active in the current page.
  }
}

function navigateTo(viewName) {
  activeView = viewName
  document.querySelectorAll('[data-view-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== activeView
  })
  document.querySelectorAll('.main-nav [data-view-target]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.viewTarget === activeView)
  })
  if (activeView === 'library') renderLibrary()
  if (activeView === 'history') renderHistory()
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return ''
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function sourceLabel(source, model = '') {
  if (source === 'codex') return 'Codex Agent'
  if (source === 'desktop') return '已停用来源'
  if (source === 'demo') return '演示'
  return model || 'OpenAI API'
}

function renderSource() {
  const asset = selectedAsset()
  $('#sourceImage').src = asset?.url || DEFAULT_PRODUCT_SOURCE
  $('#sourceImage').alt = asset ? `${asset.name}商品素材` : '商品素材占位图'
  $('#sourceTitle').textContent = asset?.name || '请先导入商品素材'
  $('#sourceMeta').textContent = asset
    ? `${asset.width} × ${asset.height}px · ${formatBytes(asset.size)}`
    : '支持 JPG、PNG 和 WebP'
}

function renderLibrary() {
  $('#libraryCount').textContent = `${assets.length} 个素材`
  const cards = assets.map((asset) => `
    <article class="library-card ${asset.id === selectedAssetId ? 'is-selected' : ''}">
      <div class="library-preview"><img src="${asset.url}" alt="${escapeHtml(asset.name)}素材" /></div>
      <div class="library-card-body">
        <div><strong>${escapeHtml(asset.name)}</strong><span>${asset.width} × ${asset.height}px · ${formatBytes(asset.size)}</span></div>
        <div class="library-card-actions">
          <button data-use-asset="${asset.id}">${asset.id === selectedAssetId ? '正在使用' : '在工作台使用'}</button>
          <button class="delete-asset" data-delete-asset="${asset.id}" aria-label="删除 ${escapeHtml(asset.name)}">删除</button>
        </div>
      </div>
    </article>
  `).join('')
  $('#assetLibraryGrid').innerHTML = `${cards}
    <button class="library-add-card" data-import-asset>
      <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><strong>导入新素材</strong><span>支持 JPG、PNG 和 WebP，最大 20 MB</span>
    </button>
  `

  $('#assetLibraryGrid').querySelector('[data-import-asset]')?.addEventListener('click', () => $('#fileInput').click())
  $('#assetLibraryGrid').querySelectorAll('[data-use-asset]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedAssetId = button.dataset.useAsset
      saveSelectedAsset()
      generatedResults = []
      generationFailures = []
      render()
      navigateTo('workspace')
      showToast('已选择该商品素材')
    })
  })
  $('#assetLibraryGrid').querySelectorAll('[data-delete-asset]').forEach((button) => {
    button.addEventListener('click', async () => {
      const asset = assets.find((item) => item.id === button.dataset.deleteAsset)
      if (!asset || !window.confirm(`确定删除素材“${asset.name}”吗？`)) return
      try {
        await client.deleteAsset(asset.id)
        assets = assets.filter((item) => item.id !== asset.id)
        if (selectedAssetId === asset.id) selectedAssetId = assets[0]?.id || null
        saveSelectedAsset()
        render()
        renderLibrary()
        showToast('素材已删除')
      } catch (error) {
        showToast(error.message)
      }
    })
  })
}

function restoreHistoryRecord(record) {
  if (!record) return
  tasks = mergeTaskGenerationState(
    normalizeStoredTasks(record.tasks),
    record.results || [],
    record.failures || [],
  )
  selectedAssetId = assets.some((asset) => asset.id === record.assetId) ? record.assetId : selectedAssetId
  generatedResults = record.results || []
  generationFailures = record.failures || []
  activeTaskId = tasks[0].id
  activeResult = 'all'
  saveTasks()
  saveSelectedAsset()
  render()
  navigateTo('workspace')
  showToast('已恢复该批次的任务和生成结果')
}

function closeHistoryDetail() {
  setDialogOpen('#historyDetailDialog', '#historyDetailBackdrop', false)
  activeHistoryRecordId = null
}

function openHistoryDetail(recordId) {
  const record = historyRecords.find((item) => item.id === recordId)
  if (!record) return
  activeHistoryRecordId = record.id
  const results = record.results || []
  const failures = record.failures || []
  $('#historyDetailTitle').textContent = `${formatDate(record.createdAt)} 的生成批次`
  $('#historyDetailSubtitle').textContent = `${record.assetName || '商品素材'} · ${sourceLabel(record.source || (record.mode === 'api' ? 'openai' : 'demo'), record.model)}`
  $('#historyDetailStatus').textContent = `${record.taskCount || record.tasks?.length || 0} 个任务 · ${results.length}/${record.imageCount || results.length} 张成功`
  const imageSection = results.length
    ? `<section class="history-detail-section"><h3>生成图片</h3><div class="history-detail-images">${results.map((result) => `<a class="history-detail-image" href="${result.imageUrl}" download="${escapeHtml(result.filename || '生成图片.png')}"><img src="${result.imageUrl}" alt="生成结果" /><span>${result.width} × ${result.height}px · 点击下载</span></a>`).join('')}</div></section>`
    : ''
  const taskSection = `<section class="history-detail-section"><h3>任务参数</h3><div class="history-detail-tasks">${(record.tasks || []).map((task) => `<article class="history-detail-task"><strong>${escapeHtml(getImageType(task.type).label)}</strong><span>${escapeHtml(task.ratio)} · ${task.width} × ${task.height}px · ${task.quantity} 张</span><p>${escapeHtml(task.prompt || '未填写额外提示词')}</p></article>`).join('')}</div></section>`
  const failureSection = failures.length
    ? `<section class="history-detail-section"><h3>失败项</h3><div class="history-detail-tasks">${failures.map((failure) => `<article class="history-detail-task history-detail-failure"><strong>任务 ${escapeHtml(failure.taskId)}</strong><span>第 ${Number(failure.index) + 1} 张</span><p>${escapeHtml(failure.message || '生成失败')}</p></article>`).join('')}</div></section>`
    : ''
  $('#historyDetailBody').innerHTML = `<div class="history-detail-meta"><span>${escapeHtml(record.model || '未记录模型')}</span><span>${escapeHtml(record.quality || '默认质量')}</span><span>${escapeHtml(record.status || '已完成')}</span></div>${imageSection}${taskSection}${failureSection}`
  setDialogOpen('#historyDetailDialog', '#historyDetailBackdrop', true)
  $('#closeHistoryDetailButton').focus()
}

function renderHistory() {
  const imageTotal = historyRecords.reduce((sum, record) => sum + (record.results?.length || 0), 0)
  $('#historyBatchCount').textContent = historyRecords.length
  $('#historyImageCount').textContent = imageTotal
  $('#historyMode').textContent = historyRecords[0]
    ? sourceLabel(historyRecords[0].source || (historyRecords[0].mode === 'api' ? 'openai' : 'demo'), historyRecords[0].model)
    : '—'
  $('#emptyHistory').hidden = historyRecords.length > 0
  $('#clearHistoryButton').disabled = historyRecords.length === 0
  $('#historyList').innerHTML = historyRecords.map((record) => `
    <article class="history-row" data-open-history="${record.id}" role="button" tabindex="0" aria-label="查看 ${formatDate(record.createdAt)} 的生成批次详情">
      <span class="history-icon"><svg viewBox="0 0 24 24"><path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5-6.5-2L10 9l2-6.5Z"/></svg></span>
      <div class="history-copy"><strong>${formatDate(record.createdAt)} 的生成批次</strong><span>${(record.tasks || []).map((task) => `${getImageType(task.type).shortLabel} ${task.ratio}`).join(' · ')}</span></div>
      <div class="history-thumbs">${(record.results || []).slice(0, 3).map((result) => `<img src="${result.imageUrl}" alt="生成结果" />`).join('')}</div>
      <div class="history-tags"><span>${record.taskCount} 个任务</span><span>${record.results?.length || 0}/${record.imageCount} 张</span><span>${escapeHtml(sourceLabel(record.source || (record.mode === 'api' ? 'openai' : 'demo'), record.model))}</span></div>
      <div class="history-actions"><button data-history-id="${record.id}">再次使用</button><button class="delete-history" data-delete-history="${record.id}">删除</button></div>
    </article>
  `).join('')

  $('#historyList').querySelectorAll('[data-history-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const record = historyRecords.find((item) => item.id === button.dataset.historyId)
      restoreHistoryRecord(record)
    })
  })
  $('#historyList').querySelectorAll('[data-open-history]').forEach((row) => {
    const open = (event) => {
      if (event.target.closest('button, a')) return
      openHistoryDetail(row.dataset.openHistory)
    }
    row.addEventListener('click', open)
    row.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return
      event.preventDefault()
      open(event)
    })
  })
  $('#historyList').querySelectorAll('[data-delete-history]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await client.deleteHistory(button.dataset.deleteHistory)
        historyRecords = historyRecords.filter((record) => record.id !== button.dataset.deleteHistory)
        renderHistory()
        showToast('生成记录已删除')
      } catch (error) {
        showToast(error.message)
      }
    })
  })
}

function renderApiSettings() {
  const draftSource = settingsDraft.source || (settingsDraft.mode === 'demo' ? 'demo' : 'openai')
  settingsDraft.source = draftSource
  $('#baseUrlInput').value = settingsDraft.baseUrl || 'https://api.openai.com/v1'
  $('#apiKeyInput').value = ''
  $('#apiKeyInput').placeholder = settingsDraft.configured ? '已保存，留空不会修改' : 'sk-…'
  $('#imageModelInput').value = settingsDraft.imageModel || 'gpt-image-2'
  $('#qualityInput').value = settingsDraft.quality || 'medium'
  document.querySelectorAll('[data-ai-source]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.aiSource === draftSource)
    if (button.dataset.aiSource === 'codex') button.classList.toggle('is-connected', agentStatus.connected)
  })
  $('#agentSourceStatus').textContent = agentStatus.message || '未检测 · 需要先测试连通性'
  const isOpenAI = draftSource === 'openai'
  const isAssisted = draftSource === 'codex'
  $('#openAiSettingsSection').hidden = !isOpenAI
  $('#securityNote').hidden = !isOpenAI
  $('#assistedSourceSection').hidden = !isAssisted
  if (isAssisted) {
    $('#assistedSourceTitle').textContent = 'Codex Agent 自动生图'
    $('#assistedSourceDescription').textContent = agentStatus.connected
      ? agentStatus.imageGeneration
        ? `已连接 Codex ${agentStatus.version || ''}。点击一次后，工作台会在后台生成全部图片并自动回到画布。`
        : `已连接 Codex ${agentStatus.version || ''}，但未检测到图片能力。`
      : '需要先测试本机 Codex 的安装、登录和网络；通过后才可保存选择。'
  }

  const testButton = $('#testConnectionButton')
  testButton.hidden = draftSource === 'demo'
  testButton.textContent = draftSource === 'codex'
    ? agentStatus.connected ? '重新测试 Codex 连通性' : '测试 Codex 连通性'
    : '保存并测试图片 API'
  $('#saveSettingsButton').disabled = draftSource === 'codex' && !canSelectSource('codex', agentStatus)

  const badge = $('#modelModeBadge')
  badge.dataset.mode = apiSettings.source || apiSettings.mode
  badge.textContent = getSourcePresentation(apiSettings, agentStatus).badge
}

function openSettings(message = '') {
  settingsDraft = { ...apiSettings }
  renderApiSettings()
  $('#connectionStatus').className = 'connection-status'
  $('#connectionStatus').textContent = message || (apiSettings.source === 'codex'
    ? agentStatus.message
    : '尚未测试连接')
  $('#settingsBackdrop').hidden = false
  $('#settingsDrawer').classList.add('is-open')
  $('#settingsDrawer').setAttribute('aria-hidden', 'false')
  $('#closeSettingsButton').focus()
}

function closeSettings() {
  const preservePending = arguments[0]?.preservePending === true
  $('#settingsDrawer').classList.remove('is-open')
  $('#settingsDrawer').setAttribute('aria-hidden', 'true')
  window.setTimeout(() => { $('#settingsBackdrop').hidden = true }, 240)
  if (!preservePending) pendingGenerationTaskIds = []
}

function updateTask(id, patch, { save = true } = {}) {
  tasks = patchTask(tasks, id, patch)
  generatedResults = generatedResults.filter((result) => result.taskId !== id)
  generationFailures = generationFailures.filter((failure) => failure.taskId !== id)
  if (save) saveTasks()
  render()
}

function renderTaskList() {
  $('#taskList').innerHTML = tasks.map((task, index) => {
    const imageType = getImageType(task.type)
    const stateLabel = task.status === 'done'
      ? '已完成'
      : task.status === 'partial'
        ? '部分完成'
        : task.status === 'generating'
          ? '生成中'
          : task.status === 'error'
            ? '生成失败'
            : '待生成'
    return `
      <button class="task-row ${task.id === activeTaskId ? 'is-active' : ''}" data-task-id="${task.id}" data-type="${task.type}" data-status="${task.status}" aria-label="任务 ${index + 1} ${imageType.shortLabel} ${task.ratio}">
        <span class="task-index">${String(index + 1).padStart(2, '0')}</span>
        <span><span class="task-name">${imageType.shortLabel}</span><span class="task-detail">${task.ratio} · ${task.width} × ${task.height}px · ${task.quantity} 张</span></span>
        <span class="task-status"><i></i>${stateLabel}</span>
      </button>
    `
  }).join('')
  $('#taskList').querySelectorAll('[data-task-id]').forEach((button) => {
    button.addEventListener('click', () => {
      activeTaskId = button.dataset.taskId
      render()
    })
  })
}

function renderEditor() {
  const task = currentTask()
  const imageType = getImageType(task.type)
  const outputRatio = getOutputRatio(task.ratio)
  $('#editorTitle').textContent = `${imageType.shortLabel}设置`
  $('#editorSubtitle').textContent = `${outputRatio.use}场景 · ${task.width} × ${task.height}px`
  $('#pixelHint').textContent = `${task.width} × ${task.height}px`
  $('#promptInput').value = task.prompt
  $('#promptCount').textContent = `${task.prompt.length} / 300`
  $('#quantityValue').textContent = task.quantity
  $('#typeChoices').innerHTML = IMAGE_TYPES.map((type) => `<button class="${type.id === task.type ? 'is-active' : ''}" data-type-id="${type.id}">${type.label}</button>`).join('')
  $('#ratioChoices').innerHTML = OUTPUT_RATIOS.map((ratio) => `
    <button class="ratio-button ${ratio.id === task.ratio ? 'is-active' : ''}" data-ratio-id="${ratio.id}" aria-label="${ratio.id} ${ratio.use} ${ratio.width} × ${ratio.height} 像素"><strong>${ratio.label}</strong><small>${ratio.use}</small></button>
  `).join('')
  $('#typeChoices').querySelectorAll('[data-type-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextType = getImageType(button.dataset.typeId)
      updateTask(task.id, { type: nextType.id, prompt: nextType.prompt })
    })
  })
  $('#ratioChoices').querySelectorAll('[data-ratio-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextRatio = getOutputRatio(button.dataset.ratioId)
      updateTask(task.id, { ratio: nextRatio.id, width: nextRatio.width, height: nextRatio.height })
    })
  })
}

function renderResultTabs() {
  $('#resultTabs').innerHTML = `
    <button class="result-tab ${activeResult === 'all' ? 'is-active' : ''}" data-result-id="all">全部结果 <span>${getTotalImageCount(tasks)}</span></button>
    ${tasks.map((task, index) => `<button class="result-tab ${activeResult === task.id ? 'is-active' : ''}" data-result-id="${task.id}">任务 ${index + 1} · ${getImageType(task.type).shortLabel} <span>${task.ratio}</span></button>`).join('')}
  `
  $('#resultTabs').querySelectorAll('[data-result-id]').forEach((button) => {
    button.addEventListener('click', () => {
      activeResult = button.dataset.resultId
      renderResults()
    })
  })
}

function renderArtboard(task) {
  const source = selectedAsset()?.url || DEFAULT_PRODUCT_SOURCE
  const sharedContent = `
    <img src="${source}" alt="商品创意预览" />
    <div class="progress-card"><div class="progress-copy"><span>正在调用图片模型</span><span>${task.progress || 20}%</span></div><div class="progress-track"><i style="width:${task.progress || 20}%"></i></div></div>
  `
  const ratioStyle = `--output-ratio:${task.width}/${task.height}`
  if (task.type === 'feature') return `<div class="artboard feature-art" style="${ratioStyle}"><span class="art-kicker">PRODUCT BENEFITS</span><h3 class="art-title">卖点清楚，<br>商品保持真实</h3>${sharedContent}<span class="ingredient one">核心卖点</span><span class="ingredient two">清爽质感</span></div>`
  if (task.type === 'review') return `<div class="artboard review-art" style="${ratioStyle}"><span class="art-kicker">REAL EXPERIENCE</span><h3 class="art-title">体验自然，<br>表达更可信</h3>${sharedContent}<div class="review-card"><div class="review-stars">★★★★★</div><p>这里将在生成后展示真实模型输出。</p><div class="review-user">真实结果预览</div></div></div>`
  return `<div class="artboard compare-art" style="${ratioStyle}"><span class="art-kicker">BEFORE / AFTER</span><h3 class="art-title">一个商品，<br>两种状态表达</h3>${sharedContent}<span class="compare-label before">使用前</span><span class="compare-label after">使用后</span></div>`
}

function renderAssetCard(task, index) {
  const result = generatedResults.find((item) => item.taskId === task.id && item.index === index)
  const failure = generationFailures.find((item) => item.taskId === task.id && item.index === index)
  const stateLabel = result ? '已生成' : failure ? '生成失败' : task.status === 'generating' ? '生成中' : '待生成'
  const ratioStyle = `--output-ratio:${task.width}/${task.height}`
  const resultSource = result?.source || (result?.mode === 'api' ? 'openai' : result?.mode || 'demo')
  const body = result
    ? `<div class="generated-frame" style="${ratioStyle}"><img src="${result.imageUrl}" alt="${getImageType(task.type).label}生成结果" /><span class="generated-mode">${getSourcePresentation({ source: resultSource }).resultLabel}</span></div>`
    : failure
      ? `<div class="error-card"><strong>${escapeHtml(failure.message)}</strong><div>可以保留其他成功图片，只重试这一任务。</div><button data-regenerate-id="${task.id}">重新尝试</button></div>`
      : renderArtboard(task)
  const download = result
    ? `<a class="download" href="${result.imageUrl}" download="${getImageType(task.type).shortLabel}-${task.width}x${task.height}-${index + 1}.png" aria-label="下载该图片"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 20h14"/></svg></a>`
    : `<button class="download" disabled aria-label="尚无可下载图片"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 20h14"/></svg></button>`
  return `
    <article class="asset-card" data-status="${failure ? 'error' : task.status}">
      <div class="asset-header"><span>${getImageType(task.type).label} · ${String(index + 1).padStart(2, '0')}</span><span class="asset-state"><i></i>${stateLabel}</span></div>
      <div class="preview-stage">${body}</div>
      <div class="asset-actions"><button class="regenerate" data-regenerate-id="${task.id}">单独生成</button>${download}</div>
    </article>
  `
}

function renderResults() {
  renderResultTabs()
  const selectedTasks = activeResult === 'all' ? tasks : tasks.filter((task) => task.id === activeResult)
  const firstTask = selectedTasks[0] ?? tasks[0]
  const isAll = activeResult === 'all'
  const cards = selectedTasks.flatMap((task) => Array.from({ length: task.quantity }, (_, index) => renderAssetCard(task, index)))
  $('#gallery').innerHTML = cards.join('')
  $('#gallery').className = `gallery gallery-count-${Math.min(cards.length, 3)}`
  $('#galleryTitle').textContent = isAll ? '全部任务结果' : getImageType(firstTask.type).label
  $('#galleryDescription').textContent = isAll ? '不同用途、尺寸和数量统一比较；生成后可逐张下载。' : firstTask.prompt
  $('#gallerySignal').style.background = isAll ? 'linear-gradient(#ed6c61 0 33%, #1e8e68 33% 66%, #c58232 66%)' : getImageType(firstTask.type).color
  $('#ratioMeta').textContent = isAll ? `${new Set(tasks.map((task) => task.ratio)).size} 种尺寸` : firstTask.ratio
  $('#pixelMeta').textContent = isAll ? '参数独立' : `${firstTask.width} × ${firstTask.height}px`
  $('#countMeta').textContent = `${isAll ? getTotalImageCount(tasks) : firstTask.quantity} 张`
  $('#gallery').querySelectorAll('[data-regenerate-id]').forEach((button) => {
    button.addEventListener('click', () => generateTasks([tasks.find((task) => task.id === button.dataset.regenerateId)].filter(Boolean)))
  })
}

function renderSummary() {
  const totalImages = getTotalImageCount(tasks)
  $('#taskSummary').textContent = `${tasks.length} 个任务 · ${totalImages} 张图`
  $('#creditCount').textContent = totalImages
  $('#imageCount').textContent = `${totalImages} 张`
  $('#generateLabel').textContent = isGenerating
    ? apiSettings.source === 'codex'
      ? 'Codex 正在生成'
      : '正在调用图片模型'
    : apiSettings.source === 'demo'
      ? '生成演示图'
      : '一键生成'
  $('#queueText').textContent = isGenerating
    ? apiSettings.source === 'codex'
      ? `Codex 正在生成 ${totalImages} 张图，通常需要几分钟，请保持页面打开`
      : `${tasks.length} 个任务正在处理，请保持页面打开`
    : `${tasks.length} 个任务已就绪 · 点击一次生成 ${totalImages} 张图片`
  $('#generateAllButton').disabled = isGenerating || tasks.length === 0
}

function render() {
  renderSource()
  renderTaskList()
  renderEditor()
  renderSummary()
  renderResults()
  renderApiSettings()
}

function setDialogOpen(dialogId, backdropId, open) {
  const dialog = $(dialogId)
  const backdrop = $(backdropId)
  dialog.hidden = !open
  backdrop.hidden = !open
  document.body.classList.toggle('is-modal-open', open)
}

function closeHandoff() {
  setDialogOpen('#handoffDialog', '#handoffBackdrop', false)
  pendingHandoff = null
  pendingResultFiles = []
}

function renderImportSlots() {
  if (!pendingHandoff) return
  $('#importSlots').innerHTML = pendingHandoff.entries.map((entry, index) => {
    const file = pendingResultFiles[index]
    return `<div class="import-slot ${file ? 'is-filled' : ''}"><b>${entry.order}</b><div><strong>${file ? escapeHtml(file.name) : `任务 ${entry.taskId} · 第 ${entry.index + 1} 张`}</strong><span>${entry.width} × ${entry.height}px${file ? ' · 已选择' : ' · 等待图片'}</span></div></div>`
  }).join('')
  const complete = pendingResultFiles.length === pendingHandoff.imageCount
  $('#handoffFooterStatus').textContent = complete
    ? `已选择 ${pendingResultFiles.length} 张，导入后会自动统一尺寸`
    : `已选择 ${pendingResultFiles.length}/${pendingHandoff.imageCount} 张`
  $('#importResultsButton').disabled = !complete
}

async function startHandoff(requestedTasks) {
  const source = apiSettings.source
  if (source === 'codex' && !agentStatus.connected) {
    openSettings('请先测试 Codex 桌面 Agent 连通性，通过后再选择。')
    return
  }
  isGenerating = true
  render()
  try {
    pendingHandoff = await client.createHandoff({ source, assetId: selectedAssetId, tasks: requestedTasks })
    pendingResultFiles = []
    $('#handoffTitle').textContent = source === 'codex' ? 'Codex 桌面 Agent 任务' : '桌面 AI 协作任务'
    $('#handoffSourceName').textContent = 'Codex 桌面 Agent'
    $('#handoffCount').textContent = `${pendingHandoff.taskCount} 个任务 · 需要 ${pendingHandoff.imageCount} 张结果`
    $('#handoffPromptText').value = pendingHandoff.promptText
    $('#handoffImportHint').textContent = `选择 ${pendingHandoff.imageCount} 张图片，顺序要与任务包一致`
    $('#downloadSourceAsset').href = pendingHandoff.asset.url
    $('#downloadSourceAsset').download = pendingHandoff.asset.name
    renderImportSlots()
    setDialogOpen('#handoffDialog', '#handoffBackdrop', true)
    $('#closeHandoffButton').focus()
  } catch (error) {
    showToast(error.message, 4200)
  } finally {
    isGenerating = false
    render()
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const field = $('#handoffPromptText')
  field.focus()
  field.select()
  if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请手动选择提示词')
}

function downloadTextFile(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function importHandoffResults() {
  if (!pendingHandoff || pendingResultFiles.length !== pendingHandoff.imageCount) return
  $('#importResultsButton').disabled = true
  $('#handoffFooterStatus').textContent = '正在校验图片并统一到任务尺寸…'
  try {
    const files = await Promise.all(pendingResultFiles.map(async (file) => ({
      name: file.name,
      dataUrl: await fileToDataUrl(file),
    })))
    const batch = await client.importResults({
      source: pendingHandoff.source,
      assetId: pendingHandoff.asset.id,
      tasks: pendingHandoff.tasks,
      files,
    })
    const requestedIds = new Set(pendingHandoff.tasks.map((task) => task.id))
    generatedResults = [
      ...generatedResults.filter((result) => !requestedIds.has(result.taskId)),
      ...(batch.results || []),
    ]
    generationFailures = generationFailures.filter((failure) => !requestedIds.has(failure.taskId))
    tasks = mergeTaskGenerationState(tasks, generatedResults, generationFailures)
    historyRecords = [batch, ...historyRecords.filter((record) => record.id !== batch.id)]
    closeHandoff()
    saveTasks()
    render()
    showToast(`已导入 ${batch.results.length} 张图片，并按任务尺寸保存`)
  } catch (error) {
    $('#handoffFooterStatus').textContent = `导入失败：${error.message}`
    $('#importResultsButton').disabled = false
  }
}

async function generateTasks(requestedTasks) {
  if (isGenerating || requestedTasks.length === 0) return
  if (!selectedAsset()) {
    navigateTo('library')
    return showToast('请先导入并选择一张商品素材')
  }
  const requiredSetup = getRequiredSetup(apiSettings, agentStatus)
  if (requiredSetup) {
    pendingGenerationTaskIds = requestedTasks.map((task) => task.id)
    openSettings(requiredSetup === 'codex'
      ? '先测试 Codex 图片能力并保存，工作台会自动继续这次生成。'
      : '填写 API Key 并保存后，工作台会自动继续这次生成。')
    return
  }
  const requestedIds = new Set(requestedTasks.map((task) => task.id))
  isGenerating = true
  const generationState = beginTaskGeneration({
    tasks,
    results: generatedResults,
    failures: generationFailures,
    taskIds: [...requestedIds],
  })
  tasks = generationState.tasks
  generatedResults = generationState.results
  generationFailures = generationState.failures
  $('#canvasTitle').textContent = '正在生成真实图片'
  render()

  try {
    const batch = await client.generateBatch({ assetId: selectedAssetId, tasks: requestedTasks })
    generatedResults = [
      ...generatedResults.filter((result) => !requestedIds.has(result.taskId)),
      ...(batch.results || []),
    ]
    generationFailures = [
      ...generationFailures.filter((failure) => !requestedIds.has(failure.taskId)),
      ...(batch.failures || []),
    ]
    tasks = mergeTaskGenerationState(tasks, generatedResults, generationFailures)
    historyRecords = [batch, ...historyRecords.filter((record) => record.id !== batch.id)]
    const successCount = batch.results?.length || 0
    const failureCount = batch.failures?.length || 0
    showToast(failureCount ? `生成完成：成功 ${successCount} 张，失败 ${failureCount} 张` : `已生成 ${successCount} 张图片`)
  } catch (error) {
    tasks = tasks.map((task) => requestedIds.has(task.id) ? { ...task, status: 'error', progress: 0 } : task)
    if (error.code === 'MODEL_NOT_CONFIGURED' || error.code === 'AGENT_TEST_REQUIRED') {
      pendingGenerationTaskIds = requestedTasks.map((task) => task.id)
      openSettings(`${error.message}，保存后会自动继续。`)
    }
    else showToast(error.message, 4200)
  } finally {
    isGenerating = false
    $('#canvasTitle').textContent = '创意画布'
    saveTasks()
    render()
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(reader.result), { once: true })
    reader.addEventListener('error', () => reject(new Error('图片读取失败，请重新选择')), { once: true })
    reader.readAsDataURL(file)
  })
}

async function uploadSelectedFile(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片')
  if (file.size > 20 * 1024 * 1024) throw new Error('单张素材不能超过 20 MB')
  const asset = await client.uploadAsset({ name: file.name, dataUrl: await fileToDataUrl(file) })
  assets = [asset, ...assets.filter((item) => item.id !== asset.id)]
  selectedAssetId = asset.id
  saveSelectedAsset()
  generatedResults = []
  generationFailures = []
  render()
  if (activeView === 'library') renderLibrary()
  showToast('素材已保存并设为当前商品')
}

$('#promptInput').addEventListener('input', (event) => updateTask(activeTaskId, { prompt: event.target.value.slice(0, 300) }))
$('#resetPromptButton').addEventListener('click', () => updateTask(activeTaskId, { prompt: getImageType(currentTask().type).prompt }))
$('#decreaseButton').addEventListener('click', () => updateTask(activeTaskId, { quantity: currentTask().quantity - 1 }))
$('#increaseButton').addEventListener('click', () => updateTask(activeTaskId, { quantity: currentTask().quantity + 1 }))
$('#addTaskButton').addEventListener('click', () => {
  const nextTasks = addTask(tasks)
  if (nextTasks.length === tasks.length) return showToast('最多可以创建 5 个任务')
  tasks = nextTasks
  activeTaskId = tasks.at(-1).id
  activeResult = activeTaskId
  saveTasks()
  render()
})
$('#generateAllButton').addEventListener('click', () => generateTasks(tasks))
$('#replaceImageButton').addEventListener('click', () => $('#fileInput').click())
$('#fileInput').addEventListener('change', async (event) => {
  const [file] = event.target.files
  event.target.value = ''
  if (!file) return
  try {
    await uploadSelectedFile(file)
  } catch (error) {
    showToast(error.message, 4200)
  }
})
$('#exportAllButton').addEventListener('click', () => {
  if (generatedResults.length === 0) return showToast('请先生成图片')
  generatedResults.forEach((result, index) => {
    window.setTimeout(() => {
      const anchor = document.createElement('a')
      anchor.href = result.imageUrl
      anchor.download = `商品图-${result.width}x${result.height}-${index + 1}.png`
      anchor.click()
    }, index * 160)
  })
})

function closeTaskMenu() {
  $('#taskMenu').hidden = true
  $('#taskMenuButton').setAttribute('aria-expanded', 'false')
}

$('#taskMenuButton').addEventListener('click', (event) => {
  event.stopPropagation()
  const nextOpen = $('#taskMenu').hidden
  $('#taskMenu').hidden = !nextOpen
  $('#taskMenuButton').setAttribute('aria-expanded', String(nextOpen))
})
$('#duplicateTaskButton').addEventListener('click', () => {
  const nextTasks = duplicateTask(tasks, activeTaskId)
  if (nextTasks.length === tasks.length) return showToast('最多可以创建 5 个任务')
  tasks = nextTasks
  activeTaskId = tasks.at(-1).id
  activeResult = activeTaskId
  closeTaskMenu()
  saveTasks()
  render()
})
$('#deleteTaskButton').addEventListener('click', () => {
  const nextTasks = removeTask(tasks, activeTaskId)
  if (nextTasks.length === tasks.length) return showToast('至少保留 1 个任务')
  generatedResults = generatedResults.filter((result) => result.taskId !== activeTaskId)
  generationFailures = generationFailures.filter((failure) => failure.taskId !== activeTaskId)
  tasks = nextTasks
  activeTaskId = tasks[0].id
  activeResult = 'all'
  closeTaskMenu()
  saveTasks()
  render()
})
document.addEventListener('click', (event) => {
  if (!$('#taskMenu').hidden && !$('#taskMenu').contains(event.target)) closeTaskMenu()
})

$('#helpButton').addEventListener('click', () => {
  setDialogOpen('#helpDialog', '#helpBackdrop', true)
  $('#closeHelpButton').focus()
})
const closeHelp = () => setDialogOpen('#helpDialog', '#helpBackdrop', false)
$('#closeHelpButton').addEventListener('click', closeHelp)
$('#helpBackdrop').addEventListener('click', closeHelp)

$('#closeHistoryDetailButton').addEventListener('click', closeHistoryDetail)
$('#historyDetailBackdrop').addEventListener('click', closeHistoryDetail)
$('#reuseHistoryDetailButton').addEventListener('click', () => {
  const record = historyRecords.find((item) => item.id === activeHistoryRecordId)
  closeHistoryDetail()
  restoreHistoryRecord(record)
})

$('#closeHandoffButton').addEventListener('click', closeHandoff)
$('#cancelHandoffButton').addEventListener('click', closeHandoff)
$('#handoffBackdrop').addEventListener('click', closeHandoff)
$('#copyHandoffButton').addEventListener('click', async () => {
  try {
    await copyText(pendingHandoff?.promptText || '')
    showToast('任务提示词已复制')
  } catch (error) {
    showToast(error.message)
  }
})
$('#downloadHandoffButton').addEventListener('click', () => {
  if (!pendingHandoff) return
  downloadTextFile(`AI商品图任务包-${pendingHandoff.id.slice(0, 8)}.md`, pendingHandoff.promptText)
})
$('#chooseResultsButton').addEventListener('click', () => $('#resultFilesInput').click())
$('#resultFilesInput').addEventListener('change', (event) => {
  if (!pendingHandoff) return
  const selected = [...event.target.files]
  event.target.value = ''
  const invalid = selected.find((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024)
  if (invalid) return showToast('结果只支持 20 MB 以内的 JPG、PNG 或 WebP 图片')
  if (selected.length !== pendingHandoff.imageCount) {
    pendingResultFiles = selected.slice(0, pendingHandoff.imageCount)
    renderImportSlots()
    return showToast(`请一次选择 ${pendingHandoff.imageCount} 张图片，并按任务编号排序`, 4200)
  }
  pendingResultFiles = selected
  renderImportSlots()
})
$('#importResultsButton').addEventListener('click', importHandoffResults)

document.querySelectorAll('[data-view-target]').forEach((button) => {
  button.addEventListener('click', () => navigateTo(button.dataset.viewTarget))
})
document.querySelector('.brand').addEventListener('click', (event) => {
  event.preventDefault()
  navigateTo('workspace')
})
$('#libraryImportButton').addEventListener('click', () => $('#fileInput').click())
$('#clearHistoryButton').addEventListener('click', async () => {
  if (!window.confirm('确定清空全部生成记录吗？生成图片文件不会立即删除。')) return
  try {
    await client.clearHistory()
    historyRecords = []
    renderHistory()
    showToast('生成记录已清空')
  } catch (error) {
    showToast(error.message)
  }
})
$('#openSettingsButton').addEventListener('click', () => openSettings())
$('#closeSettingsButton').addEventListener('click', closeSettings)
$('#cancelSettingsButton').addEventListener('click', closeSettings)
$('#settingsBackdrop').addEventListener('click', closeSettings)
document.querySelectorAll('[data-ai-source]').forEach((button) => {
  button.addEventListener('click', () => {
    settingsDraft.source = button.dataset.aiSource
    settingsDraft.mode = settingsDraft.source === 'demo' ? 'demo' : 'api'
    $('#connectionStatus').className = 'connection-status'
    $('#connectionStatus').textContent = settingsDraft.source === 'codex' && !agentStatus.connected
      ? '请先点击“测试 Codex 连通性”，通过后可直接生图。'
      : settingsDraft.source === 'demo'
        ? '演示模式只验证交互，不会生成新的 AI 图片。'
        : '填写 Base URL、API Key 和模型后可测试生图连接。'
    renderApiSettings()
  })
})

function settingsPayload() {
  const payload = {
    mode: settingsDraft.source === 'demo' ? 'demo' : 'api',
    source: settingsDraft.source,
    baseUrl: $('#baseUrlInput').value.trim() || 'https://api.openai.com/v1',
    imageModel: $('#imageModelInput').value.trim() || 'gpt-image-2',
    quality: $('#qualityInput').value,
  }
  const apiKey = $('#apiKeyInput').value.trim()
  if (apiKey) payload.apiKey = apiKey
  return payload
}

$('#testConnectionButton').addEventListener('click', async () => {
  const status = $('#connectionStatus')
  status.className = 'connection-status'
  status.textContent = settingsDraft.source === 'codex' ? '正在检测 Codex 安装、登录和网络…' : '正在检查当前来源…'
  $('#testConnectionButton').disabled = true
  try {
    let result
    if (settingsDraft.source === 'codex') {
      agentStatus = await client.testDesktopAgent()
      result = agentStatus
      if (!canSelectSource('codex', agentStatus)) throw new Error(agentStatus.message)
    } else {
      apiSettings = await client.saveSettings(settingsPayload())
      settingsDraft = { ...apiSettings }
      result = await client.testSettings()
    }
    status.className = 'connection-status is-success'
    status.textContent = settingsDraft.source === 'codex'
      ? `${agentStatus.message}，保存后即可一键生成`
      : result.mode === 'demo' ? '演示模式可用。' : `连接成功：${result.model}`
    renderApiSettings()
  } catch (error) {
    status.className = 'connection-status is-error'
    status.textContent = `连接失败：${error.message}`
  } finally {
    $('#testConnectionButton').disabled = false
  }
})

$('#saveSettingsButton').addEventListener('click', async () => {
  $('#saveSettingsButton').disabled = true
  try {
    apiSettings = await client.saveSettings(settingsPayload())
    settingsDraft = { ...apiSettings }
    const resumeTasks = pendingGenerationTaskIds
      .map((id) => tasks.find((task) => task.id === id))
      .filter(Boolean)
    pendingGenerationTaskIds = []
    renderApiSettings()
    closeSettings({ preservePending: true })
    showToast(apiSettings.source === 'codex'
      ? resumeTasks.length ? 'Codex 已连接，正在继续生成' : '已选择 Codex 桌面 Agent'
      : apiSettings.source === 'demo' ? '已切换为演示模式' : '图片 API 设置已保存')
    if (resumeTasks.length) window.setTimeout(() => generateTasks(resumeTasks), 0)
  } catch (error) {
    $('#connectionStatus').className = 'connection-status is-error'
    $('#connectionStatus').textContent = error.message
  } finally {
    $('#saveSettingsButton').disabled = false
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (!$('#handoffDialog').hidden) closeHandoff()
  else if (!$('#historyDetailDialog').hidden) closeHistoryDetail()
  else if (!$('#helpDialog').hidden) closeHelp()
  else if ($('#settingsDrawer').classList.contains('is-open')) closeSettings()
  else closeTaskMenu()
})

async function bootstrap() {
  render()
  renderLibrary()
  renderHistory()
  navigateTo(activeView)
  try {
    const [settings, storedAssets, storedHistory, storedAgentStatus] = await Promise.all([
      client.getSettings(),
      client.listAssets(),
      client.listHistory(),
      client.getDesktopAgentStatus(),
    ])
    apiSettings = { ...settings, source: settings.source || (settings.mode === 'demo' ? 'demo' : 'openai') }
    settingsDraft = { ...apiSettings }
    agentStatus = storedAgentStatus
    assets = storedAssets
    historyRecords = storedHistory
    if (!assets.some((asset) => asset.id === selectedAssetId)) selectedAssetId = assets[0]?.id || null
    saveSelectedAsset()
    const latest = historyRecords[0]
    if (latest && latest.assetId === selectedAssetId) {
      generatedResults = latest.results || []
      generationFailures = latest.failures || []
      tasks = mergeTaskGenerationState(tasks, generatedResults, generationFailures)
    }
    render()
    renderLibrary()
    renderHistory()
    if (apiSettings.source === 'openai' && !apiSettings.configured) showToast('图片 API 尚未配置；也可以在“模型设置”选择 Codex', 5200)
  } catch (error) {
    $('#modelModeBadge').textContent = '本地服务异常'
    showToast(`无法连接本地服务：${error.message}`, 6000)
  }
}

bootstrap()
