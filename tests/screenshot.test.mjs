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
