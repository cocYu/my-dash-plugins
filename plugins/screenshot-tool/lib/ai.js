// AI 能力封装：识图/OCR 走多模态 chat（图片部件），翻译走文本 chat，
// 图生图走 ai.generateImage 的 image2image 模式。供应商与模型来自应用内 AI 配置。

/** 供应商列表（渲染层视图：apiKey 已脱敏） */
export async function listProviders() {
  const providers = (await window.api.ai.providers.list()) || []
  return providers.filter((p) => p.enabled !== false)
}

/** 供应商展示模型：勾选了 visibleModelIds 则只显示勾选项 */
export function visibleModels(provider) {
  if (!provider) return []
  const models = provider.models || []
  const visible = provider.visibleModelIds
  if (Array.isArray(visible) && visible.length > 0) {
    return models.filter((m) => visible.includes(m.id))
  }
  return models
}

export function findProvider(providers, id) {
  return providers.find((p) => p.id === id) || null
}

/** 多模态识图：一张图 + 一段提问 */
export async function visionChat({ providerId, model, prompt, imageDataUrl, system }) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: imageDataUrl } }
    ]
  })
  const res = await window.api.ai.chat({ providerId, model, messages })
  return res.text
}

/** 纯文本对话（翻译等） */
export async function textChat({ providerId, model, prompt, system }) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })
  const res = await window.api.ai.chat({ providerId, model, messages })
  return res.text
}

/** 图生图：返回 [{name, dataUrl, width?, height?}] */
export async function imageToImage({ providerId, model, prompt, imageDataUrl }) {
  return window.api.ai.generateImage({
    providerId,
    model,
    mode: 'image2image',
    prompt,
    n: 1,
    inputImages: [imageDataUrl]
  })
}

export const OCR_PROMPT =
  '识别图片中的全部文字，按原始阅读顺序与段落排版输出。不要解释、不要总结、不要添加图片中不存在的内容。'

export const RECOGNIZE_PROMPT =
  '请详细描述这张截图：界面/页面主体是什么，包含哪些关键信息与数据。用中文回答。'

/** AI 输入用降采样（最长边 ≤2000，JPEG 压缩；马赛克区域不受影响，仅用于模型输入） */
export function aiImageInput(canvas, maxSide = 2000) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height))
  let c = canvas
  if (scale < 1) {
    c = document.createElement('canvas')
    c.width = Math.round(canvas.width * scale)
    c.height = Math.round(canvas.height * scale)
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(canvas, 0, 0, c.width, c.height)
  }
  return c.toDataURL('image/jpeg', 0.92)
}

/** 图生图结果图片名引用的是应用附件库（attach://），直接给 dataUrl 供展示/编辑 */
export function resultToCanvas(result) {
  const url = result.dataUrl
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      resolve(canvas)
    }
    img.onerror = () => reject(new Error('生图结果解析失败'))
    img.src = url
  })
}
