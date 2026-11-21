import { renderOutput } from './lib/shell.js'
import { canvasBytes } from './lib/history.js'
// 长截图控制条：由区域截图遮罩页经 capture:start-longshot 转场而来（主进程创建本窗口，
// 内容保护不进画面、focusable:false 不抢目标窗口焦点）。
import { copyPng, loadImageToCanvas } from './lib/capture.js'
import { createScrollSession } from './lib/scroll-session.js'
import { createStitcher } from './lib/stitch.js'
import { loadWindowSettings } from './lib/store.js'

const PLUGIN_ID = location.hostname // plugin://<id>/longshot-bar.html

const thumbEl = document.getElementById('thumb')
const statEl = document.getElementById('stat')
const hintEl = document.getElementById('hint')
const mManual = document.getElementById('m-manual')
const mAuto = document.getElementById('m-auto')
const btnStop = document.getElementById('btn-stop')
const btnEdit = document.getElementById('btn-edit')
let outputStyle
const btnDone = document.getElementById('btn-done')
const btnSave = document.getElementById('btn-save')
const btnPin = document.getElementById('btn-pin')
const btnCancel = document.getElementById('btn-cancel')

let settings = null
let pixelRect = null
let rect = null // 选区（屏幕逻辑坐标）
let stitcher = null
let segments = 0
let session = null
let done = false

// ---- 工具 ----

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解析失败'))
    img.src = dataUrl
  })
}

/** 整屏快照按选区裁剪（逻辑坐标 × dpr → 物理像素） */
async function cropFrame(dataUrl, frameDpr) {
  const img = await loadImage(dataUrl)
  const c = document.createElement('canvas')
  c.width = pixelRect?.w ?? Math.max(1, Math.round(rect.w * frameDpr))
  c.height = pixelRect?.h ?? Math.max(1, Math.round(rect.h * frameDpr))
  c.getContext('2d').drawImage(
    img,
    pixelRect?.x ?? Math.round(rect.x * frameDpr),
    pixelRect?.y ?? Math.round(rect.y * frameDpr),
    c.width,
    c.height,
    0,
    0,
    c.width,
    c.height
  )
  return c
}

function canvasToDataUrl(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('图片导出失败'))
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('读取图片失败'))
      fr.readAsDataURL(blob)
    }, type)
  })
}

function stampName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `Longshot_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`
}

function hint(msg) {
  hintEl.textContent = msg
  hintEl.title = msg
}

function updateStat() {
  const base = stitcher?.result()
  statEl.textContent = `${segments} 段 · 高 ${base ? base.height : 0}px`
}

function updateThumb() {
  const base = stitcher && stitcher.result()
  if (!base) return
  const scale = Math.min(1, 46 / base.height, 124 / base.width)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(base.width * scale))
  c.height = Math.max(1, Math.round(base.height * scale))
  const g = c.getContext('2d')
  g.imageSmoothingQuality = 'high'
  g.drawImage(base, 0, 0, c.width, c.height)
  void canvasToDataUrl(c, 'image/jpeg').then((url) => {
    thumbEl.src = url
  })
}

function setBusy(on) {
  mManual.disabled = mAuto.disabled = btnStop.disabled = on
  btnEdit.disabled = on || !window.api.capture.editLongshot
  btnDone.disabled = on
  btnSave.disabled = on
  btnPin.disabled = on
}

// ---- 抓帧与拼接 ----

async function grab() {
  const frame = await window.api.capture.longshotFrame()
  if (!frame) throw new Error('控制条已失效')
  const result = stitcher.append(await cropFrame(frame.dataUrl, frame.dpr))
  if (result.added) { segments++; updateStat(); updateThumb() }
  return result
}

function showMode(mode, message) {
  for (const [button, name] of [[mManual,'manual'], [mAuto,'auto'], [btnStop,'paused']]) {
    button.classList.toggle('is-active', mode === name)
    button.setAttribute('aria-pressed', String(mode === name))
  }
  hint(message || ({manual:'缓慢向下滚动目标页面，自动拼接', auto:'自动滚动并拼接中…', paused:'已暂停，可选择滚动方式继续'}[mode]))
}

// ---- 完成动作 ----

async function finish(action) {
  if (done || !session || !stitcher.result()) return
  const wasActive = session.mode !== 'paused'
  done = true; setBusy(true)
  try {
    await session.stop()
    // Include the last scroll even if the user finishes between polling ticks.
    if (wasActive) await grab().catch(() => {}) // Existing segments remain exportable.
    const source = stitcher.result()
    if (action === 'edit') {
      // Transfer the undecorated full image. Decorations remain editable in the workspace.
      await window.api.capture.editLongshot(await canvasToDataUrl(source))
      return
    }
    const out = renderOutput(source,outputStyle)
    if (action === 'save') {
      const r = await window.api.capture.saveFile({bytes:await canvasBytes(out),ext:'.png',dir:settings.saveDir || undefined,defaultName:stampName()})
      if (!r.saved) { hint('已取消保存'); return }
    } else if (action === 'copy') await copyPng(out)
    const dataUrl = await canvasToDataUrl(out)
    if (action === 'pin') await window.api.pin.show({pluginId:PLUGIN_ID,page:'pin.html',dataUrl,width:out.width,height:out.height})
    await window.api.capture.finishLongshot(dataUrl)
  } catch (err) { hint(`操作未完成：${err.message}`) }
  finally { done=false; setBusy(false) }
}

async function cancelAll() {
  if (done) return
  done = true
  void session?.stop()
  try {
    await window.api.capture.cancelLongshot()
  } catch (err) {
    done = false; hint(`取消失败：${err.message}`)
  }
}

// ---- 事件 ----

mManual.onclick = () => session?.switchTo('manual')
mAuto.onclick = () => session?.switchTo('auto')
btnStop.onclick = () => session?.switchTo('paused')
window.addEventListener('pagehide', () => { void session?.stop() })
btnEdit.addEventListener('click', () => void finish('edit'))
btnDone.addEventListener('click', () => void finish('copy'))
btnSave.addEventListener('click', () => void finish('save'))
btnPin.addEventListener('click', () => void finish('pin'))
btnCancel.addEventListener('click', () => void cancelAll())

// ---- 初始化 ----

async function init() {
  settings = await loadWindowSettings(PLUGIN_ID)
  const init = await window.api.capture.getLongshotInit()
  if (!init || !init.rect || !init.firstFrame) {
    // 异常流程：拿不到转场数据直接退出
    void cancelAll()
    return
  }
  outputStyle = init.appearance ?? settings.appearance
  pixelRect = init.pixelRect
  rect = init.rect
  stitcher = createStitcher()
  try {
    const first = await loadImageToCanvas(init.firstFrame)
    stitcher.append(first)
    segments = 1
  } catch (err) {
    hint(`首帧解析失败：${err.message}`)
    setBusy(true)
    return
  }
  updateStat()
  updateThumb()
  session = createScrollSession({capture:grab, sendKey:() => window.api.capture.sendKey(settings.longshot.scrollKey),
    interval:Math.min(5000, Math.max(300, Number(settings.longshot.intervalMs) || 800)), onMode:showMode,
    onResult:r => { if (r.unmatched) hint('缺少重叠；请向上滚回上一段，再缓慢向下滚动'); else if (r.added) hint('已拼接，可继续向下滚动') },
    onError:err => hint(`抓帧失败，已暂停：${err.message}`)})
  setBusy(false)
  session.switchTo('manual')
}

setBusy(true)
void init().catch(err => hint(`无法开始长截图：${err.message}`))
