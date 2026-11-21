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
const shade = document.getElementById('shade')
const shadeParts = {
  t: document.getElementById('shade-t'),
  b: document.getElementById('shade-b'),
  l: document.getElementById('shade-l'),
  r: document.getElementById('shade-r')
}
const selbox = document.getElementById('selbox')
const selsize = document.getElementById('selsize')
const magnifier = document.getElementById('magnifier')
const magCanvas = document.getElementById('mag-canvas')
const magColor = document.getElementById('mag-color')
const magXy = document.getElementById('mag-xy')
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

// ---- 遮罩与选区（DOM 分层：拖动只改几何样式，GPU 合成，无 canvas 重绘） ----

function initUiCanvas() {
  sx = freezeC.width / window.innerWidth
  sy = freezeC.height / window.innerHeight
}

function normSel(r) {
  const x = Math.min(r.x1, r.x2)
  const y = Math.min(r.y1, r.y2)
  return { x, y, w: Math.abs(r.x2 - r.x1), h: Math.abs(r.y2 - r.y1) }
}

/** 当前选区（屏幕逻辑坐标），select 态用拖拽 rect，edit 态用 sel */
function currentRect() {
  if (phase === 'edit') return sel
  if (phase === 'select' && rect) return normSel(rect)
  return null
}

/** 把遮罩四块 + 选区框 + 尺寸标签同步到 DOM（纯样式变更，交给合成器） */
function syncSelectionDom() {
  const r = currentRect()
  const W = window.innerWidth
  const H = window.innerHeight
  if (!r || r.w < 1 || r.h < 1) {
    // 无选区：整屏压暗
    setShadeRect(0, 0, W, H)
    selbox.style.display = 'none'
    selsize.style.display = 'none'
    return
  }
  const x = Math.round(r.x)
  const y = Math.round(r.y)
  const w = Math.round(r.w)
  const h = Math.round(r.h)
  setShadeRect(x, y, w, h)
  selbox.style.display = 'block'
  selbox.style.left = `${x}px`
  selbox.style.top = `${y}px`
  selbox.style.width = `${w}px`
  selbox.style.height = `${h}px`
  const label = `${Math.round(w * sx)} × ${Math.round(h * sy)}`
  if (selsize.textContent !== label) selsize.textContent = label
  selsize.style.display = 'block'
  const lw = selsize.offsetWidth || 90
  const lx = Math.max(4, Math.min(x + w / 2 - lw / 2, W - lw - 4))
  const ly = y > 30 ? y - 26 : y + h + 8
  selsize.style.left = `${lx}px`
  selsize.style.top = `${ly}px`
}

function setShadeRect(x, y, w, h) {
  const W = window.innerWidth
  const H = window.innerHeight
  const st = shadeParts.t.style
  const sb = shadeParts.b.style
  const sl = shadeParts.l.style
  const sr = shadeParts.r.style
  st.left = '0px'; st.top = '0px'; st.width = W + 'px'; st.height = y + 'px'
  sb.left = '0px'; sb.top = (y + h) + 'px'; sb.width = W + 'px'; sb.height = Math.max(0, H - y - h) + 'px'
  sl.left = '0px'; sl.top = y + 'px'; sl.width = x + 'px'; sl.height = h + 'px'
  sr.left = (x + w) + 'px'; sr.top = y + 'px'; sr.width = Math.max(0, W - x - w) + 'px'; sr.height = h + 'px'
}

// ---- 放大镜（select 态跟随光标：9×9 源像素 → 11 倍网格 + 坐标 + 颜色） ----

const MAG_SRC = 9 // 取样半径内的源像素边长
let magHex = '#000000'
let magnifierForced = localStorage.getItem('st-magnifier') !== 'off'

function updateMagnifier(cx, cy) {
  if (phase !== 'select' || !magnifierForced) {
    magnifier.style.display = 'none'
    return
  }
  const px = Math.min(freezeC.width - 1, Math.max(0, Math.floor(cx * sx)))
  const py = Math.min(freezeC.height - 1, Math.max(0, Math.floor(cy * sy)))
  // 取样窗夹紧到图像内（避免边缘透明洞）
  const sx0 = Math.max(0, Math.min(freezeC.width - MAG_SRC, px - 4))
  const sy0 = Math.max(0, Math.min(freezeC.height - MAG_SRC, py - 4))
  const g = magCanvas.getContext('2d')
  g.imageSmoothingEnabled = false
  g.clearRect(0, 0, magCanvas.width, magCanvas.height)
  g.drawImage(freezeC, sx0, sy0, MAG_SRC, MAG_SRC, 0, 0, magCanvas.width, magCanvas.height)
  // 中心像素高亮框（11 倍放大：每源像素 11px）
  g.strokeStyle = 'rgba(255,255,255,0.9)'
  g.lineWidth = 1
  g.strokeRect((px - sx0) * 11 + 0.5, (py - sy0) * 11 + 0.5, 10, 10)
  const d = freezeC.getContext('2d').getImageData(px, py, 1, 1).data
  magHex = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')
  magColor.style.background = magHex
  magXy.textContent = `${px}, ${py}`
  // 光标偏移摆放，靠边翻转
  const mw = magnifier.offsetWidth || 120
  const mh = magnifier.offsetHeight || 140
  let mx = cx + 20
  let my = cy + 20
  if (mx + mw > window.innerWidth - 6) mx = cx - mw - 20
  if (my + mh > window.innerHeight - 6) my = cy - mh - 20
  magnifier.style.left = `${Math.max(4, mx)}px`
  magnifier.style.top = `${Math.max(4, my)}px`
  magnifier.style.display = 'block'
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
  // 记住本次选区（R 键可回到上次框选位置，同 PixPin 选区历史）
  try {
    localStorage.setItem('st-last-sel', JSON.stringify({ x: sel.x, y: sel.y, w: sel.w, h: sel.h }))
  } catch { /* 隐私模式等场景忽略 */ }
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
  syncSelectionDom()
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
  syncSelectionDom()
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

// ---- 选择交互（select 态；事件挂在遮罩上，rAF 节流几何更新） ----

let rafPending = false
let lastPointer = null

function scheduleSync(cx, cy) {
  lastPointer = [cx, cy]
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    syncSelectionDom()
    if (lastPointer) updateMagnifier(lastPointer[0], lastPointer[1])
  })
}

