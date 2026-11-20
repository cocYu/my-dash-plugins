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

export const PLAIN = Object.freeze({ rounded: false, radius: 16, shell: 'none' })
export function appearance(value = {}) {
  return { rounded: value?.rounded === true,
    radius: Number.isFinite(value?.radius) ? Math.max(0, Math.min(256, Math.round(value.radius))) : PLAIN.radius,
    shell: SHELLS.some(s => s.id === value?.shell) ? value.shell : 'none' }
}

// Same layout in source pixels for the checkerboard preview and the final PNG.
// Decorations are never written back onto the editable document.
export function renderOutput(base, options, maxSide = Infinity) {
  const { rounded, radius, shell } = appearance(options)
  if (!rounded && shell === 'none' && maxSide === Infinity) return base
  const phone = shell === 'phone', framed = shell !== 'none', browser = shell.startsWith('browser-')
  const dark = shell === 'browser-dark' || phone
  const ratio = phone ? Math.min(1, 400 / base.width) : 1
  const w = Math.max(1, Math.round(base.width * ratio)), h = Math.max(1, Math.round(base.height * ratio))
  const pad = !framed ? 0 : phone ? 16 : 24, margin = framed ? 28 : 0
  const top = browser ? 48 : shell === 'mac' ? 42 : pad
  const bodyW = w + 2 * pad, bodyH = h + top + pad
  const W = bodyW + 2 * margin, H = bodyH + 2 * margin
  const scale = Math.min(1, maxSide / Math.max(W,H))
  const out = document.createElement('canvas')
  out.width = Math.max(1,Math.round(W*scale)); out.height = Math.max(1,Math.round(H*scale))
  const g = out.getContext('2d'); g.scale(out.width/W,out.height/H)
  function box(x,y,bw,bh,r) {
    g.beginPath(); g.roundRect(x,y,bw,bh,Math.min(r,bw/2,bh/2))
  }
  if (framed) {
    g.save(); box(margin,margin,bodyW,bodyH,phone ? 46 : 14)
    g.fillStyle = dark ? '#24262b' : '#fafafa'; g.shadowColor = '#0006'; g.shadowBlur = 20*scale; g.shadowOffsetY = 5*scale; g.fill(); g.restore()
    if (browser || shell === 'mac') {
      g.save(); box(margin,margin,bodyW,bodyH,14); g.clip()
      g.fillStyle = dark ? '#34363b' : '#e7e8ed'; g.fillRect(margin,margin,bodyW,top)
      if (browser && bodyW > 160) {
        const pill = Math.min(480,bodyW-110); box(margin+(bodyW-pill)/2+25, margin+12,pill,24,12)
        g.fillStyle = dark ? '#51545b' : '#fff'; g.fill()
      }
      ;['#ff5f57','#febc2e','#28c840'].forEach((color,i) => {
        g.beginPath(); g.arc(margin+16+17*i,margin+top/2,5,0,Math.PI*2); g.fillStyle=color; g.fill()
      }); g.restore()
    }
  }
  box(margin+pad,margin+top,w,h,rounded ? radius*ratio : 0); g.clip()
  g.drawImage(base,margin+pad,margin+top,w,h)
  return out
}
