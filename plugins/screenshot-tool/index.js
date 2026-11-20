// 截图插件入口：注册工具箱工具「截图」。
// 依赖主应用的桌面截屏/贴图/插件文件能力（window.api.capture / pin / plugins.files），
// 旧版应用加载本插件时显示升级提示，不阻塞应用其它功能。

import { createWorkspace } from './views/workspace.js'

function detectCaps() {
  const api = typeof window !== 'undefined' ? window.api : null
  return {
    capture: !!(api?.capture?.sources && api?.capture?.startRegion),
    pin: !!(api?.pin?.show && api?.pin?.get),
    files: !!(api?.plugins?.files?.write),
    ai: !!(api?.ai?.chat && api?.ai?.generateImage)
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
  if (!caps.capture) missing.push('桌面截屏 window.api.capture（区域/全屏/窗口截图与长图）')
  if (!caps.pin) missing.push('截图贴图 window.api.pin（钉在屏幕置顶显示）')
  if (!caps.files) missing.push('插件文件存储 window.api.plugins.files（截图历史）')

  injectStyles(ctx)

  ctx.registerTool({
    id: 'screenshot',
    name: '截图',
    category: '图像',
    description: '区域/全屏/窗口/长图截图 · 标注（画笔/马赛克/文字/箭头/图形/高亮/步骤） · 带壳 · 贴图置顶 · OCR · 翻译 · AI 识图与图生图',
    component:
      missing.length === 0
        ? createWorkspace(bundle)
        : createUpgradeComponent(bundle, missing)
  })

  if (caps.ai) {
    // 图生图等 AI 能力按需可用即可，不单独阻断工具加载
    ctx.log('AI 能力可用（chat/generateImage）')
  }
  ctx.log('「截图」工具已注册', { caps })
}
