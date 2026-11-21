import { chooseAppearance } from './lib/appearance-dialog.js'
import { mountInspector } from './lib/inspector.js'
import { copyPng } from './lib/capture.js'
import { constrainSelection, imageBounds } from './lib/selection.js'
// 区域截图遮罩页：展示主进程抓好的冻屏全帧 → 拖框选区 → 冻屏就地编辑 → 最终动作后关闭。
// 坐标换算：屏幕逻辑坐标（CSS px） ↔ 图像物理坐标（冻屏 canvas 像素）。
// 流程：松开鼠标即进入编辑态（遮罩不关闭），标注/OCR/识图/贴图/保存/长截图全部就地完成；
// 复制/保存/贴图后 capture:finish-region 关遮罩并把结果推回主窗记历史。
// 标注核心与主窗工作台共用（lib/editor.js 的 createEditorCore），交互行为一致。

import { TOOLS, createEditorCore } from './lib/editor.js'
import {
  OCR_PROMPT,
  RECOGNIZE_PROMPT,
  aiImageInput,
  resolveAi,
  visionReady,
  chatReady,
  visionChatResolved,
  textChatResolved
} from './lib/ai.js'
import { ocrLocal } from './lib/ocr.js'
import { canvasBytes } from './lib/history.js'
import { loadWindowSettings } from './lib/store.js'

const PLUGIN_ID = location.hostname // plugin://<id>/overlay.html

const freeze = document.getElementById('freeze')
const ui = document.getElementById('ui')
const anno = document.getElementById('anno')
const tip = document.getElementById('tip')
const editbar = document.getElementById('editbar')
const panel = document.getElementById('panel')
const toastEl = document.getElementById('toast')
const textbox = document.getElementById('textbox')
const textInput = document.getElementById('text-input')
const ebCopy = document.getElementById('eb-copy')
const ebSave = document.getElementById('eb-save')
const ebPin = document.getElementById('eb-pin')
const ebOcr = document.getElementById('eb-ocr')
const ebRecognize = document.getElementById('eb-recognize')
const ebLongshot = document.getElementById('eb-longshot')
const ebReselect = document.getElementById('eb-reselect')
const ebCancel = document.getElementById('eb-cancel')
const ebToolsRow = document.getElementById('eb-tools')
const panelTitle = document.getElementById('panel-title')
const panelOcr = document.getElementById('panel-ocr')
const panelTrRow = document.getElementById('panel-tr-row')
const panelTrLabel = document.getElementById('panel-tr-label')
const panelTranslate = document.getElementById('panel-translate')
const panelCopy = document.getElementById('panel-copy')
const panelTranslateBtn = document.getElementById('panel-translate-btn')
const panelClose = document.getElementById('panel-close')

let freezeC = null // 冻屏 canvas（物理像素）
let sx = 1 // 图像宽 / 屏幕逻辑宽
let sy = 1
let phase = 'loading' // loading | select | edit | done
let rect = null // select 态拖拽中的屏幕逻辑坐标 { x1, y1, x2, y2 }
let sel = null // edit 态选区（屏幕逻辑坐标 { x, y, w, h }）
let selImg = null // edit 态选区（图像物理像素）
let selK = 1 // edit 态 图像物理 px / 屏幕 css px
let dragging = false
let finished = false
let busyAction = false
let lastOcr = ''
let escArmed = false
let toastTimer = null
let settings = null

// ---- 设置（遮罩页无 ctx，直接走插件 KV） ----


// ---- 标注核心（与主窗工作台共用） ----

const core = createEditorCore({
  onChange: () => {
    escArmed = false
    syncEditbar()
  }
})

// ---- 工具条构建 ----

const toolBtns = []
let syncInspector
let undoBtn = null
let redoBtn = null

function buildEditbar() {
  for (const t of TOOLS) {
    const b = document.createElement('button')
    b.className = 'eb-tool'
    b.dataset.tool = t.id
    b.textContent = t.glyph
    b.title = t.name
    b.setAttribute('aria-label', t.name)
    b.addEventListener('click', () => {
      core.selectTool(t.id)
      if (sel) placeEditbar()
    })
    toolBtns.push(b)
    ebToolsRow.appendChild(b)
  }
  syncInspector = mountInspector(document.querySelector('#overlay-inspector'), core)
  const sep3 = document.createElement('span')
  sep3.className = 'eb-sep'
  ebToolsRow.appendChild(sep3)
  undoBtn = mkBarBtn('↶', '撤销（Ctrl+Z）', () => core.undo())
  undoBtn.id = 'eb-undo'
  redoBtn = mkBarBtn('↷', '重做（Ctrl+Shift+Z）', () => core.redo())
  redoBtn.id = 'eb-redo'
  ebToolsRow.appendChild(undoBtn)
  ebToolsRow.appendChild(redoBtn)
}

