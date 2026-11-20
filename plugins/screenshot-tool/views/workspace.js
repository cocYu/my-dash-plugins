import { settingsView } from './settings.js'
import { captureDesk } from './capture-desk.js'
// 截图工作台：捕获入口（区域/全屏/窗口/粘贴）+ 标注编辑器（历史二次编辑）+ AI 面板 + 历史与设置。
// 区域截图/长截图的「就地编辑」在遮罩窗与长截图控制条内完成（overlay.js / longshot-bar.js），
// 本组件只负责：发起捕获、接收结果记历史、历史管理与二次编辑、全部插件配置。
// 组件树都在本文件组装，库函数见 lib/*。UI 组件从 bundle.ui 取，Vue API 从 bundle.vue 取。

import * as capture from '../lib/capture.js'
import * as historyLib from '../lib/history.js'
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/store.js'
import * as ai from '../lib/ai.js'
import { ocrLocal } from '../lib/ocr.js'
import { pinCanvas, pinDataUrl } from '../lib/pin.js'
import { chooseAppearance } from '../lib/appearance-dialog.js'
import { createEditor } from '../lib/editor.js'

const SOURCE_LABEL = { region: '区域', screen: '全屏', window: '窗口', long: '长图', paste: '粘贴', edit: '编辑', file: '导入' }

function stampName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `Screenshot_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`
}

/** 键盘事件 → Electron accelerator（须含修饰键） */
function acceleratorFromEvent(e) {
  const mods = []
  if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl')
  if (e.shiftKey) mods.push('Shift')
  if (e.altKey) mods.push('Alt')
  const k = e.key
  let key = null
  if (/^[a-zA-Z]$/.test(k)) key = k.toUpperCase()
  else if (/^[0-9]$/.test(k)) key = k
  else if (k === ' ') key = 'Space'
  else if (/^F([1-9]|1[0-9])$/.test(k)) key = k
  else if (k === 'ArrowUp') key = 'Up'
  else if (k === 'ArrowDown') key = 'Down'
  else if (k === 'ArrowLeft') key = 'Left'
  else if (k === 'ArrowRight') key = 'Right'
  if (!key || !mods.length) return null
  return [...mods, key].join('+')
}

