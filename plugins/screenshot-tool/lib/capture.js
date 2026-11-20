// 桌面截屏封装：源枚举、按源抓帧（getUserMedia desktop 流）、区域截图流程、剪贴板粘贴。

/** 枚举屏幕与窗口源（缩略图 dataURL，供自绘选择器） */
export async function listSources() {
  return window.api.capture.sources()
}

/** Promise 硬超时（桌面捕获在部分环境会偶发挂起，绝不无限等） */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时`)), ms))
  ])
}

/** 打开窗口源的桌面捕获流（getUserMedia 偶发挂起/首启失败：8s 超时 + 一次重试） */
async function openStream(sourceId) {
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 7680,
        maxHeight: 4320
      }
    }
  }
  try {
    return await withTimeout(navigator.mediaDevices.getUserMedia(constraints), 8000, '打开截屏流')
  } catch (err) {
    return withTimeout(navigator.mediaDevices.getUserMedia(constraints), 8000, '打开截屏流(重试)')
  }
}

/**
 * 抓取某源单帧，返回 canvas。
 * 窗口源走 MediaStream 原生分辨率抓帧（管线正常）；屏幕源走主进程 thumbnail
 * 快照通道（部分环境屏幕 MediaStream 不出帧，快照对屏幕可靠）。
 */
export async function grabSource(sourceId) {
  if (String(sourceId).startsWith('window:')) {
    const stream = await openStream(sourceId)
    try {
      return await grabFrameOnce(stream)
    } finally {
      for (const t of stream.getTracks()) t.stop()
    }
  }
  const snap = await window.api.capture.snapshot(sourceId)
  return loadImageToCanvas(snap.dataUrl)
}

/** 从持续流中抓当前帧（长图复用），不关闭流 */
export async function grabFrameOnce(stream) {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  try {
    // 元数据/播放都做硬超时：桌面流偶发不出帧（尤其全屏流），绝不无限等
    await withTimeout(
      new Promise((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error('视频流加载失败'))
      }),
      2500,
      '视频元数据'
    )
    await withTimeout(video.play(), 3000, '视频播放')
    // 等第一帧真正到达（rVFC 或 400ms 兜底）
    await new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => resolve())
      }
      setTimeout(resolve, 400)
    })
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    if (!canvas.width || !canvas.height) throw new Error('未获取到画面')
    const g = canvas.getContext('2d')
    g.drawImage(video, 0, 0)
    return canvas
  } finally {
    video.pause?.()
    video.srcObject = null
  }
}

/** 持续抓帧会话（长图模式）：保持流打开，可反复 grab */
export async function openCaptureStream(sourceId) {
  const stream = await openStream(sourceId)
  return {
    grab: () => grabFrameOnce(stream),
    close: () => {
      for (const t of stream.getTracks()) t.stop()
    }
  }
}

/**
 * 区域截图：主进程隐藏主窗 → 整屏快照 → 全屏遮罩窗展示选框；
 * 遮罩页确认后经 capture:region-result 推回工作台。
 */
export function startRegion(pluginId) {
  return window.api.capture.startRegion({ pluginId, page: 'overlay.html' })
}

/** 订阅区域截图结果，返回取消订阅函数 */
export function onRegionResult(cb) {
  return window.api.capture.onRegionResult(cb)
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
