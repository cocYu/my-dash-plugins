// 标注编辑器：底图 + 标注对象列表（矢量描述，导出时整场景重绘）。
// 工具：选择(移动)/画笔/高亮/直线/箭头/矩形/椭圆/文字/步骤序号/马赛克。
// 撤销重做、选中移动（Delete 删除）、步骤序号自动递增。
// 所有形状坐标均为底图像素坐标，显示缩放只在交互换算层处理。
//
// 分层：createEditorCore() 是框架无关的交互与渲染核心（纯状态 + 命令式 API），
// createEditor() 是主窗工作台用的 Vue 薄壳（工具栏 UI）；截图遮罩页（overlay.js）
// 直接驱动核心，保证两处标注行为一致。

import { drawStep, stepBounds, captionBox } from './step.js'
import { mountInspector } from './inspector.js'
import { appearance, renderOutput } from './shell.js'
import { canvasBytes } from './history.js'

let shapeSeq = 0
const genShapeId = () => `sh-${Date.now().toString(36)}-${(shapeSeq++).toString(36)}`

export const TOOLS = [
  { id: 'select', name: '选择 / 移动', glyph: '移动' },
  { id: 'pen', name: '画笔', glyph: '✎' },
  { id: 'highlight', name: '高亮', glyph: '✏' },
  { id: 'line', name: '直线', glyph: '╱' },
  { id: 'arrow', name: '箭头', glyph: '➤' },
  { id: 'rect', name: '矩形', glyph: '▭' },
  { id: 'ellipse', name: '椭圆', glyph: '◯' },
  { id: 'text', name: '文字', glyph: 'T' },
  { id: 'step', name: '步骤', glyph: '①' },
  { id: 'mosaic', name: '马赛克', glyph: '▩' }
]

export function createEditorState() {
  return {
    version: 0, // 兼容字段：旧版靠它建立响应依赖，现由 onChange 通知替代
    shapes: [],
    undo: [],
    redo: [],
    tool: 'pen',
    color: '#e64545',
    size: 4,
    fontSize: 20, block: 12,
    selectedId: null,
    textEditing: null, // {x, y, value}
    boundId: null, // 绑定的历史记录 id
    dirty: false,
    nextStep: 1,
    stepSize: 26, stepText: false, pendingStep: null, appearance: appearance(),
    width: 0,
    height: 0
  }
}

const textFont = s => `600 ${s.size}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`

function normRect(s) {
  const x = Math.min(s.x1, s.x2)
  const y = Math.min(s.y1, s.y2)
  const w = Math.abs(s.x2 - s.x1)
  const h = Math.abs(s.y2 - s.y1)
  return { x, y, w, h }
}

function shapeBBox(s, g) {
  const slack = s.type === 'highlight' ? s.size * 3 + 6 : (s.size || 4) + 6
  switch (s.type) {
    case 'pen':
    case 'highlight': {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [x, y] of s.points) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      return { x: minX - slack, y: minY - slack, w: maxX - minX + slack * 2, h: maxY - minY + slack * 2 }
    }
    case 'line':
    case 'arrow':
    case 'rect':
    case 'ellipse':
    case 'mosaic': {
      const r = s.type === 'mosaic' ? { x: s.x, y: s.y, w: s.w, h: s.h } : normRect(s)
      return { x: r.x - slack, y: r.y - slack, w: r.w + slack * 2, h: r.h + slack * 2 }
    }
    case 'text': {
      const lines = String(s.text).split('\n')
      g.save(); g.font = textFont(s)
      const w = Math.max(...lines.map(l => g.measureText(l).width)) + 8
      g.restore()
      const h = lines.length * s.size * 1.5 + 8
      return { x: s.x - 4, y: s.y - 4, w, h }
    }
    case 'step':
      return stepBounds(s)
    default:
      return { x: 0, y: 0, w: 0, h: 0 }
  }
}

