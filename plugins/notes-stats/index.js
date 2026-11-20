// notes-stats 示例插件：演示 AtoZ 插件系统的四个核心能力——
//   1. registerPage  注册新页面（侧边栏自动出现入口）
//   2. registerWidget 注册仪表盘小组件
//   3. ctx.http       读业务数据（需 permissions 声明 notes:read）
//   4. ctx.storage    插件命名空间 KV（重启后仍在）
// UI 组件从 ctx.ui 取（已随主应用打包），Vue API 从 ctx.vue 取。
export function activate(ctx) {
  const { h, ref, onMounted, defineComponent } = ctx.vue
  const { ElCard, ElTable, ElTableColumn, ElStatistic, ElEmpty } = ctx.ui

  const notes = ref([])
  const loaded = ref(false)
  const openCount = ref(0)

  async function load() {
    notes.value = await ctx.http.get('/api/notes')
    loaded.value = true
  }

  // ---- 仪表盘小组件：笔记总数 ----
  ctx.registerWidget({
    id: 'total',
    title: '笔记总数',
    component: defineComponent({
      setup() {
        onMounted(load)
        return () =>
          h(
            'div',
            { style: 'font-size:36px;font-weight:700;color:#409eff;line-height:1.4' },
            loaded.value ? String(notes.value.length) : '…'
          )
      }
    })
  })

  // ---- 页面：笔记统计 ----
  ctx.registerPage({
    path: '/stats',
    title: '笔记统计',
    component: defineComponent({
      setup() {
        onMounted(async () => {
          await load()
          openCount.value = (await ctx.storage.get('openCount')) || 0
          openCount.value += 1
          await ctx.storage.set('openCount', openCount.value)
        })
        return () =>
          h(ElCard, { shadow: 'never' }, {
            header: () => h('span', { style: 'font-weight:600' }, '笔记统计'),
            default: () => [
              h('div', { style: 'display:flex;gap:48px;margin-bottom:16px' }, [
                h(ElStatistic, { title: '笔记总数', value: notes.value.length }),
                h(ElStatistic, { title: '本页打开次数（KV 持久化）', value: openCount.value })
              ]),
              h('div', { style: 'font-weight:600;margin-bottom:8px' }, '最新 5 条'),
              h(ElTable, { data: notes.value.slice(0, 5), stripe: true, size: 'small' }, {
                default: () => [
                  h(ElTableColumn, { prop: 'id', label: 'ID', width: 70 }),
                  h(ElTableColumn, { prop: 'title', label: '标题', 'show-overflow-tooltip': true }),
                  h(ElTableColumn, { prop: 'updated_at', label: '更新时间' })
                ]
              }),
              loaded.value && notes.value.length === 0 ? h(ElEmpty, { description: '暂无笔记' }) : null
            ]
          })
      }
    })
  })

  ctx.log('activated, permissions =', ctx.meta.permissions)
}
