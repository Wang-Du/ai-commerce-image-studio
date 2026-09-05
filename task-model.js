export const IMAGE_TYPES = [
  {
    id: 'compare',
    label: '前后对比',
    shortLabel: '对比图',
    color: '#ed6c61',
    prompt: '左右对比同一商品的使用场景：左侧呈现肌肤干燥紧绷，右侧呈现水润舒缓；产品外观保持真实，变化清晰但不过度。',
  },
  {
    id: 'feature',
    label: '产品卖点',
    shortLabel: '卖点图',
    color: '#1e8e68',
    prompt: '以产品为视觉中心，加入积雪草、神经酰胺等成分标签，突出舒缓修护、清爽不黏腻和敏感肌友好。',
  },
  {
    id: 'review',
    label: '用户评价',
    shortLabel: '评价图',
    color: '#c58232',
    prompt: '使用自然可信的生活化评价卡片，突出连续使用后的舒适肤感；保留商品主体，适合社媒种草内容。',
  },
]

export const OUTPUT_RATIOS = [
  { id: '1:1', label: '1:1', use: '主图', width: 1200, height: 1200 },
  { id: '3:4', label: '3:4', use: '详情', width: 900, height: 1200 },
  { id: '4:5', label: '4:5', use: '社媒', width: 1080, height: 1350 },
  { id: '9:16', label: '9:16', use: '竖版', width: 1080, height: 1920 },
  { id: 'custom', label: '自定', use: '更多', width: 1280, height: 720 },
]

const DEFAULT_TYPES = ['compare', 'feature', 'review']
const DEFAULT_RATIOS = ['1:1', '3:4', '4:5']

function createTask(id, imageTypeId, ratioId) {
  const imageType = IMAGE_TYPES.find((item) => item.id === imageTypeId)
  const outputRatio = OUTPUT_RATIOS.find((item) => item.id === ratioId)

  return {
    id,
    type: imageType.id,
    ratio: outputRatio.id,
    width: outputRatio.width,
    height: outputRatio.height,
    quantity: 1,
    prompt: imageType.prompt,
    status: 'ready',
    progress: 0,
  }
}

export function createDefaultTasks() {
  return DEFAULT_TYPES.map((imageType, index) =>
    createTask(`task-${index + 1}`, imageType, DEFAULT_RATIOS[index]),
  )
}

export function getImageType(id) {
  return IMAGE_TYPES.find((item) => item.id === id) ?? IMAGE_TYPES[0]
}

export function getOutputRatio(id) {
  return OUTPUT_RATIOS.find((item) => item.id === id) ?? OUTPUT_RATIOS[0]
}

export function getTotalImageCount(tasks) {
  return tasks.reduce((sum, task) => sum + task.quantity, 0)
}

export function patchTask(tasks, id, patch) {
  return tasks.map((task) => {
    if (task.id !== id) return task

    const quantity = patch.quantity === undefined
      ? task.quantity
      : Math.min(4, Math.max(1, Number(patch.quantity) || 1))

    return {
      ...task,
      ...patch,
      quantity,
      status: patch.status ?? 'ready',
      progress: patch.progress ?? 0,
    }
  })
}

export function addTask(tasks) {
  if (tasks.length >= 5) return tasks

  const index = tasks.length
  const nextNumber = Math.max(0, ...tasks.map((task) => Number(task.id.replace('task-', '')) || 0)) + 1
  return [
    ...tasks,
    createTask(
      `task-${nextNumber}`,
      DEFAULT_TYPES[index % DEFAULT_TYPES.length],
      DEFAULT_RATIOS[index % DEFAULT_RATIOS.length],
    ),
  ]
}

export function duplicateTask(tasks, id) {
  if (tasks.length >= 5) return tasks
  const source = tasks.find((task) => task.id === id)
  if (!source) return tasks
  const nextNumber = Math.max(0, ...tasks.map((task) => Number(task.id.replace('task-', '')) || 0)) + 1
  return [
    ...tasks,
    {
      ...source,
      id: `task-${nextNumber}`,
      status: 'ready',
      progress: 0,
    },
  ]
}

export function removeTask(tasks, id) {
  if (tasks.length <= 1) return tasks
  const next = tasks.filter((task) => task.id !== id)
  return next.length > 0 ? next : tasks
}

function isValidTask(task) {
  return Boolean(
    task
    && typeof task.id === 'string'
    && IMAGE_TYPES.some((item) => item.id === task.type)
    && OUTPUT_RATIOS.some((item) => item.id === task.ratio)
    && Number.isFinite(task.width)
    && Number.isFinite(task.height)
    && Number.isFinite(task.quantity),
  )
}

export function normalizeStoredTasks(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 5 || !parsed.every(isValidTask)) {
      return createDefaultTasks()
    }
    return parsed.map((task) => ({
      ...task,
      quantity: Math.min(4, Math.max(1, task.quantity)),
      status: 'ready',
      progress: 0,
    }))
  } catch {
    return createDefaultTasks()
  }
}
