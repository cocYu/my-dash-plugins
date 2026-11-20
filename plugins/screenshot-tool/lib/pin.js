// 截图贴图（pin）：把当前画布钉成置顶悬浮窗。窗口本体由主进程创建，
// pin.html 只负责展示与交互（滚轮缩放/拖动/右键菜单）。

/** 把 canvas 钉到屏幕，返回 { id, width, height } */
export async function pinCanvas(ctx, canvas) {
  const dataUrl = await new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('导出失败'))
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('读取图片失败'))
      fr.readAsDataURL(blob)
    }, 'image/png')
  })
  return window.api.pin.show({
    pluginId: ctx.meta.id,
    page: 'pin.html',
    dataUrl,
    width: canvas.width,
    height: canvas.height
  })
}

/** 把 data URL（历史图等）直接钉到屏幕 */
export async function pinDataUrl(ctx, dataUrl, width, height) {
  return window.api.pin.show({ pluginId: ctx.meta.id, page: 'pin.html', dataUrl, width, height })
}

export function pinList() {
  return window.api.pin.list()
}

export function closeAllPins() {
  return window.api.pin.closeAll()
}
