// 本地 OCR 兜底：运行时从 CDN 懒加载 tesseract.js（含中文语言包，首次约 20MB，之后浏览器缓存）。
// 作为 AI 视觉模型识别的离线兜底方案。

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js'

let modPromise = null

function loadModule() {
  if (!modPromise) modPromise = import(/* @vite-ignore */ TESSERACT_CDN).catch(err => { modPromise = null; throw err })
  return modPromise
}

/**
 * 本地识别。langs 默认简中+英文（首次使用会下载对应训练数据）。
 * @returns {{ text: string }}
 */
export async function ocrLocal({ imageDataUrl, langs = 'chi_sim+eng', onProgress }) {
  const mod = await loadModule()
  const createWorker = mod.createWorker ?? mod.default?.createWorker
  if (!createWorker) throw new Error('本地 OCR 引擎未能加载，请检查网络后重试')
  const worker = await createWorker(langs, 1, {
    logger: (m) => {
      if (onProgress && typeof m?.progress === 'number') onProgress(m.progress, m.status)
    }
  })
  try {
    const { data } = await worker.recognize(imageDataUrl)
    return data?.text ?? ''
  } finally {
    await worker.terminate().catch(() => {})
  }
}