shade.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  if (phase === 'edit') {
    // 编辑态点选区外 = 重新框选
    reselect()
    return
  }
  if (phase !== 'select') return
  dragging = true
  rect = { x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY }
  scheduleSync(e.clientX, e.clientY)
})

shade.addEventListener('mousemove', (e) => {
  if (dragging) {
    rect.x2 = Math.max(0, Math.min(e.clientX, window.innerWidth))
    rect.y2 = Math.max(0, Math.min(e.clientY, window.innerHeight))
  }
  scheduleSync(e.clientX, e.clientY)
})

window.addEventListener('mouseup', () => {
  if (!dragging) return
  dragging = false
  const w = Math.abs(rect.x2 - rect.x1)
  const h = Math.abs(rect.y2 - rect.y1)
  if (w < 6 || h < 6) {
    rect = null
    syncSelectionDom()
    return
  }
  magnifier.style.display = 'none'
  enterEdit()
})

shade.addEventListener('dblclick', () => {
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

/** 回到上次框选位置（PixPin 选区历史） */
function applyLastSelection() {
  if (phase !== 'select') return
  try {
    const s = JSON.parse(localStorage.getItem('st-last-sel') || 'null')
    if (!s || s.w < 6 || s.h < 6) return
    const W = window.innerWidth
    const H = window.innerHeight
    rect = {
      x1: Math.max(0, Math.min(s.x, W - 6)),
      y1: Math.max(0, Math.min(s.y, H - 6)),
      x2: Math.max(6, Math.min(s.x + s.w, W)),
      y2: Math.max(6, Math.min(s.y + s.h, H))
    }
    magnifier.style.display = 'none'
    enterEdit()
  } catch { /* 忽略坏数据 */ }
}

/** F5 重抓冻屏（选区保持，标注前的内容刷新） */
async function refreshFrozenScreen() {
  if (phase !== 'select') return
  try {
    const dataUrl = await window.api.capture.refreshOverlay()
    if (!dataUrl) return
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
    if (lastPointer) updateMagnifier(lastPointer[0], lastPointer[1])
    toast('画面已刷新')
  } catch (err) {
    toast(`刷新失败：${err.message}`)
  }
}

window.addEventListener('keydown', (e) => {
  if (e.isComposing || busyAction || document.querySelector('.st-output-dialog[open]')) return
  if (e.key !== 'Escape' && e.target.closest?.('input,textarea,button,select')) return
  // Space 按住暂时隐藏所有浮层，查看被遮挡的内容（PixPin 行为）
  if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    document.body.classList.add('peek')
    e.preventDefault()
    return
  }
  if (e.key === 'Alt' && phase === 'select') {
    magnifierForced = !magnifierForced
    try { localStorage.setItem('st-magnifier', magnifierForced ? 'on' : 'off') } catch {}
    if (lastPointer) scheduleSync(lastPointer[0], lastPointer[1])
    return
  }
  if (phase === 'select') {
    if (e.key === 'Enter') {
      selectAll()
    } else if (e.key === 'Escape') {
      void cancel()
    } else if (e.key === 'F5') {
      e.preventDefault()
      void refreshFrozenScreen()
    } else if (e.key === 'r' || e.key === 'R') {
      applyLastSelection()
    } else if ((e.key === 'c' || e.key === 'C') && magnifier.style.display === 'block') {
      navigator.clipboard.writeText(magHex).then(() => toast(`已复制颜色 ${magHex}`)).catch(() => {})
    }
    return
  }
  if (phase !== 'edit') return
  if (core.state.textEditing) return // 文字输入框自行处理（已 stopPropagation，这里兜底）
  const mod = e.ctrlKey || e.metaKey
  if (mod && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    void doSave()
    return
  }
  if (mod && (e.key === 't' || e.key === 'T')) {
    e.preventDefault()
    void doPin()
    return
  }
  if (e.key === 'F5') {
    e.preventDefault()
    toast('已开始标注，刷新仅在框选阶段可用')
    return
  }
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

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') document.body.classList.remove('peek')
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
