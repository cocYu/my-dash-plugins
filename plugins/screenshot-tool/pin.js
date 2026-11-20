// 贴图悬浮窗页：读取主进程存储的图片并展示。
// 交互：滚轮缩放（等比调整窗口尺寸）、拖动移动（CSS app-region）、
// 双击/ESC 关闭、右键菜单（复制/保存/缩放/关闭）。

const img = document.getElementById('img')
const menu = document.getElementById('menu')
const hint = document.getElementById('hint')

const params = new URLSearchParams(location.search)
const pinId = params.get('pin')

let naturalW = 1
let naturalH = 1
let scale = 1
let dataUrl = null
let saveDir = null // 右键「保存到截图目录」时用插件设置里的目录

const SCALE_MIN = 0.15
const SCALE_MAX = 8

function bytesFromDataUrl(url) {
  return fetch(url)
    .then((r) => r.arrayBuffer())
    .then((buf) => new Uint8Array(buf))
}

async function applySize(nextScale, anchor = null) {
  scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, nextScale))
  const width = Math.max(40, Math.round(naturalW * scale))
  const height = Math.max(30, Math.round(naturalH * scale))
  // 保持锚点（鼠标位置）附近内容不漂移
  if (anchor) {
    const cur = await window.api.pin.getBounds(pinId).catch(() => null)
    if (cur) {
      const dx = (width - cur.width) * (anchor.x / (cur.width || 1))
      const dy = (height - cur.height) * (anchor.y / (cur.height || 1))
      await window.api.pin.setBounds({ id: pinId, x: Math.round(cur.x - dx), y: Math.round(cur.y - dy), width, height })
    }
  } else {
    await window.api.pin.setBounds({ id: pinId, width, height }).catch(() => {})
  }
}

window.addEventListener('wheel', (e) => {
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
  void applySize(scale * factor, { x: e.clientX, y: e.clientY })
}, { passive: false })

// ---- 手动拖动移动（无边框窗口：mousedown 起点 + setBounds 平移，rAF 节流） ----

let drag = null // { sx, sy, bx, by, raf }
let pendingMove = null
let press = 0

window.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return
  if (menu.contains(e.target)) return
  const seq = ++press
  const b = await window.api.pin.getBounds(pinId).catch(() => null)
  if (!b || seq !== press) return
  drag = { sx: e.screenX, sy: e.screenY, bx: b.x, by: b.y, raf: false }
})

window.addEventListener('mousemove', (e) => {
  if (!drag) return
  pendingMove = { x: drag.bx + (e.screenX - drag.sx), y: drag.by + (e.screenY - drag.sy) }
  if (drag.raf) return
  drag.raf = true
  requestAnimationFrame(() => {
    if (!drag || !pendingMove) return
    drag.raf = false
    void window.api.pin.setBounds({ id: pinId, x: pendingMove.x, y: pendingMove.y })
  })
})

window.addEventListener('mouseup', () => {
  press++
  drag = null
  pendingMove = null
})

window.addEventListener('dblclick', () => void window.api.pin.close(pinId))

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void window.api.pin.close(pinId)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') void window.api.pin.copy(pinId)
})

window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const mw = 160
  const mh = 300
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - mw)}px`
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - mh)}px`
  menu.style.display = 'block'
})

window.addEventListener('mousedown', (e) => {
  if (!menu.contains(e.target)) menu.style.display = 'none'
})

menu.addEventListener('click', async (e) => {
  const act = e.target?.dataset?.act
  if (!act) return
  menu.style.display = 'none'
  if (act === 'copy') {
    const r = await window.api.pin.copy(pinId)
    if (!r.ok) console.error('复制失败:', r.message)
  } else if (act === 'save') {
    const bytes = await bytesFromDataUrl(dataUrl)
    await window.api.capture.saveFile({ bytes, ext: '.png', defaultName: `Pin_${Date.now()}.png` })
  } else if (act === 'dir') {
    if (!saveDir) {
      // 未配置保存目录时退化为另存对话框
      const bytes = await bytesFromDataUrl(dataUrl)
      await window.api.capture.saveFile({ bytes, ext: '.png', defaultName: `Pin_${Date.now()}.png` })
      return
    }
    const bytes = await bytesFromDataUrl(dataUrl)
    await window.api.capture.saveFile({
      bytes,
      ext: '.png',
      dir: saveDir,
      defaultName: `Pin_${new Date().toISOString().slice(0, 19).replace(/[-T:]/g, '')}.png`
    })
  } else if (act === 'actual') {
    await applySize(1)
  } else if (act === 'zoomin') {
    await applySize(scale * 1.25)
  } else if (act === 'zoomout') {
    await applySize(scale / 1.25)
  } else if (act === 'close-all') {
    await window.api.pin.closeAll()
  } else if (act === 'close') {
    await window.api.pin.close(pinId)
  }
})

async function init() {
  const res = await window.api.pin.get(pinId)
  if (!res?.dataUrl) {
    await window.api.pin.close(pinId)
    return
  }
  dataUrl = res.dataUrl
  img.src = dataUrl
  await new Promise((resolve) => {
    if (img.complete) resolve()
    else img.onload = resolve
  })
  naturalW = img.naturalWidth
  naturalH = img.naturalHeight
  scale = window.innerWidth / (naturalW || 1)
  // 读取插件保存目录（读不到不影响贴图）
  try {
    const kv = await window.api.plugins.kv('screenshot-tool', 'get', 'settings')
    saveDir = kv?.saveDir || null
  } catch {
    saveDir = null
  }
  setTimeout(() => {
    hint.style.opacity = '0'
  }, 3200)
}

void init()
