import { SHELLS } from '../lib/shell.js'
const AI_PROTOCOLS = [
  { id: 'chat', name: 'OpenAI Chat' },
  { id: 'responses', name: 'OpenAI Responses' },
  { id: 'messages', name: 'Anthropic Messages' }
]

const SCROLL_KEYS = [
  { id: 'down', name: '↓ 方向键' },
  { id: 'pagedown', name: 'PageDown' },
  { id: 'space', name: '空格' }
]

const TARGET_LANGS = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский']

export function settingsView({ h, ui, settings, modelOptions, chooseSaveDir, busy, testDirectAi, directTestStatus, switchProvider, providers, isAppMode, hotkeyRecording, applyHotkey, onHotkeyKeydown, hotkeyStatus }) {
  const {ElFormItem, ElSelect, ElOption, ElForm, ElInput, ElButton, ElInputNumber, ElDivider, ElRadioGroup, ElRadio, ElTag, ElSwitch} = ui
  return function renderSettings() {
    const formItem = (label, control, hint) =>
      h(ElFormItem, { label }, { default: () => [control, hint ? h('div', { class: 'st-hint' }, hint) : null] })

    const modelSelect = (modelKey, placeholder) =>
      h(
        ElSelect,
        {
          modelValue: settings[modelKey],
          'onUpdate:modelValue': (v) => (settings[modelKey] = v),
          placeholder,
          style: 'width:280px',
          clearable: true,
          filterable: true
        },
        () => modelOptions.value.map((m) => h(ElOption, { key: m.id, value: m.id, label: m.name || m.id }))
      )

    const d = settings.direct

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
        '设置后截图「保存」直接写入该目录，不再弹对话框'
      ),
      formItem('默认截图外观',h('div',{class:'st-output-fields'},[
        h('label',{},[h('input',{type:'checkbox',checked:settings.appearance.rounded,onChange:e=>settings.appearance.rounded=e.target.checked}),' 截图圆角']),
        h('label',{},['半径（px） ',h('input',{type:'number',min:0,max:256,disabled:!settings.appearance.rounded,value:settings.appearance.radius,onChange:e=>{settings.appearance.radius=Math.min(256,Math.max(0,e.target.valueAsNumber||0));e.target.value=settings.appearance.radius}})]),
        h('label',{},['外壳 ',h('select',{value:settings.appearance.shell,onChange:e=>settings.appearance.shell=e.target.value},SHELLS.map(s=>h('option',{value:s.id},s.name)))])
      ]),'用于新截图；不改变历史图片。编辑时可单独调整。'),
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

      h(ElDivider, { contentPosition: 'left' }, () => 'AI 配置（识图 / OCR / 翻译）'),
      formItem(
        '配置模式',
        h(
          ElRadioGroup,
          { modelValue: settings.aiMode, 'onUpdate:modelValue': (v) => (settings.aiMode = v) },
          () => [
            h(ElRadio, { value: 'direct' }, () => '独立配置（本插件自带）'),
            h(ElRadio, { value: 'app' }, () => '复用主程序 AI 工作台')
          ]
        ),
        '独立配置的 Key 存本插件数据文件（本机明文）；复用模式密钥在主程序 AI 工作台管理'
      ),
      ...(settings.aiMode === 'direct'
        ? [
            formItem(
              '协议',
              h(
                ElSelect,
                { modelValue: d.protocol, 'onUpdate:modelValue': (v) => (d.protocol = v), style: 'width:280px' },
                () => AI_PROTOCOLS.map((p) => h(ElOption, { key: p.id, value: p.id, label: p.name }))
              )
            ),
            formItem(
              '接口地址',
              h(ElInput, {
                modelValue: d.baseUrl,
                'onUpdate:modelValue': (v) => (d.baseUrl = v),
                placeholder: 'https://api.openai.com（根地址，自动补 /v1）',
                style: 'width:280px'
              })
            ),
            formItem(
              'API Key',
              h(ElInput, {
                modelValue: d.apiKey,
                'onUpdate:modelValue': (v) => (d.apiKey = v),
                type: 'password',
                showPassword: true,
                placeholder: 'sk-…',
                style: 'width:280px'
              })
            ),
            formItem(
              '识图模型',
              h(ElInput, {
                modelValue: d.visionModel,
                'onUpdate:modelValue': (v) => (d.visionModel = v),
                placeholder: '如 glm-4v / gpt-4o / qwen-vl',
                style: 'width:280px'
              }),
              '用于 OCR 与 AI 识图（多模态）'
            ),
            formItem(
              '翻译模型',
              h(ElInput, {
                modelValue: d.chatModel,
                'onUpdate:modelValue': (v) => (d.chatModel = v),
                placeholder: '如 glm-4 / gpt-4o-mini',
                style: 'width:280px'
              }),
              '用于 OCR 结果翻译'
            ),
            formItem(
              '测试连接',
              h('div', { class: 'st-dir-row' }, [
                h(ElButton, { loading: busy.directTest, onClick: testDirectAi }, () => '测试连接'),
                directTestStatus.value
                  ? h(ElTag, { type: directTestStatus.value.ok ? 'success' : 'danger', effect: 'plain', size: 'small' }, () => directTestStatus.value.text)
                  : null
              ])
            )
          ]
        : [
            formItem(
              'AI 供应商',
              h(
                ElSelect,
                {
                  modelValue: settings.providerId,
                  'onUpdate:modelValue': switchProvider,
                  placeholder: '选择供应商',
                  style: 'width:280px'
                },
                () => providers.value.map((p) => h(ElOption, { key: p.id, value: p.id, label: p.name }))
              ),
              '在主应用「AI 工作台 → 供应商」中配置（密钥不出主进程）'
            ),
            formItem('识图模型', modelSelect('visionModel', '选择视觉模型')),
            formItem('翻译模型', modelSelect('chatModel', '选择文本模型')),
            formItem('图生图模型', modelSelect('imageModel', '选择生图模型'), '仅复用主程序模式支持图生图')
          ]),
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
      ),
      formItem(
        '本地 OCR 语言',
        h(ElInput, {
          modelValue: settings.tesseractLangs,
          'onUpdate:modelValue': (v) => (settings.tesseractLangs = v),
          style: 'width:200px'
        }),
        '未配置 AI 时的本地识别兜底语言包（tesseract）'
      ),

      h(ElDivider, { contentPosition: 'left' }, () => '快捷键与长截图'),
      formItem(
        '全局快捷键',
        h('div', { class: 'st-dir-row', style: 'align-items:center;gap:8px' }, [
          h(ElSwitch, {
            modelValue: settings.hotkey.enabled,
            'onUpdate:modelValue': (v) => {
              settings.hotkey.enabled = v
              void applyHotkey()
            }
          }),
          h(ElInput, {
            modelValue: hotkeyRecording.value ? '请按下组合键（Esc 取消）…' : settings.hotkey.accelerator,
            readonly: true,
            style: 'width:240px',
            placeholder: '点击输入框后按下组合键',
            onKeydown: onHotkeyKeydown,
            onFocus: () => (hotkeyRecording.value = true),
            onBlur: () => (hotkeyRecording.value = false)
          }),
          h(ElButton, { onClick: () => void applyHotkey() }, () => '应用'),
          hotkeyStatus.value
            ? h(ElTag, { type: hotkeyStatus.value.ok ? 'success' : 'danger', effect: 'plain', size: 'small' }, () => hotkeyStatus.value.text)
            : null
        ]),
        '系统级热键，任意应用内一键呼出区域截图（就地标注）；不能占用应用保留键 Cmd+Shift+S/H/Q'
      ),
      formItem(
        '自动翻页键',
        h(
          ElSelect,
          {
            modelValue: settings.longshot.scrollKey,
            'onUpdate:modelValue': (v) => (settings.longshot.scrollKey = v),
            style: 'width:160px'
          },
          () => SCROLL_KEYS.map((k) => h(ElOption, { key: k.id, value: k.id, label: k.name }))
        ),
        '长截图自动模式向目标应用发送的翻页键（需辅助功能权限）'
      ),
      formItem(
        '长图抓帧间隔',
        h(ElInputNumber, {
          modelValue: settings.longshot.intervalMs,
          'onUpdate:modelValue': (v) => (settings.longshot.intervalMs = v),
          min: 300,
          max: 2000,
          step: 100
        }),
        '自动模式每帧翻页后的等待毫秒数；内容滚动慢可调大'
      )
    ])
  }

}