function mkBarBtn(text, title, onClick, cls = '') {
  const b = document.createElement('button')
  b.textContent = text
  b.title = title
  if (cls) b.classList.add(cls)
  b.addEventListener('click', onClick)
  return b
}

/** 同步工具条与文字输入框到核心状态 */
const adjust = document.querySelector('#adjust')
const geometry = document.querySelector('#geometry')
function closeGeometry() { geometry.hidden = true; adjust.setAttribute('aria-expanded', 'false') }
adjust.onclick = () => {
  if (!sel || busyAction || !geometry.hidden) return closeGeometry()
  for (const key of ['x','y','w','h']) geometry.elements[key].value = Math.round(sel[key])
  geometry.hidden = false
  adjust.setAttribute('aria-expanded', 'true')
  placeEditbar()
  geometry.elements.x.focus()
}
geometry.onsubmit = e => {
  e.preventDefault()
  if (adjust.disabled || busyAction) return
  const values = Object.fromEntries(['x','y','w','h'].map(k => [k, geometry.elements[k].valueAsNumber]))
  const r = constrainSelection(values, window.innerWidth, window.innerHeight)
  rect = {x1:r.x, y1:r.y, x2:r.x+r.w, y2:r.y+r.h}
  lastOcr = ''; hidePanel(); closeGeometry(); enterEdit(); adjust.focus()
}
function syncEditbar() {
  syncInspector?.()
  anno.style.cursor = core.state.tool === 'select' ? 'move' : 'crosshair'
  adjust.disabled = !!(core.state.pendingStep || core.state.shapes.length || core.state.textEditing || core.state.redo.length)
  if (adjust.disabled) closeGeometry()
  for (const b of toolBtns) b.classList.toggle('is-active', b.dataset.tool === core.state.tool)
  if (undoBtn) undoBtn.disabled = !core.state.undo.length
  if (redoBtn) redoBtn.disabled = !core.state.redo.length
  const t = core.state.textEditing
  if (t && sel) {
    textbox.style.left = `${Math.max(0, Math.min(innerWidth-170, sel.x+t.x/selK))}px`
    textbox.style.top = `${Math.min(innerHeight-36,sel.y+t.y*sel.h/selImg.h)}px`
    textInput.setAttribute('aria-label', t.step ? '步骤说明' : '标注文字')
    textbox.style.display = 'block'
    if (document.activeElement !== textInput) {
      if (textInput.value !== t.value) textInput.value = t.value
      requestAnimationFrame(() => textInput.focus())
    }
  } else {
    textbox.style.display = 'none'
  }
}

textInput.addEventListener('input', () => {
  if (core.state.textEditing) core.state.textEditing.value = textInput.value
})
textInput.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter') core.commitText()
  else if (e.key === 'Escape') {
    core.cancelDraft()
  }
})
textInput.addEventListener('blur', () => {
  if (core.state.textEditing) core.commitText()
})

// ---- 遮罩绘制 ----

function initUiCanvas() {
  ui.width = window.innerWidth
  ui.height = window.innerHeight
  sx = freezeC.width / window.innerWidth
  sy = freezeC.height / window.innerHeight
}

function normSel(r) {
  const x = Math.min(r.x1, r.x2)
  const y = Math.min(r.y1, r.y2)
  return { x, y, w: Math.abs(r.x2 - r.x1), h: Math.abs(r.y2 - r.y1) }
}

function draw() {
  const g = ui.getContext('2d')
  g.clearRect(0, 0, ui.width, ui.height)
  // 全屏压暗
  g.fillStyle = 'rgba(0,0,0,0.32)'
  g.fillRect(0, 0, ui.width, ui.height)
  const r = phase === 'edit' ? (sel ? { x1: sel.x, y1: sel.y, x2: sel.x + sel.w, y2: sel.y + sel.h } : null) : rect
  if (!r) return
  const x = Math.min(r.x1, r.x2)
  const y = Math.min(r.y1, r.y2)
  const w = Math.abs(r.x2 - r.x1)
  const h = Math.abs(r.y2 - r.y1)
  // 选区挖亮
  g.clearRect(x, y, w, h)
  // 边框
  g.strokeStyle = '#1971c2'
  g.lineWidth = 1.5
  g.strokeRect(x + 0.5, y + 0.5, w, h)
  if (phase === 'select') {
    // 四角锚点 + 尺寸提示
    g.fillStyle = '#1971c2'
    for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      g.fillRect(cx - 3, cy - 3, 6, 6)
    }
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
}