function hitTest(shapes, x, y, g) {
  const inside = b => x >= b.x && x <= b.x+b.w && y >= b.y && y <= b.y+b.h
  const near = (ax,ay,bx,by,tolerance) => {
    const dx=bx-ax, dy=by-ay
    const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy || 1)))
    return Math.hypot(x-ax-t*dx, y-ay-t*dy) <= tolerance
  }
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i]
    if (!inside(shapeBBox(s,g))) continue
    if (s.type === 'line' || s.type === 'arrow') {
      if (near(s.x1,s.y1,s.x2,s.y2,5+s.size/2)) return s
    } else if (s.type === 'pen' || s.type === 'highlight') {
      if (s.points.some(([px,py],j) => j && near(...s.points[j-1],px,py,5+s.size*(s.type === 'pen' ? .5 : 3)))) return s
    } else if (s.type === 'step') {
      if (Math.hypot(x-s.x,y-s.y) <= s.diameter/2+3 || (s.box && (inside(s.box) || near(s.x,s.y,s.tx,s.ty,5)))) return s
    } else return s
  }
  return null
}

function translateShape(s, dx, dy) {
  switch (s.type) {
    case 'pen':
    case 'highlight':
      s.points = s.points.map(([x, y]) => [x + dx, y + dy])
      break
    case 'line':
    case 'arrow':
    case 'rect':
    case 'ellipse':
      s.x1 += dx
      s.y1 += dy
      s.x2 += dx
      s.y2 += dy
      break
    case 'mosaic':
      s.x += dx
      s.y += dy
      break
    case 'step':
      if (s.box) { s.box.x += dx; s.box.y += dy; s.tx += dx; s.ty += dy }
      s.x += dx; s.y += dy; break
    case 'text':
      s.x += dx
      s.y += dy
      break
  }
}

// ---- 场景绘制（编辑预览与导出共用） ----

function drawMosaicShape(g, base, s) {
  const block = Math.max(4, s.block || 12)
  const tmp = document.createElement('canvas')
  tmp.width = Math.max(1, Math.round(s.w / block))
  tmp.height = Math.max(1, Math.round(s.h / block))
  const tg = tmp.getContext('2d')
  tg.drawImage(base, s.x, s.y, s.w, s.h, 0, 0, tmp.width, tmp.height)
  g.save()
  roundRectPath(g, s.x, s.y, s.w, s.h, 4)
  g.clip()
  g.imageSmoothingEnabled = false
  g.drawImage(tmp, s.x, s.y, s.w, s.h)
  g.restore()
}

function strokePolyline(g, s) {
  g.beginPath()
  s.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
  g.stroke()
}

function drawArrowHead(g, s) {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1)
  const len = Math.max(10, s.size * 3.5)
  g.beginPath()
  g.moveTo(s.x2, s.y2)
  g.lineTo(s.x2 - len * Math.cos(angle - Math.PI / 7), s.y2 - len * Math.sin(angle - Math.PI / 7))
  g.lineTo(s.x2 - len * Math.cos(angle + Math.PI / 7), s.y2 - len * Math.sin(angle + Math.PI / 7))
  g.closePath()
  g.fillStyle = s.color
  g.fill()
}

