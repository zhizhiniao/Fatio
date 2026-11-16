(() => {
  const api = window.studio
  const byId = id => document.getElementById(id)
  const dialog = byId('updates-dialog')
  let info = null
  let busy = false
  function render(state) {
    info = state
    byId('update-current').textContent = 'v' + state.currentVersion
    byId('update-check').classList.toggle('has-update', state.notify)
    byId('update-check-label').textContent = state.notify ? '发现新版' : '检查更新'
    byId('update-check').title = state.notify ? '发现新版 ' + state.latest.version + '，点击查看' : '当前版本 ' + state.currentVersion + '，点击检查更新'
    const labels = { unchecked: '尚未检查', checking: '正在检查更新…', available: '发现新版本',
      current: '当前没有更新版本', empty: '暂未找到可下载的安装版本', error: state.message }
    byId('updates-status').textContent = labels[state.status] || ''
    byId('updates-versions').textContent = '本机 ' + state.currentVersion + (state.latest ? ' · 已公开 ' + state.latest.version : '')
    byId('updates-channel').textContent = state.latest?.prerelease ? '此版本为开发者预览版。请查看说明后决定是否安装。' : ''
    byId('updates-notes').textContent = state.latest?.notes || ''
    byId('updates-auto').checked = state.auto
    byId('updates-last').textContent = state.lastChecked ? '上次检查：' + new Date(state.lastChecked).toLocaleString('zh-CN') : ''
    byId('updates-download').hidden = !state.available
    byId('updates-release').hidden = !state.available
    byId('updates-skip').hidden = !state.available
    byId('updates-download').disabled = busy
  }
  async function check() {
    if (busy) return
    busy = true
    byId('updates-recheck').disabled = true
    byId('updates-download').disabled = true
    try { render(await api['update-check']()) }
    catch (error) { byId('updates-status').textContent = error.message }
    finally { busy = false; byId('updates-recheck').disabled = false; byId('updates-download').disabled = false }
  }
  byId('update-check').onclick = async () => {
    try {
      render(await api['update-info']())
      if (!dialog.open) dialog.showModal()
      if (!info.available) await check()
    } catch (error) { byId('updates-status').textContent = error.message }
  }
  byId('updates-close').onclick = () => dialog.close()
  byId('updates-recheck').onclick = check
  byId('updates-auto').onchange = async () => {
    try { render(await api['update-auto'](byId('updates-auto').checked)) }
    catch (error) { byId('updates-status').textContent = error.message }
  }
  byId('updates-skip').onclick = async () => {
    try { render(await api['update-skip']()); dialog.close() }
    catch (error) { byId('updates-status').textContent = error.message }
  }
  for (const [id, kind] of [['updates-download', 'download'], ['updates-release', 'release']]) {
    byId(id).onclick = async () => {
      try {
        await api['update-open'](kind)
        if (kind === 'download') byId('updates-status').textContent = '已打开安装包下载。下载完成后退出发条，运行安装包完成升级。'
      } catch (error) { byId('updates-status').textContent = error.message }
    }
  }
  api.onUpdate(render)
  api['update-info']().then(render).catch(() => {})
})()
