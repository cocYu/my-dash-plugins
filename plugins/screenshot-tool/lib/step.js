// The badge, leader and caption are one shape in image coordinates.
export function captionBox(g, s, width, height) {
  const font = Math.min(40, Math.max(12, Math.round(s.diameter * .52)))
  g.save(); g.font = `600 ${font}px system-ui,sans-serif`
  const w = Math.min(width, Math.ceil(g.measureText(s.text).width) + 16), h = Math.min(height,font+12)
  g.restore()
  const x = Math.max(0, Math.min(width-w, s.tx < s.x ? s.tx-w : s.tx))
  return { x, y:Math.max(0, Math.min(height-h,s.ty-h/2)), w,h,font }
}
export function stepBounds(s) {
  const r = s.diameter/2+2, b = s.box
  const x = Math.min(s.x-r,b?.x ?? Infinity), y = Math.min(s.y-r,b?.y ?? Infinity)
  return {x,y,w:Math.max(s.x+r,b ? b.x+b.w : -Infinity)-x,h:Math.max(s.y+r,b ? b.y+b.h : -Infinity)-y}
}
export function drawStep(g,s) {
  const r=s.diameter/2, b=s.box
  if (Number.isFinite(s.tx)) {
    g.beginPath(); g.moveTo(s.x,s.y); g.lineTo(b ? Math.max(b.x,Math.min(s.tx,b.x+b.w)) : s.tx, b ? Math.max(b.y,Math.min(s.ty,b.y+b.h)) : s.ty)
    g.strokeStyle=s.color; g.lineWidth=Math.max(2,r/6); g.stroke()
  }
  if (b) {
    g.beginPath(); g.roundRect(b.x,b.y,b.w,b.h,4); g.fillStyle='#202328'; g.fill()
    g.fillStyle='#fff'; g.textAlign='center'; g.textBaseline='middle'; g.font=`600 ${b.font}px system-ui,sans-serif`
    g.fillText(s.text,b.x+b.w/2,b.y+b.h/2,Math.max(1,b.w-8))
  }
  g.beginPath(); g.arc(s.x,s.y,r,0,2*Math.PI); g.fillStyle=s.color; g.fill()
  g.lineWidth=Math.max(1,r/12); g.strokeStyle='#ffffffce'; g.stroke()
  g.fillStyle=s.color.toLowerCase()==='#ffffff' ? '#161819' : '#fff'; g.font=`700 ${Math.round(r*1.12)}px system-ui,sans-serif`
  g.textAlign='center'; g.textBaseline='middle'; g.fillText(String(s.n),s.x,s.y+1,Math.max(1,s.diameter-4))
}
export function stepHint(state) {
  if (!state.stepText) return '点击画面放置编号'
  if (state.textEditing) return '输入说明，Enter 确认，Esc 取消'
  return state.pendingStep ? '点击说明位置，确定引线终点' : '先点击编号位置，再点击文字位置'
}
