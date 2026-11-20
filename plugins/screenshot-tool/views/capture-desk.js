// Capture entry points are deliberately independent from the annotation canvas.
const paths = {
  region: 'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5M8 8h8v8H8z',
  screen: 'M3 4h18v13H3zM8 21h8m-4-4v4',
  window: 'M3 5h18v14H3zM3 10h18',
  paste: 'M8 5H5v16h14V5h-3M9 3h6v4H9z',
  file: 'M5 3h9l5 5v13H5zM14 3v6h5M8 17l3-4 2 2 2-2'
}
export function captureDesk({h,ref,startRegion,openSourceDialog,pasteImage,importFile,message}) {
  const input = ref(null), delay = ref(0), working = ref(false)
  const run = async fn => {
    if (working.value) return
    working.value = true
    try { await fn() } catch (err) { message.error(err.message || '操作失败，请重试') }
    finally { working.value = false }
  }
  const button = (id,name,hint,fn) => h('button', {class:['st-entry',id === 'region' && 'st-primary'], disabled:working.value, onClick:() => run(fn)}, [
    h('svg',{width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.6,'stroke-linejoin':'round','aria-hidden':true},[h('path',{d:paths[id]})]),
    h('strong',{},name), h('small',{},hint)
  ])
  return () => h('section',{class:'st-capture'},[
    h('div',{class:'st-section-title'},[h('h3',{},'新建截图'), h('label',{},['区域延时 ',h('select',{value:delay.value,onChange:e => {delay.value=Number(e.target.value)}},[0,3,5,10].map(n => h('option',{value:n}, n ? `${n} 秒` : '立即')))])]),
    h('div',{class:'st-entries'},[
      button('region','区域截图','框选、标注或滚动长截',() => startRegion(delay.value)),
      button('screen','全屏截图','选择显示器',() => openSourceDialog('screen')),
      button('window','应用窗口','选择一个窗口',() => openSourceDialog('window')),
      button('paste','粘贴图片','读取剪贴板',pasteImage),
      button('file','导入图片','从本机打开',() => input.value.click())
    ]),
    h('input',{type:'file',hidden:true,ref:input,accept:'image/png,image/jpeg,image/webp,image/bmp,image/gif',onChange:e => {const file=e.target.files[0]; e.target.value=''; void run(() => importFile(file))}})
  ])
}
