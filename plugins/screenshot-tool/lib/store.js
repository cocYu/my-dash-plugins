// 设置持久化（插件命名空间 KV）
const KEY = 'settings'

export const DEFAULT_SETTINGS = {
  /** 截图保存目录（空 = 每次弹另存对话框） */
  saveDir: '',
  /** 历史记录保留条数 */
  historyLimit: 50,
  /** 长图自动模式抓帧间隔（毫秒） */
  intervalMs: 800,
  /** AI 供应商与模型（识图/OCR/翻译/图生图共用供应商，模型分列） */
  providerId: '',
  visionModel: '',
  chatModel: '',
  imageModel: '',
  /** 翻译目标语言 */
  targetLang: '简体中文',
  /** 本地 tesseract 识别语言包 */
  tesseractLangs: 'chi_sim+eng'
}

export async function loadSettings(ctx) {
  const saved = (await ctx.storage.get(KEY)) || {}
  return { ...DEFAULT_SETTINGS, ...saved }
}

export async function saveSettings(ctx, settings) {
  await ctx.storage.set(KEY, settings)
}
