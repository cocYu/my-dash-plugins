// 截图工作台：捕获入口（区域/全屏/窗口/长图/粘贴）+ 标注编辑器 + AI 面板 + 历史与设置。
// 组件树都在本文件组装，库函数见 lib/*。UI 组件从 bundle.ui 取，Vue API 从 bundle.vue 取。

import * as capture from '../lib/capture.js'
import * as historyLib from '../lib/history.js'
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/store.js'
import * as ai from '../lib/ai.js'
import { ocrLocal } from '../lib/ocr.js'
import { pinCanvas, pinDataUrl } from '../lib/pin.js'
import { createStitcher } from '../lib/stitch.js'
import { applyShell, SHELLS } from '../lib/shell.js'
import { createEditor } from '../lib/editor.js'

const SOURCE_LABEL = { region: '区域', screen: '全屏', window: '窗口', long: '长图', paste: '粘贴', edit: '编辑' }

function stampName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `Screenshot_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`
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
    ElCheckbox,
    ElDialog,
    ElDropdown,
    ElDropdownItem,
    ElDropdownMenu,
    ElEmpty,
    ElForm,
    ElFormItem,
    ElInput,
    ElInputNumber,
    ElOption,
    ElSelect,
    ElTabPane,
    ElTabs,
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
    img2img: false
  })
  const results = reactive({ ocr: '', recognize: '', translate: '', images: [] })
  const aiPanel = reactive({
    recognizePrompt: '',
    img2imgPrompt: '',
    shell: 'none'
  })
  const sourceDialog = reactive({ visible: false, type: 'window', sources: [], loading: false, forLongshot: false })
  const historyList = ref([])
  const thumbs = reactive({})
  const longshot = reactive({
    active: false,
    auto: false,
    height: 0,
    segments: 0,
    sourceName: '',
    grabbing: false,
    session: null,
    stitcher: null,
    timer: null,
    pending: false
  })

  const currentProvider = computed(() => providers.value.find((p) => p.id === settings.providerId) || null)
  const modelOptions = computed(() => ai.visibleModels(currentProvider.value))
  const visionReady = computed(() => !!(settings.providerId && settings.visionModel))
  const chatReady = computed(() => !!(settings.providerId && settings.chatModel))
  const imageReady = computed(() => !!(settings.providerId && settings.imageModel))
  const hasImage = computed(() => !!editor.state.width)

  // ---- 通用 ----

  async function persistSettings() {
    await saveSettings(ctx, { ...settings })
  }
  watch(settings, persistSettings, { deep: true })

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

  function requireProvider(modelKey) {
    if (!settings.providerId) {
      message.warning('请先在「设置」中选择 AI 供应商（在主应用 AI 工作台配置）')
      return false
    }
    if (!settings[modelKey]) {
      message.warning('请先在「设置」中选择对应模型')
      return false
    }
    return true
  }

  /** 编辑器当前图入历史（已绑定且未修改则复用原记录） */
  async function ensureHistory(source) {
    if (!editor.state.dirty && editor.state.boundId) return editor.state.boundId
    const canvas = editor.exportCanvas()
    if (!canvas) return null
    const meta = await historyLib.addHistory(ctx, { canvas, source: source || 'edit', limit: settings.historyLimit })
    editor.state.boundId = meta.id
    editor.state.dirty = false
    await refreshHistory()
    return meta.id
  }

  // ---- 捕获 ----

  function loadIntoEditor(canvas, source, boundId = null) {
    editor.load(canvas, { boundId })
    tab.value = 'shot'
  }

  async function captureAndLoad(source, canvas) {
    loadIntoEditor(canvas, source)
    const meta = await historyLib.addHistory(ctx, { canvas, source, limit: settings.historyLimit })
    editor.state.boundId = meta.id
    await refreshHistory()
    message.success(`截图完成（已存入历史 · ${SOURCE_LABEL[source] || source}）`)
  }

  function openSourceDialog(type, forLongshot = false) {
    sourceDialog.type = type
    sourceDialog.forLongshot = forLongshot
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
      if (sourceDialog.forLongshot) {
        await startLongshot(s)
        return
      }
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

  function startRegion() {
    capture
      .startRegion(ctx.meta.id)
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

  // ---- 长图 ----

  async function startLongshot(source) {
    try {
      longshot.session = await capture.openCaptureStream(source.id)
      longshot.stitcher = createStitcher()
      longshot.sourceName = source.name
      longshot.height = 0
      longshot.segments = 0
      longshot.active = true
      longshot.auto = false
      await captureSegment()
    } catch (err) {
      message.error(`长图启动失败：${err.message}`)
      stopLongshot(false)
    }
  }

  async function captureSegment() {
    if (!longshot.session || longshot.grabbing) return
    longshot.grabbing = true
    try {
      const frame = await longshot.session.grab()
      const r = longshot.stitcher.append(frame)
      longshot.height = r.height
      longshot.segments += 1
      if (r.noNew) message.info('画面与上一段相同：请先滚动目标窗口再抓取')
      if (r.truncated) message.warning('已达长图高度上限，停止追加')
    } catch (err) {
      message.error(`抓取失败：${err.message}`)
    } finally {
      longshot.grabbing = false
    }
  }

  function setAuto(on) {
    longshot.auto = on
    if (longshot.timer) {
      clearInterval(longshot.timer)
      longshot.timer = null
    }
    if (on) {
      longshot.timer = setInterval(() => {
        void captureSegment()
      }, Math.max(300, settings.intervalMs))
    }
  }

  async function finishLongshot() {
    const canvas = longshot.stitcher?.result()
    setAuto(false)
    longshot.session?.close()
    longshot.session = null
    longshot.active = false
    if (!canvas) return
    await captureAndLoad('long', canvas)
  }

  function stopLongshot(notify = true) {
    setAuto(false)
    longshot.session?.close()
    longshot.session = null
    longshot.stitcher = null
    longshot.active = false
    if (notify) message.info('已取消长图')
  }

  // ---- 导出动作 ----

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
      await ensureHistory('edit')
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

  function applyShellToCurrent(shellId) {
    if (!requireEditorImage()) return
    const canvas = editor.exportCanvas()
    if (!canvas) return
    const shelled = applyShell(canvas, shellId)
    loadIntoEditor(shelled, 'edit')
    message.success(shellId === 'none' ? '已移除壳' : '已套壳（原截图仍在历史中）')
  }

  // ---- AI 动作 ----

  async function runOcr(mode = 'ai') {
    if (!requireEditorImage()) return
    if (mode === 'ai' && !requireProvider('visionModel')) return
    const key = mode === 'ai' ? 'ocr' : 'localOcr'
    busy[key] = true
    try {
      const input = ai.aiImageInput(editor.exportCanvas())
      if (mode === 'ai') {
        results.ocr = await ai.visionChat({
          providerId: settings.providerId,
          model: settings.visionModel,
          prompt: ai.OCR_PROMPT,
          imageDataUrl: input
        })
      } else {
        results.ocr = await ocrLocal({
          imageDataUrl: input,
          langs: settings.tesseractLangs,
          onProgress: (p, status) => {
            if (status === 'recognizing text') busy.localOcrProgress = Math.round(p * 100)
          }
        })
      }
      if (!results.ocr) message.info('未识别到文字')
    } catch (err) {
      message.error(`OCR 失败：${err.message}`)
    } finally {
      busy[key] = false
    }
  }

  async function runRecognize() {
    if (!requireEditorImage() || !requireProvider('visionModel') || busy.recognize) return
    busy.recognize = true
    try {
      const input = ai.aiImageInput(editor.exportCanvas())
      results.recognize = await ai.visionChat({
        providerId: settings.providerId,
        model: settings.visionModel,
        prompt: aiPanel.recognizePrompt.trim() || ai.RECOGNIZE_PROMPT,
        imageDataUrl: input
      })
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
    if (!requireProvider('chatModel') || busy.translate) return
    busy.translate = true
    try {
      results.translate = await ai.textChat({
        providerId: settings.providerId,
        model: settings.chatModel,
        system: `你是专业翻译。把用户发来的内容翻译成${settings.targetLang}，只输出译文，保留原有排版。`,
        prompt: text
      })
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
    if (!requireEditorImage() || !requireProvider('imageModel') || busy.img2img) return
    busy.img2img = true
    results.images = []
    try {
      const input = ai.aiImageInput(editor.exportCanvas(), 1536)
      const list = await ai.imageToImage({
        providerId: settings.providerId,
        model: settings.imageModel,
        prompt,
        imageDataUrl: input
      })
      results.images = list
      if (!list.length) message.info('供应商未返回图片')
    } catch (err) {
      message.error(`图生图失败：${err.message}`)
    } finally {
      busy.img2img = false
    }
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

  // ---- 历史 ----

  async function refreshHistory() {
    const list = await historyLib.listHistory(ctx)
    historyList.value = list
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
    message.info('已载入编辑器（保存/复制时会更新这条历史）')
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

  const TARGET_LANGS = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский']

  // ---- 渲染 ----

  function renderCaptureBar() {
    return h('div', { class: 'st-cap-bar' }, [
      h(ElButton, { type: 'primary', onClick: startRegion }, () => '🖼 区域截图'),
      h(ElButton, { onClick: () => openSourceDialog('screen') }, () => '截全屏'),
      h(ElButton, { onClick: () => openSourceDialog('window') }, () => '应用窗口'),
      h(ElButton, { type: 'warning', plain: true, onClick: () => openSourceDialog('window', true) }, () => '截长图'),
      h(ElButton, { onClick: pasteImage }, () => '粘贴图片'),
      h('div', { class: 'st-flex-grow' }),
      h(
        ElDropdown,
        {
          disabled: !hasImage.value,
          onCommand: (id) => applyShellToCurrent(id)
        },
        {
          default: () => h(ElButton, { disabled: !hasImage.value }, () => '带壳截图 ▾'),
          dropdown: () => [
            h(ElDropdownMenu, {}, () =>
              SHELLS.map((s) => h(ElDropdownItem, { key: s.id, command: s.id }, () => s.name))
            )
          ]
        }
      )
    ])
  }

  function renderLongshotPanel() {
    if (!longshot.active) return null
    return h('div', { class: 'st-longshot' }, [
      h('span', { class: 'st-longshot-name' }, `长图模式 · ${longshot.sourceName}`),
      h('span', { class: 'st-longshot-stat' }, `已拼接 ${longshot.segments} 段 · 高 ${longshot.height}px`),
      h(ElCheckbox, {
        modelValue: longshot.auto,
        'onUpdate:modelValue': setAuto,
        label: '自动抓帧'
      }),
      h(ElButton, { size: 'small', loading: longshot.grabbing, onClick: captureSegment }, () => '抓取一段'),
      h(ElButton, { size: 'small', type: 'primary', onClick: finishLongshot }, () => '完成拼接'),
      h(ElButton, { size: 'small', onClick: () => stopLongshot() }, () => '取消')
    ])
  }

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
      h(ElButton, { loading: busy.pin, disabled: !hasImage.value, onClick: pinCurrent }, () => '📌 钉到屏幕'),
      h('div', { class: 'st-flex-grow' }),
      h(ElButton, { loading: busy.ocr, disabled: !hasImage.value || !visionReady.value, onClick: () => runOcr('ai') }, () => 'OCR 提取'),
      h(ElButton, { loading: busy.localOcr, disabled: !hasImage.value, title: '本地识别兜底（首次需下载模型）', onClick: () => runOcr('local') }, () => '本地OCR'),
      h(ElButton, { loading: busy.recognize, disabled: !hasImage.value || !visionReady.value, onClick: runRecognize }, () => 'AI 识图'),
      h(ElButton, { loading: busy.translate, disabled: !chatReady.value, onClick: runTranslate }, () => '翻译')
    ])
  }

  function renderAiPanel() {
    const modelSelect = (modelKey, placeholder) =>
      h(
        ElSelect,
        {
          modelValue: settings[modelKey],
          'onUpdate:modelValue': (v) => (settings[modelKey] = v),
          placeholder,
          size: 'small',
          style: 'width:220px',
          clearable: true,
          filterable: true
        },
        () => modelOptions.value.map((m) => h(ElOption, { key: m.id, value: m.id, label: m.name || m.id }))
      )

    return h('div', { class: 'st-ai-panel' }, [
      h('div', { class: 'st-ai-row' }, [
        h('span', { class: 'st-ai-label' }, '识图/OCR 模型'),
        modelSelect('visionModel', '选择视觉模型'),
        h('span', { class: 'st-ai-label' }, '翻译模型'),
        modelSelect('chatModel', '选择文本模型'),
        h('span', { class: 'st-ai-label' }, '翻译目标'),
        h(
          ElSelect,
          {
            modelValue: settings.targetLang,
            'onUpdate:modelValue': (v) => (settings.targetLang = v),
            size: 'small',
            style: 'width:130px'
          },
          () => TARGET_LANGS.map((l) => h(ElOption, { key: l, value: l, label: l }))
        )
      ]),
      h('div', { class: 'st-ai-row' }, [
        h('span', { class: 'st-ai-label' }, '图生图模型'),
        modelSelect('imageModel', '选择生图模型'),
        h(ElInput, {
          modelValue: aiPanel.img2imgPrompt,
          'onUpdate:modelValue': (v) => (aiPanel.img2imgPrompt = v),
          placeholder: '改图描述，如：把背景换成星空、转成水彩风格',
          size: 'small',
          style: 'flex:1;min-width:220px',
          clearable: true
        }),
        h(ElButton, { size: 'small', type: 'primary', loading: busy.img2img, disabled: !hasImage.value || !imageReady.value, onClick: runImg2img }, () => 'AI 图生图')
      ]),
      h('div', { class: 'st-ai-row' }, [
        h('span', { class: 'st-ai-label' }, '识图提问'),
        h(ElInput, {
          modelValue: aiPanel.recognizePrompt,
          'onUpdate:modelValue': (v) => (aiPanel.recognizePrompt = v),
          placeholder: '留空使用默认提问（描述截图内容）',
          size: 'small',
          style: 'flex:1;min-width:220px',
          clearable: true
        }),
        !providers.value.length
          ? h(ElTag, { type: 'warning', effect: 'plain' }, () => '尚未配置 AI 供应商，请在主应用「AI 工作台」添加')
          : null
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

  function renderSourceDialog() {
    return h(ElDialog, {
      modelValue: sourceDialog.visible,
      'onUpdate:modelValue': (v) => (sourceDialog.visible = v),
      title: sourceDialog.type === 'screen' ? (sourceDialog.forLongshot ? '选择长图来源屏幕' : '选择要截取的屏幕') : sourceDialog.forLongshot ? '选择长图来源窗口' : '选择要截取的窗口',
      width: '720px'
    }, {
      default: () =>
        sourceDialog.loading
          ? h('div', { class: 'st-dialog-loading' }, '正在枚举窗口…')
          : h(
              'div',
              { class: 'st-source-grid' },
              sourceDialog.sources.map((s) =>
                h(
                  'div',
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
    if (!historyList.value.length) {
      return h(ElEmpty, { description: '暂无截图历史（每次截图自动保存在这里）' })
    }
    return h('div', { class: 'st-history' }, [
      h('div', { class: 'st-history-bar' }, [
        h('span', { class: 'st-hint' }, `共 ${historyList.value.length} 条（保留最近 ${settings.historyLimit} 条）`),
        h('div', { class: 'st-flex-grow' }),
        h(ElButton, { size: 'small', onClick: refreshHistory }, () => '刷新'),
        h(ElButton, { size: 'small', type: 'danger', plain: true, onClick: clearHistoryAll }, () => '清空')
      ]),
      h(
        'div',
        { class: 'st-history-grid' },
        historyList.value.map((item) =>
          h('div', { class: 'st-history-card', key: item.id }, [
            h('div', { class: 'st-history-thumb', onClick: () => openHistoryItem(item) }, [
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
              h(ElTooltip, { content: '载入编辑器', showAfter: 400 }, { default: () => h(ElButton, { size: 'small', text: true, onClick: () => openHistoryItem(item) }, () => '✏') }),
              h(ElTooltip, { content: '复制原图', showAfter: 400 }, { default: () => h(ElButton, { size: 'small', text: true, onClick: () => copyHistoryItem(item) }, () => '⧉') }),
              h(ElTooltip, { content: '另存为', showAfter: 400 }, { default: () => h(ElButton, { size: 'small', text: true, onClick: () => saveHistoryItem(item) }, () => '💾') }),
              h(ElTooltip, { content: '钉到屏幕', showAfter: 400 }, { default: () => h(ElButton, { size: 'small', text: true, onClick: () => pinHistoryItem(item) }, () => '📌') }),
              h(ElTooltip, { content: '删除', showAfter: 400 }, { default: () => h(ElButton, { size: 'small', text: true, type: 'danger', onClick: () => removeHistoryItem(item) }, () => '✕') })
            ])
          ])
        )
      )
    ])
  }

  // ---- 设置 tab ----

  function renderSettings() {
    const formItem = (label, control, hint) =>
      h(ElFormItem, { label }, { default: () => [control, hint ? h('div', { class: 'st-hint' }, hint) : null] })

    return h(ElForm, { labelWidth: '120px', class: 'st-settings' }, () => [
      formItem(
        '保存目录',
        h('div', { class: 'st-dir-row' }, [
          h(ElInput, { modelValue: settings.saveDir, readonly: true, placeholder: '未设置（保存时弹另存对话框）', style: 'flex:1' }),
          h(ElButton, { onClick: chooseSaveDir }, () => '选择目录'),
          settings.saveDir
            ? h(ElButton, { onClick: () => (settings.saveDir = '') }, () => '清除')
            : null
        ]),
        '设置后「保存」按钮直接写入该目录，不再弹对话框'
      ),
      formItem(
        '历史条数',
        h(ElInputNumber, {
          modelValue: settings.historyLimit,
          'onUpdate:modelValue': (v) => (settings.historyLimit = v),
          min: 10,
          max: 200,
          step: 10
        }),
        '超出后自动删除最旧的截图文件'
      ),
      formItem(
        '长图抓帧间隔',
        h(ElInputNumber, {
          modelValue: settings.intervalMs,
          'onUpdate:modelValue': (v) => (settings.intervalMs = v),
          min: 300,
          max: 2000,
          step: 100
        }),
        '自动模式下的抓帧频率（毫秒）；内容滚动慢可调大'
      ),
      formItem(
        'AI 供应商',
        h(
          ElSelect,
          {
            modelValue: settings.providerId,
            'onUpdate:modelValue': (v) => {
              settings.providerId = v
              const opts = modelOptions.value.map((m) => m.id)
              for (const key of ['visionModel', 'chatModel', 'imageModel']) {
                if (!opts.includes(settings[key])) settings[key] = ''
              }
            },
            placeholder: '选择供应商',
            style: 'width:280px'
          },
          () => providers.value.map((p) => h(ElOption, { key: p.id, value: p.id, label: p.name }))
        ),
        '供应商在主应用「AI 工作台 → 供应商」中配置，此处直接复用（密钥不出主进程）'
      ),
      formItem(
        '翻译目标语言',
        h(
          ElSelect,
          {
            modelValue: settings.targetLang,
            'onUpdate:modelValue': (v) => (settings.targetLang = v),
            style: 'width:200px'
          },
          () => TARGET_LANGS.map((l) => h(ElOption, { key: l, value: l, label: l }))
        )
      )
    ])
  }

  // ---- 主渲染 ----

  return defineComponent({
    name: 'ScreenshotWorkspace',
    setup() {
      // 生命周期必须在 setup() 内注册（工厂函数体里没有组件实例，注册会静默失效）
      let unsubRegion = null
      onMounted(async () => {
        Object.assign(settings, await loadSettings(ctx))
        await loadProviders()
        await refreshHistory()
        unsubRegion = capture.onRegionResult(async ({ dataUrl }) => {
          try {
            const canvas = await loadImageToCanvas(dataUrl)
            await captureAndLoad('region', canvas)
          } catch (err) {
            message.error(`区域截图载入失败：${err.message}`)
          }
        })
      })
      onBeforeUnmount(() => {
        unsubRegion?.()
        setAuto(false)
        longshot.session?.close()
      })
      return () =>
        h('div', { class: 'st-workspace' }, [
          renderCaptureBar(),
          renderLongshotPanel(),
          h('div', { class: 'st-editor-host' }, [h(editor.component)]),
          renderActions(),
          renderAiPanel(),
          renderResults(),
          h(
            ElTabs,
            { modelValue: tab.value, 'onUpdate:modelValue': (v) => (tab.value = v) },
            () => [
              h(ElTabPane, { label: `历史（${historyList.value.length}）`, name: 'history' }, () => renderHistory()),
              h(ElTabPane, { label: '设置', name: 'settings' }, () => renderSettings())
            ]
          ),
          renderSourceDialog()
        ])
    }
  })
}


