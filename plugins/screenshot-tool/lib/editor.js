// 标注编辑器：底图 + 标注对象列表（矢量描述，导出时整场景重绘）。
// 工具：选择(移动)/画笔/高亮/直线/箭头/矩形/椭圆/文字/步骤序号/马赛克。
// 撤销重做、选中移动（Delete 删除）、步骤序号自动递增。
// 所有形状坐标均为底图像素坐标，显示缩放只在交互换算层处理。

import { canvasBytes } from './history.js'

let shapeSeq = 0
const genShapeId = () => `sh-${Date.now().toString(36)}-${(shapeSeq++).toString(36)}`

export const TOOLS = [
  { id: 'select', name: '选择', glyph: '⬚' },
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

export const COLORS = ['#e64545', '#f4a300', '#2f9e44', '#1971c2', '#9c36b5', '#111111', '#ffffff']

export function createEditorState() {
  return {
    version: 0, // 手动触发视图重绘/重算（render 里读取以建立依赖）
    shapes: [],
    redo: [],
    tool: 'pen',
    color: '#e64545',
    size: 4,
    fontSize: 20,
    selectedId: null,
    textEditing: null, // {x, y, value}
    boundId: null, // 绑定的历史记录 id
    dirty: false,
    nextStep: 1,
    width: 0,
    height: 0
  }
}

function normRect(s) {
  const x = Math.min(s.x1, s.x2)
  const y = Math.min(s.y1, s.y2)
  const w = Math.abs(s.x2 - s.x1)
  const h = Math.abs(s.y2 - s.y1)
  return { x, y, w, h }
}

function shapeBBox(s) {
  const slack = (s.size || 4) + 6
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
      const w = Math.max(...lines.map((l) => l.length)) * s.size * 0.6 + 8
      const h = lines.length * s.size * 1.5 + 8
      return { x: s.x - 4, y: s.y - 4, w: w + slack, h: h + slack }
    }
    case 'step':
      return { x: s.x - 20, y: s.y - 20, w: 40, h: 40 }
    default:
      return { x: 0, y: 0, w: 0, h: 0 }
  }
}

function hitTest(shapes, x, y) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const b = shapeBBox(shapes[i])
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return shapes[i]
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
    case 'text':
    case 'step':
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
      g.font = `600 ${s.size}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`
      g.textBaseline = 'top'
      const lines = String(s.text).split('\n')
      lines.forEach((line, i) => g.fillText(line, s.x, s.y + i * s.size * 1.5))
      break
    }
    case 'step': {
      const r = 13
      g.beginPath()
      g.arc(s.x, s.y, r, 0, Math.PI * 2)
      g.fillStyle = s.color
      g.shadowColor = 'rgba(0,0,0,0.3)'
      g.shadowBlur = 4
      g.fill()
      g.shadowBlur = 0
      g.fillStyle = '#ffffff'
      g.font = `700 ${r + 2}px system-ui, sans-serif`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(String(s.n), s.x, s.y + 1)
      break
    }
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
      const b = shapeBBox(sel)
      g.save()
      g.strokeStyle = '#1971c2'
      g.lineWidth = 1.5
      g.setLineDash([6, 4])
      g.strokeRect(b.x, b.y, b.w, b.h)
      g.restore()
    }
  }
}

// ---- 编辑器组件工厂 ----

