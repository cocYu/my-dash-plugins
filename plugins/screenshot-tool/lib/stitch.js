// Hash a narrow strip instead of reading back the entire accumulating long image.
// Exact row signatures preserve 1px scrolling and distinguish unchanged frames.
function signatures(frame) {
  const strip = document.createElement('canvas')
  strip.width = Math.min(96, frame.width)
  strip.height = frame.height
  const ctx = strip.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(frame, 0, 0, strip.width, strip.height)
  const pixels = ctx.getImageData(0, 0, strip.width, strip.height).data
  const rows = new Uint32Array(strip.height)
  for (let y = 0, i = 0; y < rows.length; y++) {
    let hash = 2166136261
    const end = i + strip.width * 4
    for (; i < end; i++) hash = Math.imul(hash ^ pixels[i], 16777619)
    rows[y] = hash
  }
  return rows
}

// KMP: longest suffix of the previous frame that is a prefix of the next.
export function overlapRows(previous, next) {
  if (!next.length) return 0
  const prefix = new Uint32Array(next.length)
  for (let i = 1, n = 0; i < next.length; i++) {
    while (n && next[i] !== next[n]) n = prefix[n - 1]
    if (next[i] === next[n]) n++
    prefix[i] = n
  }
  let n = 0
  for (const row of previous) {
    while (n && (n === next.length || row !== next[n])) n = prefix[n - 1]
    if (row === next[n]) n++
  }
  return n
}

export function createStitcher() {
  let base = null, previous = []
  return {
    result: () => base,
    append(frame) {
      if (!frame.width || !frame.height || (base && base.width !== frame.width)) throw new Error('选区尺寸已改变，请重新截图')
      const rows = signatures(frame)
      const overlap = overlapRows(previous, rows)
      const height = base?.height || 0
      const cap = Math.min(30000, Math.floor(48_000_000 / frame.width))
      const added = Math.max(0, Math.min(frame.height - overlap, cap - height))
      if (added) {
        const out = document.createElement('canvas')
        out.width = frame.width
        out.height = height + added
        const g = out.getContext('2d')
        if (base) g.drawImage(base, 0, 0)
        g.drawImage(frame, 0, overlap, frame.width, added, 0, height, frame.width, added)
        base = out
      }
      previous = rows
      return { added, overlap, height: height + added, noNew: overlap === frame.height, truncated: height + added >= cap }
    }
  }
}
