import { stepHint } from './step.js'

const colors = ['#e64545', '#f4a300', '#2f9e44', '#1971c2', '#9c36b5', '#111111', '#ffffff']

// One property bar for both the frozen overlay and the Vue workspace. Keep the
// native controls mounted while dragging or typing so focus is not lost.
export function mountInspector(el, core) {
  el.classList.add('st-inspector')
  el.innerHTML = `<small role="status"></small><span class="st-palette" role="group" aria-label="标注颜色"></span>
    <label class="st-measure"><span></span> <input type="number" step="1"> px</label>
    <label><input type="checkbox"> 附带文字</label><button type="button">编辑文字</button>`
  const [hint, palette, measure, caption, edit] = el.children
  const number = measure.querySelector('input'), check = caption.querySelector('input')
  const swatches = colors.map(color => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'st-swatch'
    b.style.backgroundColor = color; b.title = `颜色 ${color}`; b.setAttribute('aria-label', b.title)
    b.onclick = () => core.setColor(color); palette.append(b); return b
  })
  const custom = document.createElement('input'); custom.type = 'color'; custom.title = '自定义颜色'
  custom.setAttribute('aria-label', custom.title); custom.onchange = () => core.setColor(custom.value)
  const code = document.createElement('output'); palette.append(custom, code)
  number.onchange = () => { core.setMeasure(number.valueAsNumber); sync() }
  check.onchange = () => { core.state.stepText = check.checked; core.cancelDraft() }
  edit.onclick = core.editSelectedText
  function sync() {
    const { state:s, selected, properties:p } = core
    hint.textContent = s.tool === 'select' ? (selected ? '已选中 · 拖动移动，方向键微调' : '点击标注以移动或修改') : s.tool === 'step' ? stepHint(s) : ''
    palette.hidden = !p.color
    if (p.color) {
      swatches.forEach((b,i) => { const active = colors[i] === p.color; b.setAttribute('aria-pressed', String(active)); b.textContent = active ? '✓' : '' })
      custom.value = p.color; code.textContent = (colors.includes(p.color) ? '' : '✓ ') + p.color.toUpperCase()
    }
    measure.hidden = !p.key
    if (p.key) {
      measure.firstChild.textContent = p.label; number.setAttribute('aria-label', p.label)
      number.min = p.min; number.max = p.max; number.value = p.value
      if (el.id === 'overlay-inspector') number.id = p.key === 'diameter' ? 'step-size' : p.type === 'text' ? 'eb-font' : 'eb-size'
    }
    caption.hidden = s.tool !== 'step'; check.checked = s.stepText
    edit.hidden = !(selected?.type === 'text' || selected?.box)
  }
  sync(); return sync
}
