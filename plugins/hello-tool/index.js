// 工具箱插件示例：ctx.registerTool 把任意组件注册进「工具箱」，与内置工具同一契约。
// 工具组件与页面组件一样从 ctx.vue / ctx.ui 取 API（勿裸 import 'vue' / 'element-plus'）。
export function activate(ctx) {
  const { h, ref, onMounted, defineComponent } = ctx.vue
  const { ElButton, ElTag } = ctx.ui

  ctx.registerTool({
    id: 'hello',
    name: 'Hello 示例',
    category: '示例',
    description: '插件注册工具的最小示例（含 KV 持久化）',
    component: defineComponent({
      setup() {
        const count = ref(0)
        const saved = ref(0)

        // KV 演示：读取上次留下的数字
        onMounted(async () => {
          const v = await ctx.storage.get('count')
          if (typeof v === 'number') {
            saved.value = v
            count.value = v
          }
        })

        async function bump() {
          count.value += 1
          saved.value = count.value
          await ctx.storage.set('count', count.value)
          ctx.log('计数已持久化:', count.value)
        }

        return () =>
          h('div', { style: 'display:flex;flex-direction:column;gap:14px;align-items:flex-start;' }, [
            h('p', { style: 'margin:0;' }, '这是一个由插件注册的工具，证明插件工具与内置工具走同一契约、同处工具箱侧栏。'),
            h('div', null, [
              h(ElTag, { effect: 'plain' }, () => `计数（KV 持久化）：${saved.value}`)
            ]),
            h(ElButton, { type: 'primary', onClick: bump }, () => '点我 +1')
          ])
      }
    })
  })

  ctx.log('hello-tool 已注册工具箱工具')
}