function drawShape(g, s, base, draft = false) {
  g.save()
  if (draft) g.globalAlpha = 0.85
  switch (s.type) {
    case 'pen':
      g.strokeStyle = s.color
      g.lineWidth = s.size
      g.lineCap = 'round'
      g.lineJoin = 'round'
      strokePolyline(g, s)
      break
    case 'highlight':
      g.strokeStyle = s.color
      g.lineWidth = s.size * 6
      g.lineCap = 'round'
      g.lineJoin = 'round'
      g.globalAlpha = draft ? 0.3 : 0.38
      strokePolyline(g, s)
      break
    case 'line':
      g.strokeStyle = s.color
      g.lineWidth = s.size
      g.lineCap = 'round'
      g.beginPath()
      g.moveTo(s.x1, s.y1)
      g.lineTo(s.x2, s.y2)
      g.stroke()
      break
    case 'arrow':
      g.strokeStyle = s.color
      g.lineWidth = s.size
      g.lineCap = 'round'
      g.beginPath()
      g.moveTo(s.x1, s.y1)
      g.lineTo(s.x2, s.y2)
      g.stroke()
      drawArrowHead(g, s)
      break
    case 'rect': {
      const r = normRect(s)
      g.strokeStyle = s.color
      g.lineWidth = s.size
      if (s.fill) {
        g.globalAlpha = 0.25
        g.fillStyle = s.color
        g.fillRect(r.x, r.y, r.w, r.h)
        g.globalAlpha = draft ? 0.85 : 1
      }
      g.strokeRect(r.x, r.y, r.w, r.h)
      break
    }
    case 'ellipse': {
      const r = normRect(s)
      g.strokeStyle = s.color
      g.lineWidth = s.size
      g.beginPath()
      g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2)
      if (s.fill) {
        g.globalAlpha = 0.25
        g.fillStyle = s.color
        g.fill()
        g.globalAlpha = draft ? 0.85 : 1
      }
      g.stroke()
      break
    }
    case 'text': {
      g.fillStyle = s.color
      g.font = textFont(s)
      g.textBaseline = 'top'
      const lines = String(s.text).split('\n')
      lines.forEach((line, i) => g.fillText(line, s.x, s.y + i * s.size * 1.5))
      break
    }
    case 'step': drawStep(g,s); break
    case 'mosaic':
      if (base) drawMosaicShape(g, base, s)
      break
  }
  g.restore()
}

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

/** 整场景渲染：底图 + 马赛克（先） + 其余形状（后） + 选中框 */
export function renderScene(g, base, shapes, selectedId = null) {
  g.clearRect(0, 0, g.canvas.width, g.canvas.height)
  if (!base) return
  g.drawImage(base, 0, 0)
  for (const s of shapes) {
    if (s.type === 'mosaic') drawShape(g, s, base)
  }
  for (const s of shapes) {
    if (s.type !== 'mosaic') drawShape(g, s, base)
  }
  if (selectedId) {
    const sel = shapes.find((s) => s.id === selectedId)
    if (sel) {
      const b = shapeBBox(sel, g)
      g.save()
      g.strokeStyle = '#1971c2'
      g.lineWidth = 1.5
      g.setLineDash([6, 4])
      g.strokeRect(b.x, b.y, b.w, b.h)
      g.restore()
    }
  }
}

// ---- 框架无关交互核心 ----

/**
 * 创建标注编辑核心。onChange 在任何影响视图/工具栏的状态变化后被调用
 * （壳层用它触发重渲染；canvas 重绘由核心内部的 rAF 自己完成）。
 */