function placeEditbar() {
  const tbW = editbar.offsetWidth || 760
  const tbH = editbar.offsetHeight || 76
  let tx = sel.x + sel.w / 2 - tbW / 2
  let ty = sel.y + sel.h + 10
  if (ty + tbH > window.innerHeight - 8) ty = sel.y - tbH - 10
  tx = Math.max(8, Math.min(tx, window.innerWidth - tbW - 8))
  ty = Math.max(8, ty)
  editbar.style.left = `${tx}px`
  editbar.style.top = `${ty}px`
  editbar.style.display = 'flex'
}

// ---- 阶段切换 ----

function enterEdit() {
  if (!rect) return
  phase = 'edit'
  sel = normSel(rect)
  selImg = imageBounds(sel, sx, sy, freezeC.width, freezeC.height)
  document.querySelector('#selection-size').textContent = `${selImg.w} × ${selImg.h} px`
  selK = selImg.w / sel.w
  rect = null
  // 布局标注画布（attr = 物理像素，style = 屏幕逻辑尺寸）
  anno.style.left = `${sel.x}px`
  anno.style.top = `${sel.y}px`
  anno.style.width = `${sel.w}px`
  anno.style.height = `${sel.h}px`
  anno.width = selImg.w
  anno.height = selImg.h
  // 底图 = 冻屏选区裁剪（形状坐标为选区局部物理像素）
  const base = document.createElement('canvas')
  base.width = selImg.w
  base.height = selImg.h
  base.getContext('2d').drawImage(freezeC, selImg.x, selImg.y, selImg.w, selImg.h, 0, 0, selImg.w, selImg.h)
  core.load(base, {appearance:core.state.appearance})
  core.attach(anno)
  document.body.classList.add('editing')
  tip.style.display = 'none'
  draw()
  editbar.style.display = 'flex'
  placeEditbar()
  syncEditbar()
}

function reselect() {
  if (busyAction) return
  closeGeometry()
  phase = 'select'
  sel = null
  selImg = null
  lastOcr = ''
  hidePanel()
  core.load(document.createElement('canvas'), {appearance:core.state.appearance})
  core.detach()
  document.body.classList.remove('editing')
  anno.width = 0
  anno.height = 0
  editbar.style.display = 'none'
  tip.style.display = 'block'
  tip.textContent = '拖动选择新区域 · Esc 取消 · 双击全屏'
  draw()
}

function selectAll() {
  rect = { x1: 0, y1: 0, x2: window.innerWidth, y2: window.innerHeight }
  enterEdit()
}

async function cancel() {
  if (finished || busyAction) return
  finished = true
  phase = 'done'
  try {
    await window.api.capture.cancelRegion()
  } catch {
    /* 遮罩窗随后被销毁，回复可能收不到 */
  }
}

/** 最终动作完成：可选提示后关闭遮罩并回传结果 */
async function finish(payload, toastMsg = '') {
  if (finished) return
  finished = true // 提前置位：提示延迟期间不再接受其他动作/取消
  phase = 'done'
  if (toastMsg) {
    showToast(toastMsg)
    await new Promise((r) => setTimeout(r, 1100))
  }
  try {
    await window.api.capture.finishRegion(payload)
  } catch {
    /* 同上 */
  }
}

// ---- 导出 ----

/** 当前选区 + 标注合成图（选区局部物理像素） */
function exportFinal() {
  return core.exportCanvas()
}

function toPngDataUrl(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('图片导出失败'))
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('读取图片失败'))
      fr.readAsDataURL(blob)
    }, 'image/png')
  })
}

function stampName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `Screenshot_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`
}

// ---- 动作 ----

function setBtnLoading(btn, on, label) {
  if (on) {
    btn.dataset.label = btn.textContent
    btn.textContent = label || '…'
    btn.disabled = true
  } else {
    if (btn.dataset.label) btn.textContent = btn.dataset.label
    btn.disabled = false
  }
}

async function doCopy() {
  if (phase !== 'edit' || busyAction) return
  busyAction = true
  setBtnLoading(ebCopy, true, '复制中…')
  try {
    const out = exportFinal()
    await copyPng(out)
    await finish({ dataUrl: await toPngDataUrl(out), ocrText: lastOcr || undefined })
  } catch (err) {
    toast(`复制失败：${err.message}`)
  } finally {
    busyAction = false
    setBtnLoading(ebCopy, false)
  }
}