export function createWorkspace(bundle) {
  const { vue, ui, ctx } = bundle
  const {
    h,
    ref,
    reactive,
    computed,
    watch,
    defineComponent,
    onMounted,
    onBeforeUnmount
  } = vue
  const {
    ElButton,
    ElDialog,
    ElEmpty,
    ElInput,
    ElTag,
    ElTooltip,
    message,
    messageBox
  } = ui

  const editor = createEditor(bundle)
  const { loadImageToCanvas } = capture

  // ---- 状态 ----
  const tab = ref('shot')
  const settings = reactive({ ...DEFAULT_SETTINGS })
  const providers = ref([])
  const busy = reactive({
    copy: false,
    save: false,
    pin: false,
    ocr: false,
    localOcr: false,
    recognize: false,
    translate: false,
    img2img: false,
    directTest: false
  })
  const results = reactive({ ocr: '', recognize: '', translate: '', images: [] })
  const aiPanel = reactive({
    recognizePrompt: '',
    img2imgPrompt: ''
  })
  const sourceDialog = reactive({ visible: false, type: 'window', sources: [], loading: false })
  const historyList = ref([])
  const thumbs = reactive({})
  // 设置 UI 状态
  const hotkeyRecording = ref(false)
  const hotkeyStatus = ref(null) // { ok, text }
  const directTestStatus = ref(null) // { ok, text }

  const currentProvider = computed(() => providers.value.find((p) => p.id === settings.providerId) || null)
  const modelOptions = computed(() => ai.visibleModels(currentProvider.value))
  const aiCfg = computed(() => ai.resolveAi(settings))
  const visionOk = computed(() => ai.visionReady(aiCfg.value))
  const chatOk = computed(() => ai.chatReady(aiCfg.value))
  const isAppMode = computed(() => settings.aiMode === 'app')
  const imageReady = computed(() => isAppMode.value && !!(settings.providerId && settings.imageModel))
  const hasImage = computed(() => { void editor.version.value; return !editor.isEmpty })
  let documentId = 0
  const currentSource = ref('edit')
  const historyFilter = ref('all')
  const aiBadge = computed(() => {
    if (!aiCfg.value) return '未配置（OCR 将用本地识别兜底）'
    if (aiCfg.value.mode === 'direct') return `独立配置 · ${aiCfg.value.visionModel || aiCfg.value.chatModel}`
    return `主程序供应商 · ${currentProvider.value?.name || aiCfg.value.providerId}`
  })

  // ---- 通用 ----

  async function persistSettings() {
    await saveSettings(ctx, { ...settings })
  }


  async function loadProviders() {
    try {
      providers.value = await ai.listProviders()
      if (settings.providerId && !providers.value.some((p) => p.id === settings.providerId)) {
        settings.providerId = providers.value[0]?.id ?? ''
      }
      if (!settings.providerId) settings.providerId = providers.value[0]?.id ?? ''
      const opts = modelOptions.value.map((m) => m.id)
      for (const key of ['visionModel', 'chatModel', 'imageModel']) {
        if (settings[key] && !opts.includes(settings[key])) settings[key] = ''
      }
      if (!settings.visionModel) settings.visionModel = pickVisionLike(opts) ?? opts[0] ?? ''
      if (!settings.chatModel) settings.chatModel = opts[0] ?? ''
      if (!settings.imageModel) settings.imageModel = pickImageLike(opts) ?? opts[0] ?? ''
    } catch (err) {
      ctx.log('加载供应商失败', err)
    }
  }

  function pickVisionLike(ids) {
    return ids.find((id) => /vision|vl|4o|gemini|glm-4v|多模态|ocr/i.test(id)) || null
  }
  function pickImageLike(ids) {
    return ids.find((id) => /image|dall|seedream|flux|banana|draw|paint/i.test(id)) || null
  }

  function requireEditorImage() {
    if (editor.isEmpty) {
      message.warning('请先截图或从历史中选择一张图片')
      return false
    }
    return true
  }

  function requireAi(kind) {
    if (kind === 'vision' && !visionOk.value) {
      message.warning('请先在「设置 → AI 配置」中完成接口与识图模型配置')
      return false
    }
    if (kind === 'chat' && !chatOk.value) {
      message.warning('请先在「设置 → AI 配置」中完成接口与翻译模型配置')
      return false
    }
    return true
  }

  /** 编辑器当前图入历史（已绑定且未修改则复用原记录） */
  async function ensureHistory(source) {
    if (!editor.state.dirty && editor.state.boundId) return editor.state.boundId
    const canvas = editor.exportCanvas()
    if (!canvas) return null
    const version = editor.version.value
    const meta = await historyLib.addHistory(ctx, { canvas, source: source || 'edit', limit: settings.historyLimit })
    if (editor.version.value === version) {
      editor.state.boundId = meta.id
      editor.state.dirty = false
    }
    await refreshHistory()
    return meta.id
  }

  // ---- 捕获 ----

  function loadIntoEditor(canvas, source, boundId = null, output = boundId ? undefined : settings.appearance) {
    documentId++
    currentSource.value = source
    Object.assign(results, { ocr: '', recognize: '', translate: '', images: [] })
    editor.load(canvas, { boundId, appearance:output })
    editor.state.dirty = !!(output?.rounded || (output?.shell && output.shell !== 'none'))
    tab.value = 'shot'
  }

  async function captureAndLoad(source, canvas) {
    loadIntoEditor(canvas, source)
    const version = editor.version.value
    const meta = await historyLib.addHistory(ctx, { canvas, source, limit: settings.historyLimit })
    if (editor.version.value === version) editor.state.boundId = meta.id
    await refreshHistory()
    message.success(`截图完成（已存入历史 · ${SOURCE_LABEL[source] || source}）`)
  }

  function openSourceDialog(type) {
    sourceDialog.type = type
    sourceDialog.visible = true
    sourceDialog.loading = true
    sourceDialog.sources = []
    capture
      .listSources()
      .then((sources) => {
        sourceDialog.sources = sources.filter((s) => s.type === type)
      })
      .catch((err) => {
        message.error(`获取窗口/屏幕列表失败：${err.message}`)
      })
      .finally(() => {
        sourceDialog.loading = false
      })
  }

  async function chooseSource(s) {
    sourceDialog.visible = false
    try {
      const canvas = await capture.grabSource(s.id)
      await captureAndLoad(s.type === 'screen' ? 'screen' : 'window', canvas)
    } catch (err) {
      message.error(
        err?.name === 'NotReadableError'
          ? '该窗口受系统保护无法捕获，请换一个窗口'
          : `抓取失败：${err.message}`
      )
    }
  }

  function startRegion(delay = 0) {
    return capture
      .startRegion(ctx.meta.id, delay)
      .catch((err) => message.error(`无法启动区域截图：${err.message}`))
  }

  async function pasteImage() {
    const canvas = await capture.pasteFromClipboard()
    if (!canvas) {
      message.warning('剪贴板中没有图片')
      return
    }
    await captureAndLoad('paste', canvas)
  }

  // ---- 导出动作（针对编辑器当前图，即历史二次编辑场景） ----

  async function copyCurrent() {
    if (!requireEditorImage() || busy.copy) return
    busy.copy = true
    try {
      const id = await ensureHistory('edit')
      if (!id) return
      const r = await window.api.plugins.files.copyImage(ctx.meta.id, `${id}.png`)
      if (r.ok) message.success('已复制到剪贴板')
      else message.error(r.message || '复制失败')
    } catch (err) {
      message.error(`复制失败：${err.message}`)
    } finally {
      busy.copy = false
    }
  }

  async function saveCurrent(useDialog = false) {
    if (!requireEditorImage() || busy.save) return
    busy.save = true
    try {
      const bytes = await editor.exportBytes()
      if (!bytes) return
      const r = await capture.saveImageFile({
        bytes,
        ext: '.png',
        dir: settings.saveDir && !useDialog ? settings.saveDir : undefined,
        defaultName: stampName()
      })
      if (r.saved) message.success(`已保存：${r.filePath}`)
      else message.info('已取消保存')
      if (r.saved) await ensureHistory('edit')
    } catch (err) {
      message.error(`保存失败：${err.message}`)
    } finally {
      busy.save = false
    }
  }

  async function pinCurrent() {
    if (!requireEditorImage() || busy.pin) return
    busy.pin = true
    try {
      const canvas = editor.exportCanvas()
      await pinCanvas(ctx, canvas)
      message.success('已钉到屏幕（拖动移动 · 滚轮缩放 · 双击关闭）')
    } catch (err) {
      message.error(`贴图失败：${err.message}`)
    } finally {
      busy.pin = false
    }
  }

  // ---- AI 动作 ----

  async function runOcr(mode = 'ai') {
    if (!requireEditorImage()) return
    if (mode === 'ai' && !requireAi('vision')) return
    const key = mode === 'ai' ? 'ocr' : 'localOcr'
    const id = documentId
    busy[key] = true
    try {
      const image = editor.exportScene()
      const input = mode === 'ai' ? ai.aiImageInput(image) : image.toDataURL('image/png')
      let text
      if (mode === 'ai') {
        text = await ai.visionChatResolved(aiCfg.value, {
          prompt: ai.OCR_PROMPT,
          imageDataUrl: input
        })
      } else {
        text = await ocrLocal({
          imageDataUrl: input,
          langs: settings.tesseractLangs,
          onProgress: (p, status) => {
            if (status === 'recognizing text') busy.localOcrProgress = Math.round(p * 100)
          }
        })
      }
      if (documentId !== id) return
      results.ocr = text
      if (!results.ocr) message.info('未识别到文字')
    } catch (err) {
      message.error(`OCR 失败：${err.message}`)
    } finally {
      busy[key] = false
    }
  }

  async function runRecognize() {
    if (!requireEditorImage() || !requireAi('vision') || busy.recognize) return
    const id = documentId
    busy.recognize = true
    try {
      const input = ai.aiImageInput(editor.exportScene())
      const text = await ai.visionChatResolved(aiCfg.value, {
        prompt: aiPanel.recognizePrompt.trim() || ai.RECOGNIZE_PROMPT,
        imageDataUrl: input
      })
      if (id === documentId) results.recognize = text
    } catch (err) {
      message.error(`识图失败：${err.message}`)
    } finally {
      busy.recognize = false
    }
  }

  async function runTranslate() {
    const text = results.ocr.trim()
    if (!text) {
      message.warning('请先完成 OCR（翻译基于 OCR 文本，可在结果框中修改）')
      return
    }
    if (!requireAi('chat') || busy.translate) return
    const id = documentId
    busy.translate = true
    try {
      const translated = await ai.textChatResolved(aiCfg.value, {
        system: `你是专业翻译。把用户发来的内容翻译成${settings.targetLang}，只输出译文，保留原有排版。`,
        prompt: text
      })
      if (id === documentId) results.translate = translated
    } catch (err) {
      message.error(`翻译失败：${err.message}`)
    } finally {
      busy.translate = false
    }
  }

  async function runImg2img() {
    const prompt = aiPanel.img2imgPrompt.trim()
    if (!prompt) {
      message.warning('请输入图生图的改图描述（如：把背景改成星空）')
      return
    }
    if (!requireEditorImage() || !imageReady.value || busy.img2img) return
    const id = documentId
    busy.img2img = true
    results.images = []
    try {
      const input = ai.aiImageInput(editor.exportScene(), 1536)
      const list = await ai.imageToImage({
        providerId: settings.providerId,
        model: settings.imageModel,
        prompt,
        imageDataUrl: input
      })
      if (id !== documentId) return
      results.images = list
      if (!list.length) message.info('供应商未返回图片')
    } catch (err) {
      message.error(`图生图失败：${err.message}`)
    } finally {
      busy.img2img = false
    }
  }

  async function testDirectAi() {
    busy.directTest = true
    directTestStatus.value = null
    try {
      await ai.testDirectAi({
        protocol: settings.direct.protocol,
        baseUrl: settings.direct.baseUrl,
        apiKey: settings.direct.apiKey,
        model: settings.direct.visionModel || settings.direct.chatModel
      })
      directTestStatus.value = { ok: true, text: '连接成功' }
    } catch (err) {
      directTestStatus.value = { ok: false, text: err.message.slice(0, 120) }
    } finally {
      busy.directTest = false
    }
  }

  // ---- 全局快捷键 ----

  async function applyHotkey() {
    if (!window.api.shortcuts?.register) return
    hotkeyStatus.value = null
    try {
      if (!settings.hotkey.enabled || !settings.hotkey.accelerator) {
        await window.api.shortcuts.unregister(ctx.meta.id)
        return
      }
      const r = await window.api.shortcuts.register({
        pluginId: ctx.meta.id,
        action: 'capture-region',
        accelerator: settings.hotkey.accelerator
      })
      hotkeyStatus.value = r.ok
        ? { ok: true, text: `已生效：${settings.hotkey.accelerator}` }
        : { ok: false, text: r.error || '注册失败' }
    } catch (err) {
      hotkeyStatus.value = { ok: false, text: err.message }
    }
  }

  function onHotkeyKeydown(e) {
    if (!hotkeyRecording.value) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      hotkeyRecording.value = false
      e.target?.blur?.()
      return
    }
    const acc = acceleratorFromEvent(e)
    if (acc) {
      settings.hotkey.accelerator = acc
      hotkeyRecording.value = false
      e.target?.blur?.()
      void applyHotkey()
    }
  }

  // ---- 历史 ----

  async function refreshHistory() {
    const list = await historyLib.listHistory(ctx)
    historyList.value = list
    if (!list.some(item => item.id === editor.state.boundId)) editor.state.boundId = null
    const ids = new Set(list.map(item => item.id))
    for (const key of Object.keys(thumbs)) if (!ids.has(key)) delete thumbs[key]
    for (const item of list) {
      if (!thumbs[item.id]) {
        historyLib
          .readThumb(ctx, item.id)
          .then((url) => {
            thumbs[item.id] = url
          })
          .catch(() => {})
      }
    }
  }

  async function openHistoryItem(item) {
    const url = await historyLib.readImageDataUrl(ctx, item.id)
    const canvas = await loadImageToCanvas(url)
    loadIntoEditor(canvas, item.source, item.id)
    results.ocr = item.note || ''
    message.info('已载入编辑器，修改后导出会保留原图')
  }

  async function copyHistoryItem(item) {
    const r = await historyLib.copyHistoryImage(ctx, item.id)
    if (r.ok) message.success('已复制到剪贴板')
    else message.error(r.message || '复制失败')
  }

  async function saveHistoryItem(item) {
    const bytes = await historyLib.readImageBytes(ctx, item.id)
    if (!bytes) {
      message.error('图片文件缺失')
      return
    }
    const r = await capture.saveImageFile({ bytes, ext: '.png', defaultName: stampName() })
    if (r.saved) message.success(`已保存：${r.filePath}`)
  }

  async function pinHistoryItem(item) {
    const url = await historyLib.readImageDataUrl(ctx, item.id)
    await pinDataUrl(ctx, url, item.width, item.height)
  }

  async function removeHistoryItem(item) {
    await historyLib.removeHistory(ctx, item.id)
    if (editor.state.boundId === item.id) editor.state.boundId = null
    delete thumbs[item.id]
    await refreshHistory()
  }

  async function clearHistoryAll() {
    try {
      await messageBox.confirm(`确定清空全部 ${historyList.value.length} 条截图历史？文件将一并删除。`, '清空历史', {
        type: 'warning',
        confirmButtonText: '清空',
        cancelButtonText: '取消'
      })
    } catch {
      return
    }
    await historyLib.clearHistory(ctx)
    editor.state.boundId = null
    Object.keys(thumbs).forEach((k) => delete thumbs[k])
    await refreshHistory()
    message.success('已清空')
  }

  // ---- 设置 ----

  async function chooseSaveDir() {
    const r = await capture.chooseDir()
    if (r?.dir) {
      settings.saveDir = r.dir
      message.success(`保存目录：${r.dir}`)
    }
  }

  function switchProvider(v) {
    settings.providerId = v
    const opts = modelOptions.value.map((m) => m.id)
    for (const key of ['visionModel', 'chatModel', 'imageModel']) {
      if (!opts.includes(settings[key])) settings[key] = ''
    }
  }

  // ---- 渲染 ----

  async function importFile(file) {
    if (!file) return
    if (!/^image\/(png|jpeg|webp|gif|bmp)$/i.test(file.type)) throw new Error('请选择 PNG、JPEG、WebP、GIF 或 BMP 图片')
    if (file.size > 32 * 1024 * 1024) throw new Error('图片超过 32 MB')
    await captureAndLoad('file', await capture.blobToCanvas(file))
  }
  const renderCaptureBar = captureDesk({ h, ref, startRegion, openSourceDialog, pasteImage, importFile, message })

  function renderActions() {
    return h('div', { class: 'st-actions' }, [
      h(ElButton, { type: 'primary', loading: busy.copy, disabled: !hasImage.value, onClick: copyCurrent }, () => '复制'),
      h(
        ElButton,
        { loading: busy.save, disabled: !hasImage.value, onClick: () => saveCurrent(false) },
        () => (settings.saveDir ? '保存' : '另存为…')
      ),
      settings.saveDir
        ? h(ElButton, { disabled: !hasImage.value, onClick: () => saveCurrent(true) }, () => '另存为…')
        : null,
      h(ElButton, { loading: busy.pin, disabled: !hasImage.value, onClick: pinCurrent }, () => '贴到屏幕'),
      h(ElButton, {onClick:()=>chooseAppearance(editor.exportScene(),editor.state.appearance,editor.setAppearance)}, ()=>'截图外观…')
    ])
  }

  function renderAiActions() {
    return h('div', {class:'st-actions'}, [
      h(ElTag, { effect: 'plain', size: 'small', type: aiCfg.value ? 'info' : 'warning' }, () => aiBadge.value),
      h(ElButton, { loading: busy.ocr, disabled: !hasImage.value || !visionOk.value, onClick: () => runOcr('ai') }, () => 'OCR 提取'),
      h(ElButton, { loading: busy.localOcr, disabled: !hasImage.value, title: '本地识别兜底（首次需下载模型）', onClick: () => runOcr('local') }, () => '本地OCR'),
      h(ElButton, { loading: busy.recognize, disabled: !hasImage.value || !visionOk.value, onClick: runRecognize }, () => 'AI 识图'),
      h(ElButton, { loading: busy.translate, disabled: !chatOk.value, onClick: runTranslate }, () => '翻译')
    ])
  }

  function renderAiPanel() {
    return h('div', { class: 'st-ai-panel' }, [
      h('div', { class: 'st-ai-row' }, [
        h('span', { class: 'st-ai-label' }, '识图提问'),
        h(ElInput, {
          modelValue: aiPanel.recognizePrompt,
          'onUpdate:modelValue': (v) => (aiPanel.recognizePrompt = v),
          placeholder: '留空使用默认提问（描述截图内容）',
          size: 'small',
          style: 'flex:1;min-width:220px',
          clearable: true
        })
      ]),
      h('div', { class: 'st-ai-row' }, [
        h('span', { class: 'st-ai-label' }, '图生图'),
        h(ElInput, {
          modelValue: aiPanel.img2imgPrompt,
          'onUpdate:modelValue': (v) => (aiPanel.img2imgPrompt = v),
          placeholder: isAppMode.value
            ? '改图描述，如：把背景换成星空、转成水彩风格'
            : '独立配置模式不支持图生图，切换到「复用主程序」后可用',
          size: 'small',
          style: 'flex:1;min-width:220px',
          clearable: true,
          disabled: !isAppMode.value
        }),
        h(
          ElButton,
          {
            size: 'small',
            type: 'primary',
            loading: busy.img2img,
            disabled: !hasImage.value || !imageReady.value,
            onClick: runImg2img
          },
          () => 'AI 图生图'
        )
      ])
    ])
  }

  function resultBlock(label, textKey) {
    return h('div', { class: 'st-result' }, [
      h('div', { class: 'st-result-head' }, [
        h('span', { class: 'st-result-title' }, label),
        h('div', { class: 'st-flex-grow' }),
        h(ElButton, { size: 'small', text: true, onClick: () => copyText(results[textKey]) }, () => '复制')
      ]),
      h(ElInput, {
        type: 'textarea',
        rows: 5,
        modelValue: results[textKey],
        'onUpdate:modelValue': (v) => (results[textKey] = v),
        placeholder: '…'
      })
    ])
  }

  function renderResults() {
    if (!results.ocr && !results.recognize && !results.translate && !results.images.length) return null
    return h('div', { class: 'st-results' }, [
      results.ocr ? resultBlock('OCR 文字（可编辑，翻译基于此文本）', 'ocr') : null,
      results.recognize ? resultBlock('AI 识图结果', 'recognize') : null,
      results.translate ? resultBlock(`翻译结果 → ${settings.targetLang}`, 'translate') : null,
      results.images.length
        ? h('div', { class: 'st-result' }, [
            h('div', { class: 'st-result-head' }, [
              h('span', { class: 'st-result-title' }, '图生图结果'),
              h('span', { class: 'st-hint' }, '点击图片载入编辑器')
            ]),
            h(
              'div',
              { class: 'st-result-images' },
              results.images.map((r, i) =>
                h('div', { class: 'st-result-img', key: i, onClick: () => loadResultImage(r) }, [
                  h('img', { src: r.dataUrl }),
                  h(ElButton, {
                    size: 'small',
                    style: 'margin-top:4px',
                    onClick: (e) => {
                      e.stopPropagation()
                      void saveResultImage(r)
                    }
                  }, () => '保存')
                ])
              )
            )
          ])
        : null
    ])
  }

  async function loadResultImage(r) {
    const canvas = await ai.resultToCanvas(r)
    loadIntoEditor(canvas, 'edit')
    message.success('已载入编辑器')
  }

  async function saveResultImage(r) {
    const bytes = await new Promise((resolve, reject) => {
      fetch(r.dataUrl)
        .then((res) => res.arrayBuffer())
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch(reject)
    })
    const res = await capture.saveImageFile({ bytes, ext: '.png', dir: settings.saveDir || undefined, defaultName: `AI_${stampName()}` })
    if (res.saved) message.success(`已保存：${res.filePath}`)
  }

  async function copyText(text) {
    if (!text) return
    await navigator.clipboard.writeText(text)
    message.success('已复制')
  }

  function renderSourceDialog() {
    return h(ElDialog, {
      modelValue: sourceDialog.visible,
      'onUpdate:modelValue': (v) => (sourceDialog.visible = v),
      title: sourceDialog.type === 'screen' ? '选择要截取的屏幕' : '选择要截取的窗口',
      width: 'min(720px, 92vw)'
    }, {
      default: () =>
        sourceDialog.loading
          ? h('div', { class: 'st-dialog-loading' }, '正在枚举窗口…')
          : !sourceDialog.sources.length ? h(ElEmpty, {description: '没有可用画面，请检查屏幕录制权限后重试'}) : h(
              'div',
              { class: 'st-source-grid' },
              sourceDialog.sources.map((s) =>
                h(
                  'button',
                  { class: 'st-source-card', key: s.id, onClick: () => chooseSource(s) },
                  [
                    h('img', { class: 'st-source-thumb', src: s.thumbnail }),
                    h('div', { class: 'st-source-name' }, [
                      s.appIcon ? h('img', { class: 'st-source-icon', src: s.appIcon }) : null,
                      h('span', { title: s.name }, s.name)
                    ])
                  ]
                )
              )
            )
    })
  }

  // ---- 历史 tab ----

  function renderHistory() {
    const visible = historyList.value.filter(item => historyFilter.value === 'all' || item.source === historyFilter.value)
    if (!historyList.value.length) {
      return h(ElEmpty, { description: '暂无截图历史（每次截图自动保存在这里）' })
    }
    return h('div', { class: 'st-history' }, [
      h('div', { class: 'st-history-bar' }, [
        h('select', { 'aria-label':'按来源筛选历史', value:historyFilter.value, onChange:e => historyFilter.value = e.target.value }, [h('option',{value:'all'},'全部来源'), ...Object.entries(SOURCE_LABEL).map(([value,label]) => h('option',{value},label))]),
        h('span', { class: 'st-hint' }, `共 ${historyList.value.length} 条（保留最近 ${settings.historyLimit} 条）`),
        h('div', { class: 'st-flex-grow' }),
        h(ElButton, { size: 'small', onClick: refreshHistory }, () => '刷新'),
        h(ElButton, { size: 'small', type: 'danger', plain: true, onClick: clearHistoryAll }, () => '清空')
      ]),
      h(
        'div',
        { class: 'st-history-grid' },
        !visible.length ? [h('p', {}, '此来源暂无截图')] : visible.map((item) =>
          h('div', { class: 'st-history-card', key: item.id }, [
            h('button', { 'aria-label':'打开截图', class: 'st-history-thumb', onClick: () => openHistoryItem(item) }, [
              thumbs[item.id] ? h('img', { src: thumbs[item.id], loading: 'lazy' }) : h('div', { class: 'st-thumb-loading' }, '…')
            ]),
            h('div', { class: 'st-history-meta' }, [
              h('span', {}, new Date(item.at).toLocaleString()),
              h(
                'span',
                { class: 'st-history-sub' },
                `${SOURCE_LABEL[item.source] || item.source} · ${item.width}×${item.height} · ${Math.max(1, Math.round(item.bytes / 1024))}KB`
              )
            ]),
            h('div', { class: 'st-history-actions' }, [
              h(ElTooltip, { content: '载入编辑器', showAfter: 400 }, { default: () => h(ElButton, { size: 'small', text: true, onClick: () => openHistoryItem(item) }, () => '编辑') }),
              h(ElTooltip, { content: '复制原图', showAfter: 400 }, { default: () => h(ElButton, { size: 'small', text: true, onClick: () => copyHistoryItem(item) }, () => '复制') }),
              h(ElTooltip, { content: '另存为', showAfter: 400 }, { default: () => h(ElButton, { size: 'small', text: true, onClick: () => saveHistoryItem(item) }, () => '另存') }),
              h(ElTooltip, { content: '钉到屏幕', showAfter: 400 }, { default: () => h(ElButton, { size: 'small', text: true, onClick: () => pinHistoryItem(item) }, () => '贴图') }),
              h(ElTooltip, { content: '删除', showAfter: 400 }, { default: () => h(ElButton, { size: 'small', text: true, type: 'danger', onClick: () => removeHistoryItem(item) }, () => '删除') })
            ])
          ])
        )
      )
    ])
  }

  // ---- 设置 tab ----

  const renderSettings = settingsView({ h, ui, settings, modelOptions, chooseSaveDir, busy, testDirectAi, directTestStatus, switchProvider, providers, isAppMode, hotkeyRecording, applyHotkey, onHotkeyKeydown, hotkeyStatus })

  // ---- 主渲染 ----

  const component = defineComponent({
    name: 'ScreenshotWorkspace',
    setup() {
      // 生命周期必须在 setup() 内注册（工厂函数体里没有组件实例，注册会静默失效）
      let mounted = true
      const stop = ctx.events.on('screenshot-tool:archived', () => { void refreshHistory() })
      let stopWatch
      onMounted(async () => {
        try {
          const saved = await loadSettings(ctx)
          if (!mounted) return
          Object.assign(settings, saved)
          stopWatch = watch(settings, () => persistSettings().catch(err => message.error(`保存设置失败：${err.message}`)), { deep: true })
          await Promise.all([loadProviders(), refreshHistory()])
        } catch (err) { message.error(`载入截图工作台失败：${err.message}`) }
      })
      onBeforeUnmount(() => { mounted = false; stopWatch?.(); stop() })
      const nav = (name, label) => h('button', { class: 'st-nav-item', 'aria-pressed': tab.value === name,
        onClick: () => { tab.value = name } }, label)
      return () => h('section', { class: 'st-workspace' }, [
        h('header', { class:'st-heading' }, [
          h('div', {}, [h('span', { class:'st-kicker' }, 'CAPTURE STUDIO'), h('h2', {}, '截图工作台')]),
          h('nav', { 'aria-label':'截图工作台导航' }, [nav('shot','工作台'), nav('history',`历史 · ${historyList.value.length}`), nav('settings','设置')])
        ]),
        tab.value === 'history' ? renderHistory() : tab.value === 'settings' ? renderSettings() : [
          renderCaptureBar(),
          hasImage.value ? h('section', {class:'st-current'}, [
            h('div', {class:'st-section-title'}, [h('h3',{},'当前截图'),h('span',{class:'st-hint'}, `${SOURCE_LABEL[currentSource.value]} · ${editor.state.width} × ${editor.state.height} px`)]),
            h('div', {class:'st-editor-host'}, [h(editor.component)]), renderActions(),
            h('details', {class:'st-inspect'}, [h('summary',{},'文字提取与 AI 识图'), h('p',{class:'st-hint'},'本地 OCR 不上传截图；AI 操作会将图像或文字发送至设置中的供应商。'), renderAiActions(), renderAiPanel(), renderResults()])
          ]) : h('div', {class:'st-empty-note'}, [h('strong',{},'还没有待编辑的图片'), h('span',{},'框选后可直接复制、保存或贴图。要继续编辑已完成的截图，请从历史中打开。')])
        ], renderSourceDialog()
      ])
    }
  })
  return {component, openLongshot(canvas,id,output) {
    loadIntoEditor(canvas,'long',id,output)
    location.hash = `/toolbox/${ctx.meta.id}:screenshot`
  }}
}
