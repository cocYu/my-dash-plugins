import { test } from 'node:test'
import assert from 'node:assert/strict'
import { constrainSelection, imageBounds } from '../plugins/screenshot-tool/lib/selection.js'
import { overlapRows } from '../plugins/screenshot-tool/lib/stitch.js'
import { addHistory, clearHistory, listHistory, removeHistory } from '../plugins/screenshot-tool/lib/history.js'

test('reverse-edge selection and fractional display scale', () => {
  assert.deepEqual(constrainSelection({x:999,y:-4,w:11,h:8},48,24),{x:37,y:0,w:11,h:8})
  assert.deepEqual(imageBounds({x:37,y:0,w:11,h:8},1.25,1.5,60,36),{x:46,y:0,w:14,h:12})
  assert.throws(()=>constrainSelection({x:NaN,y:0,w:8,h:8},48,24))
})
test('stitching: identical, small scrolls, repeated motifs, no match', () => {
  for (const [prev,next,expected] of [ [[1,2,3],[1,2,3],3],[[1,2,3],[2,3,4],2],[[4,5,4,5],[4,5,6],2],[[1,2],[9,8],0],[[],[1],0] ]) assert.equal(overlapRows(prev,next),expected)
})
test('history mutations serialize and remove only committed screenshot files', async () => {
  const disk = new Set(['unrelated']), kv = new Map(); let failThumb = false
  const ctx = {meta:{id:'screenshot-tool'},storage:{get: async k=>structuredClone(kv.get(k)), set: async(k,v)=>kv.set(k,structuredClone(v))}}
  const canvas = () => ({width:20,height:10,getContext:()=>({drawImage(){}}),toBlob: cb => cb(new Blob(['image']))})
  globalThis.document = {createElement:canvas}
  globalThis.window = {api:{plugins:{files:{write:async(_,name)=>{if(failThumb && name.endsWith('.jpg')) throw Error('quota');disk.add(name)}, delete:async(_,name)=>disk.delete(name)}}}}
  const add = () => addHistory(ctx,{canvas:canvas(),source:'screen',limit:2})
  const [a,b,c] = await Promise.all([add(),add(),add()])
  assert.deepEqual((await listHistory(ctx)).map(m=>m.id),[c.id,b.id]);assert(!disk.has(a.id+'.png'))
  failThumb = true; await assert.rejects(add(),/quota/); assert.equal(disk.size,5)
  await removeHistory(ctx,b.id);assert(!disk.has(b.id+'.png'));await clearHistory(ctx);assert.deepEqual([...disk],['unrelated'])
})

test('step callout: two clicks, cancel without consuming a number, move and undo as a group', async () => {
  const {createEditorCore} = await import('../plugins/screenshot-tool/lib/editor.js')
  const {stepBounds} = await import('../plugins/screenshot-tool/lib/step.js')
  const g = {clearRect(){},drawImage(){},save(){},restore(){},measureText(){return {width:44}}}
  const canvas = {width:240,height:160,getContext:()=>g,getBoundingClientRect:()=>({width:240,height:160,left:0,top:0})}
  g.canvas=canvas
  const previous = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame=()=>0
  try {
    const ed=createEditorCore(), state=ed.state
    ed.load(canvas);ed.attach(canvas);ed.selectTool('step')
    const pointer=(x,y)=>({clientX:x,clientY:y,button:0,preventDefault(){}})
    const click=(x,y)=>{ed.onPointerDown(pointer(x,y));ed.onPointerUp()}
    state.stepSize=52;click(24,30)
    assert.deepEqual([state.shapes[0].diameter,state.shapes[0].n],[52,1])
    state.stepText=true;click(80,90);ed.cancelDraft();assert.equal(state.nextStep,2)
    click(80,90);ed.onPointerMove(pointer(222,130));assert.equal(state.pendingStep.tx,222)
    click(230,130);state.textEditing.value='说明';ed.commitText();const label=state.shapes[1]
    assert.equal(label.n,2);assert.equal(label.text,'说明');assert(stepBounds(label).w>140)
    assert(label.box.x+label.box.w<=canvas.width)
    ed.selectTool('select');ed.onPointerDown(pointer(80,90));ed.onPointerMove(pointer(68,85));ed.onPointerUp()
    assert.equal(state.shapes[1].tx,218);assert.equal(state.shapes[1].box.x,label.box.x-12)
    ed.undo();assert.deepEqual(state.shapes[1],label);ed.undo();assert.equal(state.nextStep,2)
    ed.redo();assert.equal(state.nextStep,3);assert.deepEqual(state.shapes[1],label)
  } finally {globalThis.requestAnimationFrame=previous}
})

