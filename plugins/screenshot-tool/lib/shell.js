// 带壳截图：把截图套进设备/窗口外框（纯 canvas 绘制，无外部资源）。
// 支持：浏览器窗口壳（深色/浅色）、macOS 窗口壳、手机壳、简约相框。

export const SHELLS = [
  { id: 'none', name: '不带壳' },
  { id: 'browser-dark', name: '浏览器 · 深色' },
  { id: 'browser-light', name: '浏览器 · 浅色' },
  { id: 'mac', name: 'macOS 窗口' },
  { id: 'phone', name: '手机壳' },
  { id: 'frame', name: '简约相框' }
]

function roundRectPath(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  g.beginPath()
  g.moveTo(x + rr, y)
  g.arcTo(x + w, y, x + w, y + h, rr)
  g.arcTo(x + w, y + h, x, y + h, rr)
  g.arcTo(x, y + h, x, y, rr)
  g.arcTo(x, y, x + w, y, rr)
  g.closePath()
}

function trafficLights(g, x, y) {
  const colors = ['#ff5f57', '#febc2e', '#28c840']
  colors.forEach((c, i) => {
    g.beginPath()
    g.arc(x + i * 22, y, 7, 0, Math.PI * 2)
    g.fillStyle = c
    g.fill()
  })
}

/** 通用窗口壳：topBar 高度内画红绿灯 + 可选地址栏，内容区圆角裁剪 */
function windowShell(base, { dark, addressBar, barH = 48 }) {
  const pad = 24 // 壳体留白
  const margin = 28 // 透明外边距（放阴影）
  const radius = 14
  const W = base.width
  const H = base.height
  const bodyW = W + pad * 2
  const bodyH = barH + H + pad
  const canvas = document.createElement('canvas')
  canvas.width = bodyW + margin * 2
  canvas.height = bodyH + margin * 2
  const g = canvas.getContext('2d')

  // 阴影
  g.save()
  g.shadowColor = 'rgba(0,0,0,0.35)'
  g.shadowBlur = 24
  g.shadowOffsetY = 6
  g.fillStyle = dark ? '#202124' : '#f6f6f8'
  roundRectPath(g, margin, margin, bodyW, bodyH, radius)
  g.fill()
  g.restore()

  // 顶栏
  g.save()
  roundRectPath(g, margin, margin, bodyW, bodyH, radius)
  g.clip()
  g.fillStyle = dark ? '#2b2c30' : '#ececef'
  g.fillRect(margin, margin, bodyW, barH)
  if (addressBar) {
    const pillW = Math.min(480, bodyW * 0.55)
    const pillX = margin + (bodyW - pillW) / 2
    const pillY = margin + (barH - 26) / 2
    g.fillStyle = dark ? '#3c3d42' : '#ffffff'
    roundRectPath(g, pillX, pillY, pillW, 26, 13)
    g.fill()
    if (!dark) {
      g.strokeStyle = '#d5d5da'
      g.lineWidth = 1
      g.stroke()
    }
  }
  trafficLights(g, margin + 20, margin + barH / 2)

  // 内容区
  g.fillStyle = dark ? '#202124' : '#ffffff'
  g.fillRect(margin, margin + barH, bodyW, bodyH - barH)
  g.drawImage(base, margin + pad, margin + barH)
  g.restore()
  return canvas
}

function phoneShell(base) {
  const bezel = 16
  const margin = 28
  const radius = 46
  const screenRadius = 34
  // 内容按手机屏宽缩放
  const targetW = 400
  const scale = targetW / base.width
  const contentH = Math.round(base.height * scale)
  const bodyW = targetW + bezel * 2
  const bodyH = contentH + bezel * 2
  const canvas = document.createElement('canvas')
  canvas.width = bodyW + margin * 2
  canvas.height = bodyH + margin * 2
  const g = canvas.getContext('2d')

  g.save()
  g.shadowColor = 'rgba(0,0,0,0.4)'
  g.shadowBlur = 24
  g.shadowOffsetY = 6
  g.fillStyle = '#101014'
  roundRectPath(g, margin, margin, bodyW, bodyH, radius)
  g.fill()
  g.restore()

  g.save()
  roundRectPath(g, margin, margin, bodyW, bodyH, radius)
  g.clip()
  g.fillStyle = '#101014'
  g.fillRect(0, 0, canvas.width, canvas.height)
  // 屏幕
  const sx = margin + bezel
  const sy = margin + bezel
  g.fillStyle = '#000000'
  roundRectPath(g, sx, sy, targetW, contentH, screenRadius)
  g.save()
  g.clip()
  g.drawImage(base, sx, sy, targetW, contentH)
  // 打孔摄像头
  g.beginPath()
  g.arc(sx + targetW / 2, sy + 14, 9, 0, Math.PI * 2)
  g.fillStyle = '#000000'
  g.fill()
  g.beginPath()
  g.arc(sx + targetW / 2, sy + 14, 6, 0, Math.PI * 2)
  g.fillStyle = '#1c1c22'
  g.fill()
  g.restore()
  g.restore()
  return canvas
}

function frameShell(base) {
  const border = 24
  const margin = 28
  const radius = 10
  const bodyW = base.width + border * 2
  const bodyH = base.height + border * 2
  const canvas = document.createElement('canvas')
  canvas.width = bodyW + margin * 2
  canvas.height = bodyH + margin * 2
  const g = canvas.getContext('2d')
  g.save()
  g.shadowColor = 'rgba(0,0,0,0.3)'
  g.shadowBlur = 24
  g.shadowOffsetY = 6
  g.fillStyle = '#ffffff'
  roundRectPath(g, margin, margin, bodyW, bodyH, radius)
  g.fill()
  g.restore()
  g.save()
  roundRectPath(g, margin, margin, bodyW, bodyH, radius)
  g.clip()
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.drawImage(base, margin + border, margin + border)
  g.restore()
  return canvas
}

/** 给截图套壳；shellId 见 SHELLS（none 返回原图副本） */
export function applyShell(base, shellId) {
  switch (shellId) {
    case 'browser-dark':
      return windowShell(base, { dark: true, addressBar: true })
    case 'browser-light':
      return windowShell(base, { dark: false, addressBar: true })
    case 'mac':
      return windowShell(base, { dark: false, addressBar: false, barH: 42 })
    case 'phone':
      return phoneShell(base)
    case 'frame':
      return frameShell(base)
    default: {
      const copy = document.createElement('canvas')
      copy.width = base.width
      copy.height = base.height
      copy.getContext('2d').drawImage(base, 0, 0)
      return copy
    }
  }
}
