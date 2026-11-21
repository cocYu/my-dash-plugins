// Exactly one timer or in-flight operation. Switching modes invalidates old
// callbacks; an OS request already dispatched must settle before the next one.
export function createScrollSession({ capture, sendKey, interval, onMode, onResult, onError }) {
  let generation = 0, timer, pending = Promise.resolve(), mode = 'paused'
  const schedule = (id, delay) => {
    timer = setTimeout(() => {
      pending = pending.then(async () => {
        if (generation !== id) return
        if (mode === 'auto') {
          const result = await sendKey()
          if (generation !== id) return
          if (!result.ok) { switchTo('manual', `${result.message || '自动滚动不可用'}；已切换鼠标滚动`); return }
          await new Promise(resolve => setTimeout(resolve, interval))
        }
        if (generation !== id) return
        const result = await capture()
        if (generation !== id) return
        onResult(result)
        if (result.truncated) return switchTo('paused', '已达到尺寸上限，请完成截图')
        if (mode === 'auto' && result.unmatched) return switchTo('manual', '未找到重叠；请向上滚回上一段，再缓慢向下滚动')
        if (mode === 'auto' && result.noNew && ++unchanged >= 3) return switchTo('paused', '画面连续未变，已暂停自动滚动')
        if (!result.noNew) unchanged = 0
        schedule(id, mode === 'auto' ? 0 : 320)
      }).catch(err => { if (generation === id) { switchTo('paused'); onError(err) } })
    }, delay)
  }
  let unchanged = 0
  function switchTo(next, message) {
    clearTimeout(timer); generation++; mode = next; unchanged = 0
    onMode(mode, message)
    if (mode !== 'paused') schedule(generation, mode === 'auto' ? 0 : 320)
  }
  return { switchTo, get mode() { return mode }, async stop() { switchTo('paused'); await pending } }
}
