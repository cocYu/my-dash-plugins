// Coerce a logical display rectangle without letting a rounded physical edge escape.
const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
export function constrainSelection({ x, y, w, h }, width, height) {
  if (![x,y,w,h,width,height].every(Number.isFinite) || width < 6 || height < 6) throw new Error('无效的选区尺寸')
  w = clamp(Math.round(w), 6, width); h = clamp(Math.round(h), 6, height)
  return { x: clamp(Math.round(x), 0, width-w), y: clamp(Math.round(y), 0, height-h), w, h }
}
export function imageBounds(r, sx, sy, width, height) {
  const x = clamp(Math.round(r.x*sx), 0, width-1), y = clamp(Math.round(r.y*sy), 0, height-1)
  const right = clamp(Math.round((r.x+r.w)*sx), x+1, width), bottom = clamp(Math.round((r.y+r.h)*sy), y+1, height)
  return { x, y, w:right-x, h:bottom-y }
}