export function createEditorCore({ onChange } = {}) {
  const state = createEditorState()
  let baseCanvas = null // HTMLCanvasElement，经 load() 更新
  let canvasEl = null
  let draft = null // 进行中的形状
  let moving = null // { shape, startX, startY }
  let rafPending = false

  const notify = () => {
    if (onChange) onChange()
  }
  const bump = () => { notify(); scheduleRedraw() }

  const redraw = () => {
    if (!canvasEl || !baseCanvas) return
    const g = canvasEl.getContext('2d')
    const transient = draft || state.pendingStep
    const shapes = transient ? [...state.shapes, transient] : state.shapes
    renderScene(g, baseCanvas, shapes, state.selectedId)
  }

  const scheduleRedraw = () => {
    if (rafPending) return
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      redraw()
    })
  }

  const toImageCoords = (e) => {
    const rect = canvasEl.getBoundingClientRect()
    return [(e.clientX - rect.left) * state.width/rect.width, (e.clientY - rect.top) * state.height/rect.height]
  }

  // 形状数组快照共享不可变的笔迹；移动时仅复制被移动的形状。
  const checkpoint = () => {
    state.undo.push(state.shapes.slice())
    if (state.undo.length > 100) state.undo.shift()
    state.redo = []
  }
  const commit = (shape) => {
    checkpoint()
    state.shapes.push(shape)
    state.redo = []
    state.dirty = true
    state.selectedId = null
    bump()
  }

  const updateNextStep = () => {
    let maxN = 0
    for (const s of state.shapes) if (s.type === 'step') maxN = Math.max(maxN, s.n)
    state.nextStep = maxN + 1
  }

  const onPointerDown = (e) => {
    if (!baseCanvas || state.textEditing || e.button !== 0) return
    e.preventDefault()
    const [x, y] = toImageCoords(e)
    try { canvasEl.setPointerCapture?.(e.pointerId) } catch { /* 合成事件无活动指针 */ }
    const t = state.tool
    const common = { id: genShapeId(), color: state.color, size: state.size }
    if (t === 'select') {
      const hit = hitTest(state.shapes, x, y, canvasEl.getContext('2d'))
      state.selectedId = hit ? hit.id : null
      if (hit) moving = { shape: hit, startX: x, startY: y, moved: false }
      bump()
      return
    }
    if (t === 'step') {
      const step = { ...common, type: 'step', x, y, n: state.nextStep, diameter:state.stepSize }
      if (!state.stepText) { commit(step); updateNextStep() }
      else if (!state.pendingStep) { state.pendingStep = { ...step, tx:x, ty:y }; bump() }
      else {
        Object.assign(state.pendingStep, {tx:x,ty:y})
        state.textEditing = {x,y,value:'',step:true}; bump()
      }
      return
    }
    if (t === 'text') {
      state.textEditing = { x, y, value: '' }
      bump()
      return
    }
    if (t === 'pen' || t === 'highlight') {
      draft = { ...common, type: t, points: [[x, y]] }
    } else if (t === 'mosaic') {
      draft = { ...common, type: 'mosaic', x, y, w: 0, h: 0, block: state.block, x1: x, y1: y }
    } else {
      draft = { ...common, type: t, x1: x, y1: y, x2: x, y2: y }
    }
    scheduleRedraw()
  }

  const onPointerMove = (e) => {
    if (!baseCanvas) return
    if (state.pendingStep && !state.textEditing) {
      const [tx,ty] = toImageCoords(e); Object.assign(state.pendingStep,{tx,ty}); scheduleRedraw(); return
    }
    if (moving) {
      const [x, y] = toImageCoords(e)
      if (moving.startX === x && moving.startY === y) return
      if (!moving.moved) {
        checkpoint()
        const i = state.shapes.indexOf(moving.shape)
        moving.shape = structuredClone(moving.shape)
        state.shapes[i] = moving.shape
      }
      translateShape(moving.shape, x - moving.startX, y - moving.startY)
      moving.startX = x
      moving.startY = y
      moving.moved = true
      state.dirty = true
      scheduleRedraw()
      return
    }
    if (!draft) return
    const [x, y] = toImageCoords(e)
    if (draft.type === 'pen' || draft.type === 'highlight') {
      draft.points.push([x, y])
    } else if (draft.type === 'mosaic') {
      draft.x2 = x
      draft.y2 = y
      draft.x = Math.min(draft.x1, x)
      draft.y = Math.min(draft.y1, y)
      draft.w = Math.abs(x - draft.x1)
      draft.h = Math.abs(y - draft.y1)
    } else {
      draft.x2 = x
      draft.y2 = y
    }
    scheduleRedraw()
  }

  const onPointerUp = () => {
    if (moving) {
      if (moving.moved) state.dirty = true
      moving = null
      bump()
      return
    }
    if (!draft) return
    const d = draft
    draft = null
    if (d.type === 'pen' || d.type === 'highlight') {
      if (d.points.length > 1) commit(d)
      else bump()
      return
    }
    if (d.type === 'mosaic') {
      if (d.w >= 6 && d.h >= 6) {
        delete d.x1
        delete d.y1
        commit(d)
      } else bump()
      return
    }
    const w = Math.abs(d.x2 - d.x1)
    const h = Math.abs(d.y2 - d.y1)
    if (d.type === 'rect' || d.type === 'ellipse') {
      if (w >= 4 || h >= 4) commit(d)
      else bump()
      return
    }
    if (d.type === 'line' || d.type === 'arrow') {
      if (w >= 6 || h >= 6) commit(d)
      else bump()
      return
    }
  }

  const selected = () => state.shapes.find(s => s.id === state.selectedId)
  // Only the selected object changes; new-tool preferences remain independent.
  const properties = () => {
    const shape = selected(), type = shape?.type ?? state.tool
    if (type === 'select') return {}
    const [label,key,pref,min,max] = type === 'text' ? ['字号','size','fontSize',12,128]
      : type === 'step' ? ['编号直径','diameter','stepSize',12,128]
      : type === 'mosaic' ? ['颗粒','block','block',4,64] : ['粗细','size','size',1,20]
    return {type,label,key,pref,min,max,value:shape?.[key] ?? state[pref],color:type === 'mosaic' ? null : shape?.color ?? state.color}
  }
  const changeProperty = (key, pref, value) => {
    const shape = selected()
    if (!shape) { state[pref] = value; bump(); return }
    if (shape[key] === value) return
    const changed = { ...shape, [key]:value }
    if (changed.box && (key === 'text' || key === 'diameter')) {
      changed.box = captionBox(canvasEl.getContext('2d'), changed, state.width, state.height)
    }
    checkpoint(); state.shapes[state.shapes.indexOf(shape)] = changed; state.dirty = true; bump()
  }
  const setMeasure = value => {
    const p = properties()
    if (p.key && Number.isFinite(value)) changeProperty(p.key,p.pref,Math.min(p.max,Math.max(p.min,Math.round(value))))
  }
  const setColor = color => {
    if (properties().color && /^#[0-9a-f]{6}$/i.test(color)) changeProperty('color','color',color.toLowerCase())
  }
  const editSelectedText = () => {
    const s = selected(); if (!s || !(s.type === 'text' || s.box)) return
    state.textEditing = {id:s.id, x:s.box?.x ?? s.x, y:s.box?.y ?? s.y, value:s.text, step:s.type === 'step'}; bump()
  }
  /** 提交进行中的文字输入（Enter/失焦时由壳层调用） */
  const commitText = () => {
    const t = state.textEditing
    state.textEditing = null
    if (t?.id) {
      if (selected()?.id === t.id && t.value.trim()) changeProperty('text',null,t.value)
      bump(); return
    }
    if (t?.step && state.pendingStep) {
      const step = state.pendingStep; state.pendingStep = null
      if (!t.value.trim()) { bump(); return }
      step.text = t.value.trim()
      step.box = captionBox(canvasEl.getContext('2d'),step,state.width,state.height)
      commit(step); updateNextStep(); return
    }
    if (t && t.value.trim()) {
      commit({ id: genShapeId(), type: 'text', x: t.x, y: t.y, text: t.value, color: state.color, size: state.fontSize })
    } else {
      bump()
    }
  }

  const cancelDraft = () => { state.pendingStep=null; state.textEditing=null; bump() }
  const selectTool = tool => { state.tool=tool; state.selectedId=null; cancelDraft() }
  const restore = (from, to) => {
    if (state.pendingStep) { cancelDraft(); return }
    if (!from.length) return
    to.push(state.shapes.slice())
    state.shapes = from.pop()
    state.selectedId = null
    state.dirty = true
    updateNextStep()
    bump()
  }
  const undo = () => restore(state.undo, state.redo)
  const redoFn = () => restore(state.redo, state.undo)

  const clearShapes = () => {
    if (!state.shapes.length) return
    checkpoint()
    state.shapes = []
    state.selectedId = null
    state.dirty = true
    updateNextStep()
    bump()
  }

  const removeSelected = () => {
    if (!state.selectedId) return
    checkpoint()
    state.shapes = state.shapes.filter((s) => s.id !== state.selectedId)
    state.selectedId = null
    state.dirty = true
    updateNextStep()
    bump()
  }

  const onKeydown = (e) => {
    const tag = e.target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (!baseCanvas) return
    const offsets = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]}
    if (selected() && offsets[e.key] && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); const shape = selected(), changed = structuredClone(shape)
      const [dx,dy] = offsets[e.key], step = e.shiftKey ? 10 : 1
      translateShape(changed, dx*step, dy*step); checkpoint()
      state.shapes[state.shapes.indexOf(shape)] = changed; state.dirty = true; bump(); return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedId) {
        e.preventDefault()
        removeSelected()
      }
    } else if (e.key === 'Escape') {
      if (state.pendingStep) { cancelDraft(); return }
      state.selectedId = null
      if (state.textEditing) {
        state.textEditing = null
        bump()
      } else bump()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redoFn()
      else undo()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redoFn()
    }
  }

  /** 绑定显示画布（尺寸与底图一致；壳层在 DOM 挂载/更新后调用） */
  const attach = (el) => {
    canvasEl = el
    if (el && baseCanvas) {
      el.width = state.width
      el.height = state.height
      redraw()
    }
  }

  const detach = () => {
    canvasEl = null
  }

  /** 载入底图（清空标注）；canvasEl 已绑定时立即重绘 */
  const load = (canvas, meta = {}) => {
    baseCanvas = canvas
    state.width = canvas.width
    state.height = canvas.height
    state.appearance = appearance(meta.appearance)
    state.pendingStep = null
    state.shapes = []
    state.undo = []
    state.redo = []
    state.selectedId = null
    state.textEditing = null
    state.dirty = false
    state.boundId = meta.boundId ?? null
    draft = null
    moving = null
    updateNextStep()
    bump()
    if (canvasEl) {
      canvasEl.width = canvas.width
      canvasEl.height = canvas.height
      redraw()
    }
  }

  const exportScene = () => {
    if (!baseCanvas) return null
    const out = document.createElement('canvas')
    out.width = state.width
    out.height = state.height
    renderScene(out.getContext('2d'), baseCanvas, state.shapes, null)
    return out
  }

  const exportCanvas = () => {
    const scene = exportScene()
    return scene && renderOutput(scene,state.appearance)
  }
  const setAppearance = value => { state.appearance=appearance(value); state.dirty=true; bump() }
  const exportBytes = async () => {
    const canvas = exportCanvas()
    return canvas ? await canvasBytes(canvas) : null
  }

  return {
    state,
    attach,
    detach,
    load,
    redraw,
    scheduleRedraw,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeydown,
    undo,
    redo: redoFn,
    clearShapes,
    removeSelected,
    get selected() { return selected() }, get properties() { return properties() },
    setColor, setMeasure, editSelectedText, commitText, cancelDraft, selectTool, setAppearance, exportScene,
    exportCanvas,
    exportBytes,
    get isEmpty() {
      return !baseCanvas
    },
    get isDirty() {
      return state.dirty
    },
    get boundId() {
      return state.boundId
    }
  }
}

