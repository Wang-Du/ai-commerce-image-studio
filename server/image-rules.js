const MIN_PIXELS = 655_360
const MAX_PIXELS = 8_294_400
const MAX_EDGE = 3840

const TYPE_GUIDANCE = {
  compare: '制作清晰但可信的前后对比电商视觉，变化不过度，不暗示医疗功效。',
  feature: '制作以商品为视觉中心的卖点海报，用简洁标签表达核心卖点。',
  review: '制作自然可信的用户评价电商视觉，评价文字简短，避免虚构具体身份。',
}

function assertTargetSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸必须是正整数')
  }
  if (Math.max(width, height) > MAX_EDGE) {
    throw new Error('图片最长边不能超过 3840 像素')
  }
  if (Math.max(width, height) / Math.min(width, height) > 3) {
    throw new Error('图片长宽比不能超过 3:1')
  }
}

function roundToMultiple(value, method = Math.round) {
  return Math.max(16, method(value / 16) * 16)
}

export function toModelSize(width, height) {
  assertTargetSize(width, height)

  let modelWidth = roundToMultiple(width)
  let modelHeight = roundToMultiple(height)
  let pixels = modelWidth * modelHeight

  if (pixels < MIN_PIXELS) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    modelWidth = roundToMultiple(modelWidth * scale, Math.ceil)
    modelHeight = roundToMultiple(modelHeight * scale, Math.ceil)
  }

  pixels = modelWidth * modelHeight
  if (pixels > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / pixels)
    modelWidth = roundToMultiple(modelWidth * scale, Math.floor)
    modelHeight = roundToMultiple(modelHeight * scale, Math.floor)
  }

  return `${modelWidth}x${modelHeight}`
}

export function buildGenerationPrompt(task) {
  const guidance = TYPE_GUIDANCE[task.type] || TYPE_GUIDANCE.feature
  const userPrompt = String(task.prompt || '').trim()

  return [
    '根据提供的商品参考图制作一张可直接用于电商展示的中文商品图。',
    '必须保持商品包装、商标、文字和核心配色与参考图一致，不要改变瓶身结构，不要生成额外商品。',
    guidance,
    `目标画布为 ${task.width} × ${task.height} 像素，构图需要适配该比例并保留安全边距。`,
    userPrompt ? `本任务要求：${userPrompt}` : '',
    '画面干净、层级清楚、文字可读，不添加二维码、水印、价格或未经提供的品牌信息。',
  ].filter(Boolean).join('\n')
}