export function createEditor(bundle) {
  const { vue, ui } = bundle
  const { h, reactive, defineComponent, nextTick, onBeforeUnmount, onMounted } = vue
  const { ElButton, ElInputNumber, ElSlider, ElTooltip } = ui

  const state = reactive(createEditorState())
  let baseCanvas = null // HTMLCanvasElement 不进响应式系统，经 load() 更新后 bump
  let canvasEl = null
  let draft = null // 进行中的形状
  let moving = null // { shape, startX, startY }
  let rafPending = false

  const bump = () => {
    state.version++
  }

  const redraw = () => {
    if (!canvasEl || !baseCanvas) return
    const g = canvasEl.getContext('2d')
    const shapes = draft ? [...state.shapes, draft] : state.shapes
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
    const scale = state.width / rect.width
    return [(e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale]
  }

  const commit = (shape) => {
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
    if (!baseCanvas || state.textEditing) return
    e.preventDefault()
    const [x, y] = toImageCoords(e)
    try { canvasEl.setPointerCapture?.(e.pointerId) } catch { /* 合成事件无活动指针 */ }
    const t = state.tool
    const common = { id: genShapeId(), color: state.color, size: state.size }
    if (t === 'select') {
      const hit = hitTest(state.shapes, x, y)
      state.selectedId = hit ? hit.id : null
      if (hit) moving = { shape: hit, startX: x, startY: y, moved: false }
      bump()
      return
    }
    if (t === 'step') {
      commit({ ...common, type: 'step', x, y, n: state.nextStep })
      updateNextStep()
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
      draft = { ...common, type: 'mosaic', x, y, w: 0, h: 0, block: 12, x1: x, y1: y }
    } else {
      draft = { ...common, type: t, x1: x, y1: y, x2: x, y2: y }
    }
    scheduleRedraw()
  }

  const onPointerMove = (e) => {
    if (!baseCanvas) return
    if (moving) {
      const [x, y] = toImageCoords(e)
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

  const commitText = () => {
    const t = state.textEditing
    state.textEditing = null
    if (t && t.value.trim()) {
      commit({ id: genShapeId(), type: 'text', x: t.x, y: t.y, text: t.value, color: state.color, size: state.fontSize })
    } else {
      bump()
    }
  }

  const undo = () => {
    if (!state.shapes.length) return
    const last = state.shapes.pop()
    if (state.selectedId === last.id) state.selectedId = null
    state.redo.push(last)
    state.dirty = true
    updateNextStep()
    bump()
  }

  const redoFn = () => {
    const shape = state.redo.pop()
    if (!shape) return
    state.shapes.push(shape)
    state.dirty = true
    updateNextStep()
    bump()
  }

  const clearShapes = () => {
    if (!state.shapes.length) return
    state.redo = []
    state.shapes = []
    state.selectedId = null
    state.dirty = true
    updateNextStep()
    bump()
  }

  const removeSelected = () => {
    if (!state.selectedId) return
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
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedId) {
        e.preventDefault()
        removeSelected()
      }
    } else if (e.key === 'Escape') {
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

  const toolBtn = (t) =>
    h(
      ElTooltip,
      { content: t.name, placement: 'top', showAfter: 400 },
      {
        default: () =>
          h(
            'button',
            {
              class: ['st-ed-tool', state.tool === t.id ? 'is-active' : ''],
              onClick: () => {
                state.tool = t.id
                state.selectedId = null
                bump()
              }
            },
            t.glyph
          ),
      }
    )

  const component = defineComponent({
    name: 'ScreenshotEditor',
    setup() {
      // 生命周期必须在 setup() 内注册（工厂函数体里没有组件实例）
      onMounted(() => {
        window.addEventListener('keydown', onKeydown)
      })
      onBeforeUnmount(() => {
        window.removeEventListener('keydown', onKeydown)
      })
      const setCanvas = (el) => {
        canvasEl = el
        if (el && baseCanvas) {
          el.width = state.width
          el.height = state.height
          redraw()
        }
      }
      return () => {
        void state.version // 建立依赖：命令式变更后触发重渲染
        const hasBase = !!baseCanvas
        return h('div', { class: 'st-editor' }, [
          // 工具栏
          h('div', { class: 'st-ed-bar' }, [
            h('div', { class: 'st-ed-tools' }, TOOLS.map(toolBtn)),
            h('div', { class: 'st-ed-sep' }),
            // 色板
            h(
              'div',
              { class: 'st-ed-colors' },
              COLORS.map((c) =>
                h('button', {
                  class: ['st-ed-color', state.color === c ? 'is-active' : ''],
                  style: `background:${c}`,
                  onClick: () => {
                    state.color = c
                    bump()
                  },
                  title: c
                })
              ).concat([
                h('input', {
                  type: 'color',
                  class: 'st-ed-color-custom',
                  value: state.color,
                  onInput: (e) => {
                    state.color = e.target.value
                    bump()
                  }
                })
              ])
            ),
            h('div', { class: 'st-ed-sep' }),
            h('span', { class: 'st-ed-label' }, '粗细'),
            h(ElSlider, {
              class: 'st-ed-size',
              min: 1,
              max: 20,
              step: 1,
              modelValue: state.size,
              'onUpdate:modelValue': (v) => {
                state.size = v
                bump()
              }
            }),
            h('span', { class: 'st-ed-label' }, '字号'),
            h(ElInputNumber, {
              class: 'st-ed-font',
              size: 'small',
              min: 12,
              max: 64,
              modelValue: state.fontSize,
              'onUpdate:modelValue': (v) => {
                state.fontSize = v
                bump()
              }
            }),
            h('div', { class: 'st-ed-sep' }),
            h(ElButton, { size: 'small', disabled: !state.shapes.length, onClick: undo }, () => '撤销'),
            h(ElButton, { size: 'small', disabled: !state.redo.length, onClick: redoFn }, () => '重做'),
            h(
              ElButton,
              { size: 'small', type: 'danger', plain: true, disabled: !state.selectedId, onClick: removeSelected },
              () => '删除选中'
            ),
            h(ElButton, { size: 'small', disabled: !state.shapes.length, onClick: clearShapes }, () => '清空标注')
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
                      class: 'st-ed-canvas',
                      onMousedown: onPointerDown,
                      onMousemove: onPointerMove,
                      onMouseup: onPointerUp,
                      onMouseleave: onPointerUp
                    }),
                    state.textEditing
                      ? h('div', { class: 'st-ed-textbox', style: textEditorStyle() }, [
                          h('input', {
                            class: 'st-ed-text-input',
                            autofocus: true,
                            placeholder: '输入文字，Enter 确认',
                            value: state.textEditing.value,
                            onInput: (e) => (state.textEditing.value = e.target.value),
                            onKeydown: (e) => {
                              if (e.key === 'Enter') commitText()
                              if (e.key === 'Escape') {
                                state.textEditing = null
                                bump()
                              }
                            },
                            onBlur: commitText
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

  function textEditorStyle() {
    const t = state.textEditing
    const leftPct = state.width ? (t.x / state.width) * 100 : 0
    const topPct = state.height ? (t.y / state.height) * 100 : 0
    return `left:${leftPct}%;top:${topPct}%`
  }

  // ---- 对外命令式句柄 ----

  const load = (canvas, meta = {}) => {
    baseCanvas = canvas
    state.width = canvas.width
    state.height = canvas.height
    state.shapes = []
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
      nextTick(redraw)
    }
  }

  const exportCanvas = () => {
    if (!baseCanvas) return null
    const out = document.createElement('canvas')
    out.width = state.width
    out.height = state.height
    renderScene(out.getContext('2d'), baseCanvas, state.shapes, null)
    return out
  }

  const exportBytes = async () => {
    const canvas = exportCanvas()
    return canvas ? await canvasBytes(canvas) : null
  }

  return {
    state,
    component,
    load,
    exportCanvas,
    exportBytes,
    redraw,
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
