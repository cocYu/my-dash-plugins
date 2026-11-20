// 截图历史：元数据存 KV（新条目在前），图片与缩略图存插件文件存储。
// 每条记录两个文件：<id>.png（原图）与 <id>.t.jpg（256px 缩略图，列表用）。

const META_KEY = 'history'

const files = () => window.api.plugins.files

function genId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 所有对索引的修改走同一条队列，失败不阻塞后续截图。 */
let tail = Promise.resolve()
function mutate(fn) {
  const op = tail.then(fn)
  tail = op.catch(() => {})
  return op
}

function encode(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) return reject(new Error('图片导出失败'))
    blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)), reject)
  }, type, quality))
}
export const canvasBytes = canvas => encode(canvas, 'image/png')

/** 生成缩略图 canvas（最长边 256） */
export function makeThumb(canvas, maxSide = 256) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height))
  const thumb = document.createElement('canvas')
  thumb.width = Math.max(1, Math.round(canvas.width * scale))
  thumb.height = Math.max(1, Math.round(canvas.height * scale))
  const tctx = thumb.getContext('2d')
  tctx.imageSmoothingQuality = 'high'
  tctx.drawImage(canvas, 0, 0, thumb.width, thumb.height)
  return thumb
}

async function readMetas(ctx) {
  return (await ctx.storage.get(META_KEY)) || []
}

async function writeMetas(ctx, metas) {
  await ctx.storage.set(META_KEY, metas)
}

/**
 * 新增一条历史：落盘原图 + 缩略图，裁剪超限条目（同时删除对应文件）。
 * @param source region|screen|window|long|paste|edit
 * @param note 可选附注（如就地 OCR 文本）
 */
async function append(ctx, { canvas, source, limit = 50, note = '' }) {
  const id = genId()
  const png = await canvasBytes(canvas)
  const thumb = await encode(makeThumb(canvas), 'image/jpeg', 0.8)
  const meta = {
    id,
    source,
    width: canvas.width,
    height: canvas.height,
    bytes: png.length,
    at: new Date().toISOString(),
    ...(note ? { note } : {})
  }
  let metas = await readMetas(ctx)
  metas.unshift(meta)
  const evicted = metas.slice(Math.max(1, Number(limit) || 50))
  metas = metas.slice(0, Math.max(1, Number(limit) || 50))
  try {
    await files().write(ctx.meta.id, `${id}.png`, png)
    await files().write(ctx.meta.id, `${id}.t.jpg`, thumb)
    await writeMetas(ctx, metas)
  } catch (err) {
    await removeFiles(ctx, id)
    throw err
  }
  for (const old of evicted) await removeFiles(ctx, old.id)
  return meta
}

export function addHistory(ctx, options) {
  return mutate(() => append(ctx, options))
}

async function removeFiles(ctx, id) {
  await files().delete(ctx.meta.id, `${id}.png`).catch(() => {})
  await files().delete(ctx.meta.id, `${id}.t.jpg`).catch(() => {})
}

export async function listHistory(ctx) {
  return readMetas(ctx)
}

export async function readThumb(ctx, id) {
  return files().readDataUrl(ctx.meta.id, `${id}.t.jpg`)
}

export async function readImageBytes(ctx, id) {
  return files().read(ctx.meta.id, `${id}.png`)
}

export async function readImageDataUrl(ctx, id) {
  return files().readDataUrl(ctx.meta.id, `${id}.png`)
}

/** 复制历史原图到系统剪贴板 */
export async function copyHistoryImage(ctx, id) {
  return files().copyImage(ctx.meta.id, `${id}.png`)
}

export function removeHistory(ctx, id) {
  return mutate(async () => {
    await writeMetas(ctx, (await readMetas(ctx)).filter(item => item.id !== id))
    await removeFiles(ctx, id)
  })
}

export function clearHistory(ctx) {
  return mutate(async () => {
    const items = await readMetas(ctx)
    await writeMetas(ctx, [])
    for (const { id } of items) await removeFiles(ctx, id)
  })
}