test('output preferences default to unmodified PNG and clamp invalid values',async()=>{
  const {appearance,renderOutput,PLAIN}=await import('../plugins/screenshot-tool/lib/shell.js')
  assert.deepEqual(appearance(null),PLAIN)
  assert.deepEqual(appearance({rounded:true,radius:999,shell:'not-a-shell'}),{rounded:true,radius:256,shell:'none'})
  const base={width:40,height:20};assert.equal(renderOutput(base,PLAIN),base)
})

test('editing selected text changes only that object, using immutable undo checkpoints', async () => {
  const {createEditorCore} = await import('../plugins/screenshot-tool/lib/editor.js')
  const g = {clearRect(){},drawImage(){},save(){},restore(){},measureText(){return {width:80}}}
  const canvas = {width:200,height:120,getContext:()=>g,getBoundingClientRect:()=>({left:0,top:0,width:200,height:120})}; g.canvas=canvas
  const before = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame=()=>0
  try {
    const ed=createEditorCore(); ed.load(canvas);ed.attach(canvas);ed.selectTool('text')
    const click=(x,y)=>{ed.onPointerDown({button:0,clientX:x,clientY:y,preventDefault(){}});ed.onPointerUp()}
    for (const [y,text] of [[5,'第一条文字'],[74,'第二条文字']]) {click(4,y);ed.state.textEditing.value=text;ed.commitText()}
    const [first, second] = ed.state.shapes
    ed.selectTool('select');click(78,10);assert.equal(ed.selected.id,first.id)
    ed.editSelectedText();ed.state.textEditing.value='已修改';ed.commitText();ed.setMeasure(45);ed.setColor('#1267bd')
    assert.deepEqual(ed.selected,{...first,text:'已修改',size:45,color:'#1267bd'})
    ed.onKeydown({key:'ArrowRight',shiftKey:true,preventDefault(){}});assert.equal(ed.selected.x,14)
    assert.equal(ed.state.color,'#e64545');assert.equal(ed.state.fontSize,20);assert.equal(ed.state.shapes[1],second)
    for(let i=0;i<4;i++) ed.undo();assert.deepEqual(ed.state.shapes,[first,second]);ed.redo();assert.equal(ed.state.shapes[0].text,'已修改')
  } finally {globalThis.requestAnimationFrame=before}
})

test('auto scroll pauses after three unchanged frames and falls back on denied input', {timeout:2000}, async () => {
  const {createScrollSession} = await import('../plugins/screenshot-tool/lib/scroll-session.js')
  let keys=0, captures=0, allow=true, changed
  const session=createScrollSession({interval:1,sendKey:async()=>({ok:(keys++,allow),message:'权限不足'}),capture:async()=>{captures++;return {noNew:true}},
    onMode:(mode,msg)=>{if(msg) changed({mode,msg})},onResult:()=>{},onError:e=>{throw e}})
  try {
    let transition=new Promise(r=>changed=r);session.switchTo('auto');assert.equal((await transition).mode,'paused')
    assert.equal(keys,3);assert.equal(captures,3)
    allow=false;transition=new Promise(r=>changed=r);session.switchTo('auto');const fallback=await transition
    assert.equal(fallback.mode,'manual');assert.match(fallback.msg,/权限/);assert.equal(captures,3)
  } finally {await session.stop()}
})