async function doSave() {
  if (phase !== 'edit' || busyAction) return
  busyAction = true
  setBtnLoading(ebSave, true, '保存中…')
  try {
    const out = exportFinal()
    const bytes = await canvasBytes(out)
    const r = await window.api.capture.saveFile({
      bytes,
      ext: '.png',
      dir: settings.saveDir || undefined,
      defaultName: stampName()
    })
    if (r.saved) {
      await finish({ dataUrl: await toPngDataUrl(out), ocrText: lastOcr || undefined }, `已保存：${r.filePath}`)
    } else {
      toast('已取消保存')
    }
  } catch (err) {
    toast(`保存失败：${err.message}`)
  } finally {
    busyAction = false
    setBtnLoading(ebSave, false)
  }
}

async function doPin() {
  if (phase !== 'edit' || busyAction) return
  busyAction = true
  setBtnLoading(ebPin, true, '…')
  try {
    const out = exportFinal()
    const dataUrl = await toPngDataUrl(out)
    await window.api.pin.show({
      pluginId: PLUGIN_ID,
      page: 'pin.html',
      dataUrl,
      width: out.width,
      height: out.height
    })
    await finish({ dataUrl, ocrText: lastOcr || undefined })
  } catch (err) {
    toast(`贴图失败：${err.message}`)
  } finally {
    busyAction = false
    setBtnLoading(ebPin, false)
  }
}

async function doLongshot() {
  if (phase !== 'edit' || busyAction) return
  busyAction = true
  setBtnLoading(ebLongshot, true, '…')
  try {
    const firstFrame = await toPngDataUrl(core.exportScene())
    // 主进程收到后销毁遮罩窗并浮出长截图控制条
    await window.api.capture.startLongshot({
      pluginId: PLUGIN_ID,
      barPage: 'longshot-bar.html',
      pixelRect: selImg, appearance:core.state.appearance,
      rect: { x: sel.x, y: sel.y, w: sel.w, h: sel.h },
      firstFrame
    })
  } catch (err) {
    toast(`长截图启动失败：${err.message}`)
    busyAction = false
    setBtnLoading(ebLongshot, false)
  }
}

async function doOcr() {
  if (phase !== 'edit' || busyAction) return
  busyAction = true
  setBtnLoading(ebOcr, true, '识别中…')
  try {
    const input = aiImageInput(core.exportScene())
    const aiCfg = resolveAi(settings)
    let text
    if (visionReady(aiCfg)) {
      text = await visionChatResolved(aiCfg, { prompt: OCR_PROMPT, imageDataUrl: input })
    } else {
      text = await ocrLocal({ imageDataUrl: input, langs: settings.tesseractLangs })
    }
    lastOcr = String(text || '').trim()
    if (lastOcr) {
      showPanel('OCR 文字（可编辑）', lastOcr)
    } else {
      toast('未识别到文字')
    }
  } catch (err) {
    toast(`OCR 失败：${err.message}`)
  } finally {
    busyAction = false
    setBtnLoading(ebOcr, false)
  }
}

async function doRecognize() {
  if (phase !== 'edit' || busyAction) return
  const aiCfg = resolveAi(settings)
  if (!visionReady(aiCfg)) {
    toast('未配置识图模型：请在主窗口工具「设置 → AI 配置」中填写')
    return
  }
  busyAction = true
  setBtnLoading(ebRecognize, true, '识图中…')
  try {
    const input = aiImageInput(core.exportScene())
    const text = await visionChatResolved(aiCfg, { prompt: RECOGNIZE_PROMPT, imageDataUrl: input })
    showPanel('AI 识图结果', String(text || ''))
  } catch (err) {
    toast(`识图失败：${err.message}`)
  } finally {
    busyAction = false
    setBtnLoading(ebRecognize, false)
  }
}

// ---- 结果浮层 ----

function showPanel(title, text) {
  panelTitle.textContent = title
  panelOcr.value = text
  panelTrRow.classList.remove('show')
  panelTranslate.value = ''
  panel.style.display = 'flex'
  panel.classList.add('show')
}

function hidePanel() {
  panel.style.display = 'none'
  panel.classList.remove('show')
}

function panelVisible() {
  return panel.classList.contains('show')
}

