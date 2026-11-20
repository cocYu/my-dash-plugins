// 截图历史：元数据存 KV（新条目在前），图片与缩略图存插件文件存储。
// 每条记录两个文件：<id>.png（原图）与 <id>.t.jpg（256px 缩略图，列表用）。

const META_KEY = 'history'

const files = () => window.api.plugins.files

function genId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** canvas → PNG 字节 */
export function canvasBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('图片导出失败'))
      resolve(new Uint8Array(await blob.arrayBuffer()))
    }, 'image/png')
  })
}

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

function jpegBytes(canvas, quality = 0.8) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('缩略图导出失败'))
      resolve(new Uint8Array(await blob.arrayBuffer()))
    }, 'image/jpeg', quality)
  })
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
 */
export async function addHistory(ctx, { canvas, source, limit = 50 }) {
  const id = genId()
  const png = await canvasBytes(canvas)
  const thumb = await jpegBytes(makeThumb(canvas))
  await files().write(ctx.meta.id, `${id}.png`, png)
  await files().write(ctx.meta.id, `${id}.t.jpg`, thumb)
  const meta = {
    id,
    source,
    width: canvas.width,
    height: canvas.height,
    bytes: png.length,
    at: new Date().toISOString()
  }
  let metas = await readMetas(ctx)
  metas.unshift(meta)
  const evicted = metas.slice(Math.max(0, limit))
  metas = metas.slice(0, Math.max(0, limit))
  await writeMetas(ctx, metas)
  for (const old of evicted) await removeFiles(old.id)
  return meta
}

async function removeFiles(id) {
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

export async function removeHistory(ctx, id) {
  let metas = await readMetas(ctx)
  metas = metas.filter((m) => m.id !== id)
  await writeMetas(ctx, metas)
  await removeFiles(id)
}

export async function clearHistory(ctx) {
  await writeMetas(ctx, [])
  await files().clear(pluginId()).catch(() => {})
}
