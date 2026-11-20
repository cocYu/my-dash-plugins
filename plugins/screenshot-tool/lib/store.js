import { appearance } from './shell.js'
// 设置持久化（插件命名空间 KV）
const KEY = 'settings'

/** 独立 AI 配置默认值 */
export const DEFAULT_DIRECT_AI = {
  /** 供应商协议：chat=OpenAI Chat / responses=OpenAI Responses / messages=Anthropic */
  protocol: 'chat',
  /** 根地址，不含 /v1（网关自动补） */
  baseUrl: '',
  apiKey: '',
  /** 识图/OCR 模型 */
  visionModel: '',
  /** 翻译等文本模型 */
  chatModel: ''
}

/** 长截图配置默认值 */
export const DEFAULT_LONGSHOT = {
  /** 自动翻页键：down=↓ / pagedown=PageDown / space=空格 */
  scrollKey: 'down',
  /** 自动模式抓帧间隔（毫秒） */
  intervalMs: 800
}

/** 全局快捷键配置默认值 */
export const DEFAULT_HOTKEY = {
  enabled: false,
  /** Electron accelerator，如 CommandOrControl+Shift+A */
  accelerator: 'CommandOrControl+Shift+A'
}

export const DEFAULT_SETTINGS = {
  /** 截图保存目录（空 = 每次弹另存对话框） */
  saveDir: '',
  appearance: appearance(),
  /** 历史记录保留条数 */
  historyLimit: 50,
  /** 长图自动模式抓帧间隔（毫秒）（旧字段，被 longshot.intervalMs 取代，保留兼容读取） */
  intervalMs: 800,
  /** AI 配置模式：direct=插件内独立配置（默认）/ app=复用主程序 AI 工作台供应商 */
  aiMode: 'direct',
  /** 独立 AI 配置 */
  direct: { ...DEFAULT_DIRECT_AI },
  /** 复用主程序时的供应商与模型 */
  providerId: '',
  visionModel: '',
  chatModel: '',
  imageModel: '',
  /** 翻译目标语言 */
  targetLang: '简体中文',
  /** 本地 tesseract 识别语言包 */
  tesseractLangs: 'chi_sim+eng',
  /** 全局快捷键（区域截图） */
  hotkey: { ...DEFAULT_HOTKEY },
  /** 长截图 */
  longshot: { ...DEFAULT_LONGSHOT }
}

function mergeGroup(saved, defaults) {
  return typeof saved === 'object' && saved ? { ...defaults, ...saved } : { ...defaults }
}

export function normalizeSettings(saved = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    appearance: appearance(saved.appearance),
    direct: mergeGroup(saved.direct, DEFAULT_DIRECT_AI),
    hotkey: mergeGroup(saved.hotkey, DEFAULT_HOTKEY),
    longshot: mergeGroup(saved.longshot, DEFAULT_LONGSHOT)
  }
}

export async function loadSettings(ctx) {
  return normalizeSettings(await ctx.storage.get(KEY) || {})
}

export async function loadWindowSettings(id) {
  try { return normalizeSettings(await window.api.plugins.kv(id, 'get', KEY) || {}) }
  catch { return normalizeSettings() }
}

export async function saveSettings(ctx, settings) {
  await ctx.storage.set(KEY, JSON.parse(JSON.stringify(settings)))
}