// ---- Vue 薄壳（主窗工作台用） ----

export function createEditor(bundle) {
  const { vue, ui } = bundle
  const { h, ref, defineComponent, nextTick, onBeforeUnmount } = vue
  const { ElButton, ElTooltip } = ui

  const version = ref(0)
  const trigger = () => { version.value++ }
  const core = createEditorCore({ onChange: () => trigger() })

  const toolBtn = (t) =>
    h(
      ElTooltip,
      { content: t.name, placement: 'top', showAfter: 400 },
      {
        default: () =>
          h(
            'button',
            {
              'aria-label': t.name, 'aria-pressed': core.state.tool === t.id,
              class: ['st-ed-tool', core.state.tool === t.id ? 'is-active' : ''],
              onClick: () => {
                core.selectTool(t.id)
              }
            },
            t.glyph
          ),
      }
    )

  const component = defineComponent({
    name: 'ScreenshotEditor',
    setup() {
      let syncInspector
      // 生命周期必须在 setup() 内注册（工厂函数体里没有组件实例）
      onBeforeUnmount(() => {
        core.detach()
      })
      const setCanvas = (el) => {
        core.attach(el)
      }
      return () => {
        void version.value // 命令式变更后触发重渲染
        const s = core.state
        const hasBase = !core.isEmpty
        return h('div', { class: 'st-editor', onKeydown:core.onKeydown }, [
          // 工具栏
          h('div', { class: 'st-ed-bar' }, [
            h('div', { class: 'st-ed-tools' }, TOOLS.map(toolBtn)),
            h('div', { class: 'st-ed-sep' }),
            h('div', { onVnodeMounted:v => { syncInspector = mountInspector(v.el, core) }, onVnodeUpdated:() => syncInspector?.() }),
            h(ElButton, { size: 'small', disabled: !s.undo.length, onClick: core.undo }, () => '撤销'),
            h(ElButton, { size: 'small', disabled: !s.redo.length, onClick: core.redo }, () => '重做'),
            h(
              ElButton,
              { size: 'small', type: 'danger', plain: true, disabled: !s.selectedId, onClick: core.removeSelected },
              () => '删除选中'
            ),
            h(ElButton, { size: 'small', disabled: !s.shapes.length, onClick: core.clearShapes }, () => '清空标注')
          ]),
          // 画布区
          h(
            'div',
            { class: 'st-ed-stage-wrap' },
            hasBase
              ? h(
                  'div',
                  { class: 'st-ed-stage' },
                  [
                    h('canvas', {
                      ref: setCanvas,
                      class: 'st-ed-canvas', style: {cursor:s.tool === 'select' ? 'move' : 'crosshair'},
                      onDblclick:core.editSelectedText,
                      tabindex: 0, 'aria-label': '标注画布',
                      onPointerdown: e => { e.currentTarget.focus({preventScroll:true}); core.onPointerDown(e) },
                      onPointermove: core.onPointerMove,
                      onPointerup: core.onPointerUp,
                      onPointercancel: core.onPointerUp
                    }),
                    s.textEditing
                      ? h('div', { class: 'st-ed-textbox', style: textEditorStyle(s) }, [
                          h('input', {
                            class: 'st-ed-text-input',
                            onVnodeMounted: vnode => vnode.el.focus({preventScroll:true}),
                            'aria-label': s.textEditing.step ? '步骤说明' : '标注文字',
                            placeholder: '输入文字，Enter 确认',
                            value: s.textEditing.value,
                            onInput: (e) => (s.textEditing.value = e.target.value),
                            onKeydown: (e) => {
                              if (e.isComposing || e.keyCode === 229) return
                              if (e.key === 'Enter') {
                                e.stopPropagation()
                                core.commitText()
                              }
                              if (e.key === 'Escape') {
                                e.stopPropagation()
                                core.cancelDraft()
                              }
                            },
                            onBlur: core.commitText
                          })
                        ])
                      : null
                  ]
                )
              : h('div', { class: 'st-ed-empty' }, '尚未加载截图 —— 用上方按钮开始捕获')
          )
        ])
      }
    }
  })

  function textEditorStyle(s) {
    const t = s.textEditing
    const leftPct = s.width ? (t.x / s.width) * 100 : 0
    const topPct = s.height ? (t.y / s.height) * 100 : 0
    return `left:clamp(0px,${leftPct}%,max(0px,100% - 150px));top:${topPct}%`
  }

  // ---- 对外命令式句柄（与旧版签名一致，workspace 无需改动） ----

  return {
    version,
    state: core.state,
    component,
    load: (canvas, meta = {}) => {
      core.load(canvas, meta)
      nextTick(() => core.redraw())
    },
    setAppearance: core.setAppearance, exportScene: core.exportScene,
    exportCanvas: () => core.exportCanvas(),
    exportBytes: () => core.exportBytes(),
    redraw: () => core.redraw(),
    get isEmpty() {
      return core.isEmpty
    },
    get isDirty() {
      return core.isDirty
    },
    get boundId() {
      return core.boundId
    }
  }
}
