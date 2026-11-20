// 区域截图遮罩页：展示主窗抓好的冻屏全帧（经 capture:get-overlay-image 取自主进程），
// 拖框选区，确认后裁剪回传。
// 坐标换算：屏幕逻辑坐标（CSS px） ↔ 图像物理坐标（冻屏 canvas 像素）。

const freeze = document.getElementById('freeze')
const ui = document.getElementById('ui')
const toolbar = document.getElementById('toolbar')
const tip = document.getElementById('tip')

let img = null // 冻屏 canvas（物理像素）
let sx = 1 // image / screen 缩放
let sy = 1
let rect = null // 屏幕逻辑坐标 { x1, y1, x2, y2 }
let dragging = false
let done = false

function initUiCanvas() {
  ui.width = window.innerWidth
  ui.height = window.innerHeight
  sx = img.width / window.innerWidth
  sy = img.height / window.innerHeight
}

function draw() {
  const g = ui.getContext('2d')
  g.clearRect(0, 0, ui.width, ui.height)
  // 全屏压暗
  g.fillStyle = 'rgba(0,0,0,0.32)'
  g.fillRect(0, 0, ui.width, ui.height)
  if (!rect) return
  const x = Math.min(rect.x1, rect.x2)
  const y = Math.min(rect.y1, rect.y2)
  const w = Math.abs(rect.x2 - rect.x1)
  const h = Math.abs(rect.y2 - rect.y1)
  // 选区挖亮
  g.clearRect(x, y, w, h)
  // 边框
  g.strokeStyle = '#1971c2'
  g.lineWidth = 1.5
  g.strokeRect(x + 0.5, y + 0.5, w, h)
  // 四角锚点
  g.fillStyle = '#1971c2'
  for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
    g.fillRect(cx - 3, cy - 3, 6, 6)
  }
  // 尺寸提示
  const label = `${Math.round(w * sx)} × ${Math.round(h * sy)}`
  g.font = '12px system-ui'
  const tw = g.measureText(label).width
  const lx = x + w / 2 - tw / 2 - 6
  const ly = y > 28 ? y - 26 : y + h + 8
  g.fillStyle = 'rgba(20,20,24,0.9)'
  g.fillRect(lx, ly, tw + 12, 20)
  g.fillStyle = '#eee'
  g.fillText(label, lx + 6, ly + 14)
}

function placeToolbar() {
  const x = Math.min(rect.x1, rect.x2)
  const y = Math.min(rect.y1, rect.y2)
  const w = Math.abs(rect.x2 - rect.x1)
  const h = Math.abs(rect.y2 - rect.y1)
  const tbW = toolbar.offsetWidth || 210
  const tbH = toolbar.offsetHeight || 40
  let tx = x + w - tbW
  let ty = y + h + 10
  if (ty + tbH > window.innerHeight - 8) ty = y + h - tbH - 10
  tx = Math.max(8, Math.min(tx, window.innerWidth - tbW - 8))
  ty = Math.max(8, ty)
  toolbar.style.left = `${tx}px`
  toolbar.style.top = `${ty}px`
  toolbar.style.display = 'flex'
}

function showRect(r) {
  rect = r
  draw()
  placeToolbar()
}

function normImageRect(r) {
  const x = Math.round(Math.min(r.x1, r.x2) * sx)
  const y = Math.round(Math.min(r.y1, r.y2) * sy)
  const w = Math.round(Math.abs(r.x2 - r.x1) * sx)
  const h = Math.round(Math.abs(r.y2 - r.y1) * sy)
  return {
    x: Math.max(0, Math.min(x, img.width - 1)),
    y: Math.max(0, Math.min(y, img.height - 1)),
    w: Math.max(1, Math.min(w, img.width - Math.max(0, Math.min(x, img.width - 1)))),
    h: Math.max(1, Math.min(h, img.height - Math.max(0, Math.min(y, img.height - 1))))
  }
}

async function confirm() {
  if (done || !rect) return
  done = true
  const r = normImageRect(rect)
  const out = document.createElement('canvas')
  out.width = r.w
  out.height = r.h
  out.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
  // 遮罩窗随后会被主进程销毁，invoke 的回复可能收不到，无需处理
  void window.api.capture.finishRegion({ dataUrl: out.toDataURL('image/png') })
}

async function cancel() {
  if (done) return
  done = true
  await window.api.capture.cancelRegion()
}

function selectAll() {
  showRect({ x1: 0, y1: 0, x2: window.innerWidth, y2: window.innerHeight })
}

ui.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  dragging = true
  rect = { x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY }
  toolbar.style.display = 'none'
  draw()
})

ui.addEventListener('mousemove', (e) => {
  if (!dragging) return
  rect.x2 = Math.max(0, Math.min(e.clientX, window.innerWidth))
  rect.y2 = Math.max(0, Math.min(e.clientY, window.innerHeight))
  draw()
})

window.addEventListener('mouseup', () => {
  if (!dragging) return
  dragging = false
  const w = Math.abs(rect.x2 - rect.x1)
  const h = Math.abs(rect.y2 - rect.y1)
  if (w < 6 || h < 6) {
    rect = null
    draw()
    toolbar.style.display = 'none'
    return
  }
  placeToolbar()
})

ui.addEventListener('dblclick', () => selectAll())

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (rect) void confirm()
    else selectAll()
  } else if (e.key === 'Escape') {
    void cancel()
  }
})

document.getElementById('btn-ok').addEventListener('click', confirm)
document.getElementById('btn-full').addEventListener('click', () => {
  selectAll()
  void confirm()
})
document.getElementById('btn-cancel').addEventListener('click', cancel)

async function init() {
  const dataUrl = await window.api.capture.getOverlayImage()
  if (!dataUrl) {
    // 没拿到画面（异常流程）直接退出
    await window.api.capture.cancelRegion()
    return
  }
  const image = new Image()
  await new Promise((resolve, reject) => {
    image.onload = resolve
    image.onerror = reject
    image.src = dataUrl
  })
  img = document.createElement('canvas')
  img.width = image.naturalWidth
  img.height = image.naturalHeight
  img.getContext('2d').drawImage(image, 0, 0)
  freeze.width = img.width
  freeze.height = img.height
  freeze.getContext('2d').drawImage(img, 0, 0)
  initUiCanvas()
  document.body.classList.add('ready')
  setTimeout(() => {
    tip.style.opacity = '0'
    tip.style.transition = 'opacity .6s'
  }, 2600)
}

void init()
