// 截图插件入口：注册工具箱工具「截图」。
// 依赖主应用的桌面截屏/贴图/插件文件能力（window.api.capture / pin / plugins.files），
// 旧版应用加载本插件时显示升级提示，不阻塞应用其它功能。
// 全局快捷键为可选能力（旧版主应用无 window.api.shortcuts，缺省跳过）。

import { createWorkspace } from './views/workspace.js'
import { loadImageToCanvas } from './lib/capture.js'
import { addHistory } from './lib/history.js'
import { loadSettings } from './lib/store.js'

function detectCaps() {
  const api = typeof window !== 'undefined' ? window.api : null
  return {
    capture: !!(api?.capture?.sources && api?.capture?.startRegion),
    pin: !!(api?.pin?.show && api?.pin?.get),
    files: !!(api?.plugins?.files?.write),
    ai: !!(api?.ai?.chat),
    hotkey: !!(api?.shortcuts?.register)
  }
}

function injectStyles(ctx) {
  if (document.getElementById('st-screenshot-tool-css')) return
  const link = document.createElement('link')
  link.id = 'st-screenshot-tool-css'
  link.rel = 'stylesheet'
  link.href = `plugin://${ctx.meta.id}/styles.css`
  document.head.appendChild(link)
}

/** 按持久化配置注册全局快捷键（activate 即生效，无需打开工具页） */
async function registerHotkeyFromSettings(ctx) {
  if (!window.api.shortcuts?.register) return
  try {
    const s = await loadSettings(ctx)
    if (s.hotkey?.enabled && s.hotkey?.accelerator) {
      const r = await window.api.shortcuts.register({
        pluginId: ctx.meta.id,
        action: 'capture-region',
        accelerator: s.hotkey.accelerator
      })
      if (!r.ok) ctx.log('全局快捷键注册失败：', r.error)
    }
  } catch (err) {
    ctx.log('全局快捷键注册异常：', err)
  }
}

/** 旧版应用降级页：告知需要升级主应用 */
function createUpgradeComponent(bundle, missing) {
  const { vue, ui } = bundle
  const { h, defineComponent } = vue
  const { ElAlert, ElButton } = ui
  return defineComponent({
    name: 'ScreenshotUpgrade',
    setup() {
      return () =>
        h('div', { style: 'padding:24px;max-width:640px' }, [
          h(ElAlert, { type: 'warning', title: '截图插件需要更新主应用', showIcon: true, closable: false }, {
            default: () =>
              h('div', { style: 'line-height:1.8' }, [
                h('div', {}, '当前 AtoZ 主应用缺少截图插件所需的桌面能力接口：'),
                h('ul', { style: 'margin:8px 0 8px 18px;padding:0' }, missing.map((m) => h('li', { key: m }, m))),
                h('div', {}, '请把主应用升级到包含「桌面截屏 / 截图贴图 / 插件文件存储」支持的版本，然后在 设置 → 插件 中点击「重载全部」。')
              ])
          }),
          h('div', { style: 'margin-top:16px' }, [
            h(ElButton, { onClick: () => window.api?.plugins?.openDir?.() }, () => '打开插件目录')
          ])
        ])
    }
  })
}

export function activate(ctx) {
  const caps = detectCaps()
  const bundle = { vue: ctx.vue, ui: ctx.ui, ctx }
  const missing = []
  if (!caps.capture) missing.push('桌面截屏 window.api.capture（区域截图就地编辑 / 全屏 / 窗口 / 选区长截图）')
  if (!caps.pin) missing.push('截图贴图 window.api.pin（钉在屏幕置顶显示）')
  if (!caps.files) missing.push('插件文件存储 window.api.plugins.files（截图历史）')

  injectStyles(ctx)

  const workspace = missing.length ? null : createWorkspace(bundle)
  ctx.registerTool({
    id: 'screenshot',
    name: '截图',
    category: '图像',
    description:
      '截取区域、窗口或整屏，标注后复制、保存或贴到屏幕。',
    component:
      workspace?.component ?? createUpgradeComponent(bundle, missing)
  })

  // 快捷键也能从其他工具或隐藏主窗口发起；结果归档不能依赖工作台挂载。
  if (!missing.length) {
    const unsubscribe = window.api.capture.onRegionResult(async ({ dataUrl, kind, ocrText, pluginId, edit, appearance }) => {
      if (pluginId && pluginId !== ctx.meta.id) return
      try {
        const [settings, canvas] = await Promise.all([loadSettings(ctx), loadImageToCanvas(dataUrl)])
        let meta
        try { meta = await addHistory(ctx, { canvas, source: kind === 'longshot' ? 'long' : 'region',
          limit: settings.historyLimit, note: ocrText || '' })
        } finally {
          if (edit && kind === 'longshot') workspace.openLongshot(canvas,meta?.id,appearance)
        }
        ctx.events.emit('screenshot-tool:archived', meta)
      } catch (err) { ctx.ui.message.error(`截图未能写入历史：${err.message}`) }
    })
    ctx.onDispose?.(unsubscribe)
  }

  // 全局快捷键按设置自动注册（可选项，注册失败不影响插件）
  if (caps.hotkey) void registerHotkeyFromSettings(ctx)

  ctx.log('「截图」工具已注册', { caps })
}
