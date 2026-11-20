import { appearance, renderOutput, SHELLS } from './shell.js'

/** Both editor surfaces use the native modal's focus trap, Escape and focus restoration. */
export function chooseAppearance(scene, current, apply) {
  const draft = appearance(current)
  const dialog = document.createElement('dialog')
  dialog.className = 'st-output-dialog'
  dialog.setAttribute('aria-label', '截图外观')
  dialog.innerHTML = `<form method="dialog"><header><h3>截图外观</h3><p>预览导出效果，原图和标注保持可编辑。</p></header>
    <div class="st-output-preview"></div><div class="st-output-fields">
    <label><input name="rounded" type="checkbox"> 截图圆角</label>
    <label>半径（px） <input name="radius" type="number" min="0" max="256" required></label>
    <label>外壳 <select name="shell" aria-label="外壳"></select></label></div>
    <footer><button type="button" name="cancel">取消</button><button value="apply">应用外观</button></footer></form>`
  const f = dialog.querySelector('form').elements
  for (const {id,name} of SHELLS) f.shell.add(new Option(name,id))
  f.shell.value=draft.shell; f.rounded.checked=draft.rounded; f.radius.value=draft.radius
  function preview() {
    f.radius.disabled=!f.rounded.checked
    draft.shell=f.shell.value; draft.rounded=f.rounded.checked
    if (f.radius.validity.valid && Number.isFinite(f.radius.valueAsNumber)) draft.radius=f.radius.valueAsNumber
    dialog.querySelector('.st-output-preview').replaceChildren(renderOutput(scene,draft,760))
  }
  dialog.oninput=preview
  f.cancel.onclick=()=>dialog.close()
  dialog.onclose=()=>{ dialog.remove(); if(dialog.returnValue==='apply') apply(appearance(draft)) }
  document.body.append(dialog); preview(); dialog.showModal()
}