panelCopy.addEventListener('click', async () => {
  const text = panelOcr.value.trim()
  if (!text) return
  await navigator.clipboard.writeText(text)
  toast('已复制')
})
panelTranslateBtn.addEventListener('click', async () => {
  const text = panelOcr.value.trim()
  if (!text) {
    toast('没有可翻译的文字')
    return
  }
  const aiCfg = resolveAi(settings)
  if (!chatReady(aiCfg)) {
    toast('未配置翻译模型：请在主窗口工具「设置 → AI 配置」中填写')
    return
  }
  setBtnLoading(panelTranslateBtn, true, '翻译中…')
  try {
    const out = await textChatResolved(aiCfg, {
      system: `你是专业翻译。把用户发来的内容翻译成${settings.targetLang}，只输出译文，保留原有排版。`,
      prompt: text
    })
    panelTrLabel.textContent = `翻译结果 → ${settings.targetLang}`
    panelTranslate.value = String(out || '')
    panelTrRow.classList.add('show')
  } catch (err) {
    toast(`翻译失败：${err.message}`)
  } finally {
    setBtnLoading(panelTranslateBtn, false)
  }
})
panelClose.addEventListener('click', hidePanel)

// ---- 提示 ----

function toast(msg) {
  toastEl.textContent = msg
  toastEl.style.display = 'block'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastEl.style.display = 'none'
  }, 2400)
}

function showToast(msg) {
  toastEl.textContent = msg
  toastEl.style.display = 'block'
}

// ---- 选择交互（select 态） ----

ui.addEventListener('mousedown', (e) => {
  if (phase !== 'select' || e.button !== 0) return
  dragging = true
  rect = { x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY }
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
    return
  }
  enterEdit()
})

ui.addEventListener('dblclick', () => {
  if (phase !== 'select') return
  selectAll()
})

// 标注画布接管指针事件（edit 态）
anno.addEventListener('dblclick', core.editSelectedText)
anno.addEventListener('pointerdown', e => { anno.focus({preventScroll:true}); core.onPointerDown(e) })
anno.addEventListener('pointermove', core.onPointerMove)
anno.addEventListener('pointerup', core.onPointerUp)
anno.addEventListener('pointercancel', core.onPointerUp)

// ---- 键盘 ----

window.addEventListener('keydown', (e) => {
  if (e.isComposing || busyAction || document.querySelector('.st-output-dialog[open]')) return
  if (e.key !== 'Escape' && e.target.closest?.('input,textarea,button,select')) return
  if (phase === 'select') {
    if (e.key === 'Enter') {
      selectAll()
    } else if (e.key === 'Escape') {
      void cancel()
    }
    return
  }
  if (phase !== 'edit') return
  if (core.state.textEditing) return // 文字输入框自行处理（已 stopPropagation，这里兜底）
  if (e.key === 'Escape') {
    if (core.state.pendingStep) { core.cancelDraft(); return }
    if (!geometry.hidden) { closeGeometry(); adjust.focus(); return }
    if (panelVisible()) {
      hidePanel()
      return
    }
    if (core.state.selectedId) {
      core.onKeydown(e)
      return
    }
    if (core.state.shapes.length && !escArmed) {
      escArmed = true
      toast('再按一次 Esc 放弃本次截图')
      return
    }
    void cancel()
    return
  }
  if (e.key === 'Enter') {
    void doCopy()
    return
  }
  core.onKeydown(e)
})

// ---- 动作按钮 ----

document.querySelector('#eb-output').onclick = () => {
  if (!busyAction) chooseAppearance(core.exportScene(),core.state.appearance,core.setAppearance)
}
ebCopy.addEventListener('click', doCopy)
ebSave.addEventListener('click', doSave)
ebPin.addEventListener('click', doPin)
ebOcr.addEventListener('click', doOcr)
ebRecognize.addEventListener('click', doRecognize)
ebLongshot.addEventListener('click', doLongshot)
ebReselect.addEventListener('click', reselect)
ebCancel.addEventListener('click', cancel)

// ---- 初始化 ----

async function init() {
  buildEditbar()
  settings = await loadWindowSettings(PLUGIN_ID)
  core.state.appearance = settings.appearance
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
  freezeC = document.createElement('canvas')
  freezeC.width = image.naturalWidth
  freezeC.height = image.naturalHeight
  freezeC.getContext('2d').drawImage(image, 0, 0)
  freeze.width = freezeC.width
  freeze.height = freezeC.height
  freeze.getContext('2d').drawImage(freezeC, 0, 0)
  initUiCanvas()
  phase = 'select'
  document.body.classList.add('ready')

}

document.querySelector('#btn-full').onclick = () => { if (phase === 'select') selectAll() }
document.querySelector('#btn-cancel').onclick = cancel
void init().catch(async err => {
  console.error('载入冻屏失败', err)
  await window.api.capture.cancelRegion()
})
