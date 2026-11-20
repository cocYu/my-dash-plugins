// 桌面截屏封装：源枚举、按源快照、区域截图流程、剪贴板粘贴。

/** 枚举屏幕与窗口源（缩略图 dataURL，供自绘选择器） */
export async function listSources() {
  return window.api.capture.sources()
}

/** 单帧快照：不启动或保留屏幕录制流。 */
export async function grabSource(id) {
  const { dataUrl } = await window.api.capture.snapshot(id)
  return loadImageToCanvas(dataUrl)
}

/**
 * 区域截图：主进程隐藏主窗 → 整屏快照 → 全屏遮罩窗展示选框；
 * 遮罩页确认后经 capture:region-result 推回工作台。
 */
export function startRegion(pluginId, delaySeconds = 0) {
  return window.api.capture.startRegion({ pluginId, page: 'overlay.html', delaySeconds })
}

/** 订阅区域截图结果，返回取消订阅函数 */
export function onRegionResult(cb) {
  return window.api.capture.onRegionResult(cb)
}

/** 浮动控制条不抢焦点；优先使用宿主剪贴板，旧宿主降级浏览器接口。 */
export async function copyPng(canvas) {
  const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('导出失败')), 'image/png'))
  if (window.api.capture.copyPng) return window.api.capture.copyPng(new Uint8Array(await blob.arrayBuffer()))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

/** 图片落盘（dir 为空则弹另存对话框） */
export function saveImageFile(payload) {
  return window.api.capture.saveFile(payload)
}

/** 选择保存目录 */
export function chooseDir() {
  return window.api.capture.chooseDir()
}

/** 从系统剪贴板读取图片，返回 canvas；无图返回 null */
export async function pasteFromClipboard() {
  if (!navigator.clipboard?.read) return null
  let items
  try {
    items = await navigator.clipboard.read()
  } catch {
    return null
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    return await blobToCanvas(blob)
  }
  return null
}

/** data URL / blob → canvas */
export async function blobToCanvas(blob) {
  const url = await blobToDataUrl(blob)
  return await loadImageToCanvas(url)
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读取图片失败'))
    fr.readAsDataURL(blob)
  })
}

export function loadImageToCanvas(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      resolve(canvas)
    }
    img.onerror = () => reject(new Error('图片解析失败'))
    img.src = url
  })
}
