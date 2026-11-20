import { renderOutput } from './lib/shell.js'
import { canvasBytes } from './lib/history.js'
// 长截图控制条：由区域截图遮罩页经 capture:start-longshot 转场而来（主进程创建本窗口，
// 内容保护不进画面、focusable:false 不抢目标窗口焦点）。
// 流程：get-longshot-init 取选区与首帧 → 手动模式（用户滚动后点抓取）或
// 自动模式（循环：抓帧 → 拼接 → 无新内容自动停 → sendKey 翻页 → 等间隔）。
// 拼接复用 lib/stitch.js（行哈希重叠对齐）；完成动作：复制/保存/贴图/取消。

import { copyPng, loadImageToCanvas } from './lib/capture.js'
import { createStitcher } from './lib/stitch.js'
import { loadWindowSettings } from './lib/store.js'

const PLUGIN_ID = location.hostname // plugin://<id>/longshot-bar.html

const thumbEl = document.getElementById('thumb')
const statEl = document.getElementById('stat')
const hintEl = document.getElementById('hint')
const mManual = document.getElementById('m-manual')
const mAuto = document.getElementById('m-auto')
const btnGrab = document.getElementById('btn-grab')
const btnStart = document.getElementById('btn-start')
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
let grabbing = false
let mode = 'manual'
let generation = 0
let autoRunning = false
let done = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 设置（控制条页无 ctx，直接走插件 KV） ----


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
  btnGrab.disabled = on
  btnStart.disabled = on
  btnEdit.disabled = on || !window.api.capture.editLongshot
  btnDone.disabled = on
  btnSave.disabled = on
  btnPin.disabled = on
}

// ---- 抓帧与拼接 ----

async function grab() {
  if (grabbing) return { noNew: false, truncated: false }
  grabbing = true
  try {
    const frame = await window.api.capture.longshotFrame()
    if (!frame) throw new Error('控制条已失效')
    const c = await cropFrame(frame.dataUrl, frame.dpr)
    const r = stitcher.append(c)
    if (r.added) segments += 1
    updateStat()
    updateThumb()
    if (r.noNew) hint('画面与上一帧相同：先滚动目标窗口再抓取')
    return r
  } finally {
    grabbing = false
  }
}

// ---- 模式 ----

function setMode(m) {
  mode = m
  mManual.classList.toggle('is-active', m === 'manual')
  mAuto.classList.toggle('is-active', m === 'auto')
  btnGrab.classList.toggle('hidden', m !== 'manual')
  btnStart.classList.toggle('hidden', m !== 'auto')
  btnStop.classList.toggle('hidden', m !== 'auto')
  if (m === 'auto' && !autoRunning) {
    hint('将自动翻页抓帧：先点一下目标窗口让其保持前台，再点「开始滚动」')
  } else if (m === 'manual') {
    hint('滚动目标页面后点「抓取下一屏」；或切「自动」自动翻页抓帧')
  }
}

async function startAuto() {
  if (autoRunning) return
  autoRunning = true
  setBusy(true)
  btnStop.disabled = false
  hint('自动滚动中…（翻页键：' + scrollKeyLabel() + '）')
  const run = ++generation
  try {
    while (autoRunning && run === generation) {
      const sk = await window.api.capture.sendKey(settings.longshot.scrollKey)
      if (run !== generation) return
      if (!sk.ok) return stopAuto(sk.message || '自动翻页失败，已切回手动')
      await sleep(Math.max(300, Number(settings.longshot.intervalMs) || 800))
      if (run !== generation) return
      const r = await grab()
      if (run !== generation) return
      if (r.truncated) return stopAuto('已达长图尺寸上限，已停止')
      if (r.noNew) return stopAuto('没有新的画面，已停止自动滚动')
    }
  } catch (err) { if (run === generation) stopAuto(`抓帧失败：${err.message}`) }
}

function scrollKeyLabel() {
  return { down: '↓', pagedown: 'PageDown', space: '空格' }[settings.longshot.scrollKey] || settings.longshot.scrollKey
}

function stopAuto(msg) {
  generation++
  autoRunning = false
  setBusy(false)
  setMode('manual')
  if (msg) hint(msg)
}

// ---- 完成动作 ----

async function finish(action) {
  const source = stitcher?.result()
  if (done || grabbing || autoRunning || !source) return
  done = true; setBusy(true)
  try {
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
  generation++
  autoRunning = false
  try {
    await window.api.capture.cancelLongshot()
  } catch {
    /* 同上 */
  }
}

// ---- 事件 ----

mManual.addEventListener('click', () => {
  if (!autoRunning) setMode('manual')
})
mAuto.addEventListener('click', () => {
  if (!autoRunning) setMode('auto')
})
btnGrab.addEventListener('click', () => void grab().catch(err => hint(`抓帧失败：${err.message}`)))
btnStart.addEventListener('click', () => void startAuto())
btnStop.addEventListener('click', () => stopAuto('已停止自动滚动'))
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
  setBusy(false)
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
  setMode('manual')
}

void init()
