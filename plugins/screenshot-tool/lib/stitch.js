// 截长图：持续抓帧 + 重叠区对齐拼接。
// 对齐算法：把上下相邻两帧各行的采样像素求哈希（r/g/b 通道和），
// 在「上一帧底部 vs 新帧顶部」的候选重叠行数里搜索哈希序列差异最小的偏移，
// 粗定位（步长 8）后精调（±8 逐行），内容重复（纯色/规则列表）时取更小的重叠行数以防丢内容。

const MIN_NEW_ROWS = 24 // 至少保留这么多新行，避免重叠判定吃掉全部内容
const MAX_BASE_HEIGHT = 30000 // canvas 高度上限保护

function hashRows(canvas, fromY, toY, step = 8) {
  const g = canvas.getContext('2d', { willReadFrequently: true })
  const width = canvas.width
  const rows = []
  const img = g.getImageData(0, fromY, width, Math.max(0, toY - fromY))
  const d = img.data
  for (let y = 0; y < toY - fromY; y++) {
    let r = 0
    let gg = 0
    let b = 0
    let n = 0
    const base = y * width * 4
    for (let x = 0; x < width; x += step * 4) {
      const i = base + x * 4
      r += d[i]
      gg += d[i + 1]
      b += d[i + 2]
      n++
    }
    rows.push([r, gg, b, n])
  }
  return rows
}

function fitWidth(frame, width) {
  if (frame.width === width) return frame
  const scaled = document.createElement('canvas')
  scaled.width = width
  scaled.height = Math.max(1, Math.round((frame.height * width) / frame.width))
  const g = scaled.getContext('2d')
  g.imageSmoothingQuality = 'high'
  g.drawImage(frame, 0, 0, scaled.width, scaled.height)
  return scaled
}

/** 在 prev 底部与 cur 顶部之间找最佳重叠行数 */
export function findOverlap(prev, cur) {
  const maxO = Math.min(prev.height, cur.height) - MIN_NEW_ROWS
  if (maxO < 8) return 0
  const prevRows = hashRows(prev, prev.height - maxO, prev.height)
  const curRows = hashRows(cur, 0, maxO)
  const baseIdx = maxO // prevRows[i] 对应 prev 全图的 y = i + baseIdx

  const scoreAt = (o, step) => {
    // prev 底部 o 行 与 cur 顶部 o 行 的平均哈希差
    let diff = 0
    let n = 0
    for (let i = 0; i < o; i += step) {
      const a = prevRows[baseIdx - o + i]
      const b = curRows[i]
      diff += (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / a[3]
      n++
    }
    return n ? diff / n : Infinity
  }

  // 粗定位
  let bestO = 0
  let bestScore = Infinity
  const scores = []
  for (let o = 8; o <= maxO; o += 8) {
    const s = scoreAt(o, 4)
    scores.push([o, s])
    if (s < bestScore) {
      bestScore = s
      bestO = o
    }
  }
  if (bestO === 0) return 0
  // 精调 ±8
  let fineO = bestO
  let fineScore = bestScore
  for (let o = Math.max(1, bestO - 8); o <= Math.min(maxO, bestO + 8); o++) {
    const s = scoreAt(o, 2)
    if (s < fineScore) {
      fineScore = s
      fineO = o
    }
  }
  // 阈值内取最小重叠（内容重复区域取更多新内容）；超过松阈值视为无重叠
  const TIGHT = 10
  const LOOSE = 60
  if (fineScore > LOOSE) return 0
  if (fineScore <= TIGHT) {
    let minO = fineO
    for (const [o, s] of scores) {
      if (Math.abs(o - fineO) <= 64 && s <= TIGHT && o < minO) minO = o
    }
    return minO
  }
  return fineO
}

/** 拼接器：append 逐帧追加，result 取最终长图 */
export function createStitcher() {
  let base = null
  return {
    get height() {
      return base ? base.height : 0
    },
    get width() {
      return base ? base.width : 0
    },
    get isEmpty() {
      return !base
    },
    /** 返回 { added, overlap, height, noNew, truncated } */
    append(frame) {
      if (!base) {
        base = document.createElement('canvas')
        base.width = frame.width
        base.height = frame.height
        base.getContext('2d').drawImage(frame, 0, 0)
        return { added: base.height, overlap: 0, height: base.height, noNew: false, truncated: false }
      }
      const f = fitWidth(frame, base.width)
      const overlap = findOverlap(base, f)
      const added = f.height - overlap
      if (added <= 0) return { added: 0, overlap, height: base.height, noNew: true, truncated: false }
      const truncated = base.height + added > MAX_BASE_HEIGHT
      const next = document.createElement('canvas')
      next.width = base.width
      next.height = Math.min(MAX_BASE_HEIGHT, base.height + added)
      const g = next.getContext('2d')
      g.drawImage(base, 0, 0)
      g.drawImage(f, 0, base.height - overlap)
      base = next
      return { added, overlap, height: base.height, noNew: false, truncated }
    },
    result() {
      return base
    }
  }
}
