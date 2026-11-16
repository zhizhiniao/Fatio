'use strict'
const sessionOf = (a) => data.sessions?.find((s) => s.accountId === a.id)
const nickname = (a) => sessionOf(a)?.name || a.name
function visibleHandle(a) {
  const s = sessionOf(a),
    handle = s?.handle || a.identity
  return a.platform === 'channels' && s?.uid === handle && handle.length > 32 ? '' : handle
}
function portrait(a) {
  const image = sessionOf(a)?.avatar
  return (
    '<span class="portrait">' +
    (image
      ? '<img class="face" alt="" src="' + escape(image) + '">' + badge(a.platform)
      : '<span class="face fallback">' + badge(a.platform) + '</span>') +
    '</span>'
  )
}
const metricNames = {
  views: '播放 / 阅读',
  likes: '点赞',
  comments: '评论',
  shares: '分享',
  collects: '收藏'
}
const total = (rows, key) => {
  const values = rows.map((r) => r[key]).filter(Number.isFinite)
  return values.length ? values.reduce((a, b) => a + b, 0) : null
}
function sectionHead(label, action = '') {
  return '<div class="section-row"><h2>' + escape(label) + '</h2>' + action + '</div>'
}
function renderHome() {
  renderPersonalHome()
}
function pendingSection(ids) {
  const tasks = data.jobs.filter(
    (j) => ids.has(j.accountId) && (groups.pending.includes(j.status) || groups.attention.includes(j.status))
  )
  if (!tasks.length) return ''
  return (
    '<section class="panel report-panel">' +
    sectionHead('待处理发布', '<small>' + tasks.length + ' 项</small>') +
    tasks
      .slice(0, 4)
      .map(
        (j) =>
          '<button class="group-summary" data-action="detail" data-id="' +
          escape(j.id) +
          '">' +
          badge(accountById(j.accountId)?.platform) +
          '<b>' +
          escape(j.title || j.body || '未命名稿件') +
          '</b><span>' +
          escape(states[j.status]) +
          '</span></button>'
      )
      .join('') +
    '</section>'
  )
}
function recentWorks(rows) {
  return [...rows].sort((a, b) => (b.posted || 0) - (a.posted || 0) || b.seen - a.seen)
}
function nativeRows(rows) {
  if (!rows.length) return '<p class="empty">暂无已同步作品</p>'
  return (
    '<div class="works-list">' +
    recentWorks(rows)
      .map(
        (w) =>
          '<button class="work-line" data-action="native-detail" data-id="' +
          escape(w.id) +
          '">' +
          '<span class="cover">' +
          (w.cover ? '<img alt="" src="' + escape(w.cover) + '">' : badge(w.platform)) +
          '</span>' +
          '<span class="work-name"><b>' +
          escape(w.title || w.itemId) +
          '</b><small>' +
          escape(
            [
              w.platformLabel,
              w.account,
              w.posted ? new Date(w.posted * 1000).toLocaleDateString('zh-CN') : null,
              w.status
            ]
              .filter(Boolean)
              .join(' · ')
          ) +
          '</small></span>' +
          '<span class="work-stat"><small>播放 / 阅读</small><b>' +
          formatNumber(w.views) +
          '</b></span>' +
          '<span class="work-stat"><small>点赞</small><b>' +
          formatNumber(w.likes) +
          '</b></span>' +
          icon('chevron-right') +
          '</button>'
      )
      .join('') +
    '</div>'
  )
}
let chartMetric = 'views'
function historyChart(history) {
  // A carried-forward field retains its original time. Do not plot it as a fresh measurement.
  const readings = new Map()
  for (const s of history.slice().reverse())
    if (Number.isFinite(s[chartMetric]))
      readings.set(s._times?.[chartMetric] || s.time, s[chartMetric])
  const series = [...readings].sort((a, b) => a[0] - b[0])
  const choices = Object.entries(metricNames)
    .map(
      ([key, name]) =>
        '<option value="' +
        key +
        '"' +
        (key === chartMetric ? ' selected' : '') +
        '>' +
        name +
        '</option>'
    )
    .join('')
  const heading =
    '<figcaption><label>指标采样 <select aria-label="采样指标" id="chart-metric">' +
    choices +
    '</select></label><small>' +
    (series.length > 1
      ? '较上次 ' + signedCount(series.at(-1)[1] - series.at(-2)[1]) + ' · '
      : '') +
    series.length + ' 个采样点</small></figcaption>'
  if (!series.length)
    return '<figure class="trend">' + heading + '<p class="empty">暂无该指标采样</p></figure>'
  const start = series[0][0],
    end = series.at(-1)[0],
    max = Math.max(1, ...series.map((p) => p[1]))
  const points = series.map(([t, v]) => [
    end === start ? 252 : 12 + (480 * (t - start)) / (end - start),
    78 - (64 * v) / max
  ])
  return (
    '<figure class="trend">' +
    heading +
    '<svg viewBox="0 0 504 90" role="img" aria-label="' +
    metricNames[chartMetric] +
    '采样曲线，最新 ' +
    series.at(-1)[1] +
    '">' +
    '<path d="M12 14H492 M12 46H492 M12 78H492" class="gridline"/><polyline points="' +
    points.map((p) => p.join(',')).join(' ') +
    '" class="trendline"/>' +
    points
      .map(
        ([x, y], i) =>
          '<circle cx="' +
          x +
          '" cy="' +
          y +
          '" r="3"><title>' +
          escape(fmtDate(series[i][0]) + ' · ' + formatNumber(series[i][1])) +
          '</title></circle>'
      )
      .join('') +
    '</svg><small>' +
    escape(fmtDate(start)) +
    ' — ' +
    escape(fmtDate(end)) +
    '</small></figure>'
  )
}
let workFilterPlatform = '',
  workFilterAccount = '',
  workTerm = ''
function filteredWorks() {
  return (analyticsData?.native || []).filter(
    (w) =>
      (!workFilterPlatform || w.platform === workFilterPlatform) &&
      (!workFilterAccount || w.accountId === workFilterAccount) &&
      (!libraryPeriod || w.posted >= Date.now() / 1000 - libraryPeriod * 86400) &&
      (!workTerm || [w.title, w.itemId, w.account].join(' ').toLowerCase().includes(workTerm.toLowerCase()))
  )
}
function selectOptions(entries, value, all) {
  return (
    '<option value="">' +
    escape(all) +
    '</option>' +
    entries
      .map(
        ([k, v]) =>
          '<option value="' +
          escape(k) +
          '"' +
          (k === value ? ' selected' : '') +
          '>' +
          escape(v) +
          '</option>'
      )
      .join('')
  )
}
function nativeFilters() {
  const rows = [...analyticsData.native, ...activeAccounts().map(a => ({
    accountId: a.id, account: nickname(a), platform: a.platform, platformLabel: platforms[a.platform]
  }))]
  return (
    '<div class="account-filters work-filters"><select id="work-platform" aria-label="作品平台">' +
    selectOptions(
      [...new Map(rows.map((w) => [w.platform, w.platformLabel]))],
      workFilterPlatform,
      '全部平台'
    ) +
    '</select><select id="work-account" aria-label="作品账号">' +
    selectOptions(
      [
        ...new Map(
          rows
            .filter((w) => !workFilterPlatform || w.platform === workFilterPlatform)
            .map((w) => [w.accountId, w.account])
        )
      ],
      workFilterAccount,
      '全部账号'
    ) +
    '</select><input id="work-term" aria-label="搜索作品" placeholder="搜索作品" value="' +
    escape(workTerm) +
    '"></div>'
  )
}
function bindWorkFilters() {
  if (!$('work-platform')) return
  $('work-platform').onchange = (e) => {
    workFilterPlatform = e.target.value
    libraryPage = 0
    workFilterAccount = ''
    renderAnalytics()
  }
  $('work-account').onchange = (e) => {
    workFilterAccount = e.target.value
    libraryPage = 0
    renderAnalytics()
  }
  $('work-term').oninput = (e) => {
    workTerm = e.target.value
    libraryPage = 0
    const pos = e.target.selectionStart
    renderAnalytics()
    $('work-term').focus()
    $('work-term').setSelectionRange(pos, pos)
  }
}
let selectedAccount = '',
  tabMode = 'info',
  placement = '',
  framePending = false
const dockErrors = new Map()
const dockIdentity = new Map()
function placeTab() {
  if (framePending) return
  framePending = true
  requestAnimationFrame(() => {
    framePending = false
    const host = $('official-pane')
    const r = host?.getBoundingClientRect()
    let rect = null
    if (screen === 'accounts' && !dialog.open && r && r.bottom > r.top) {
      const x = Math.max(0, Math.ceil(r.left)),
        y = Math.max(0, Math.ceil(r.top))
      const w = Math.min(innerWidth, Math.floor(r.right)) - x,
        h = Math.min(innerHeight, Math.floor(r.bottom)) - y
      if (w > 80 && h > 60) rect = { x, y, w, h }
    }
    const id = rect ? selectedAccount : null,
      key = JSON.stringify([id, rect])
    if (key === placement) return
    placement = key
    api['account-tab'](id, rect).catch((e) => {
      placement = ''
      toast(e.message)
    })
  })
}
document.addEventListener('DOMContentLoaded', () => {
window.addEventListener('resize', placeTab)
window.addEventListener('scroll', placeTab, { passive: true, capture: true })
new ResizeObserver(placeTab).observe(document.getElementById('account-space'))
new MutationObserver(placeTab).observe(document.getElementById('dialog'), {
  attributes: true,
  attributeFilter: ['open']
})
})
function renderAccounts() {
  const active = data.accounts.filter((a) => a.archived !== 1)
  const group = $('account-group').value,
    p = $('account-platform').value
  const query = $('account-search').value.trim().toLowerCase()
  $('account-group').innerHTML = selectOptions(
    [...new Set(active.map((a) => a.groupName).filter(Boolean))].sort().map((g) => [g, g]),
    group,
    '全部分组'
  )
  $('account-platform').innerHTML = selectOptions(
    [...new Set(active.map((a) => a.platform))].map((k) => [k, platforms[k]]),
    p,
    '全部平台'
  )
  const matches = active.filter(
    (a) =>
      (!group || group === a.groupName) &&
      (!p || p === a.platform) &&
      [a.name, nickname(a), a.identity, a.groupName, platforms[a.platform]]
        .join(' ')
        .toLowerCase()
        .includes(query)
  )
  $('account-filters').hidden = !active.length
  const list = $('account-list'),
    space = $('account-space'),
    sessionBar = $('account-session')
  sessionBar.replaceChildren()
  $('accounts').dataset.mode = 'info'
  if (!active.length) {
    list.innerHTML = '<p class="empty">尚未添加账号</p>'
    space.innerHTML =
      '<div class="platform-grid">' +
      Object.entries(platforms)
        .map(
          ([id, label]) =>
            '<button data-action="add" data-id="' +
            id +
            '">' +
            badge(id) +
            '<b>' +
            escape(label) +
            '</b>' +
            icon('plus') +
            '</button>'
        )
        .join('') +
      '</div>'
    placeTab()
    return
  }
  if (!matches.some((a) => a.id === selectedAccount)) {
    selectedAccount = matches[0]?.id || ''
    tabMode = 'info'
  }
  const a = matches.find((a) => a.id === selectedAccount)
  const byGroup = Map.groupBy(matches, (a) => a.groupName || '')
  list.innerHTML =
    '<div class="rail-label">账号 <b>' +
    matches.length +
    '</b></div>' +
    ([...byGroup]
      .map(
        ([name, accounts]) =>
          (name ? '<div class="list-group">' + escape(name) + '</div>' : '') +
          accounts
            .map(
              (a) =>
                '<div class="pick-shell"><button class="row account-pick ' +
                (a.id === selectedAccount ? 'selected' : '') +
                '" data-action="account-open" data-id="' +
                a.id +
                '">' +
                portrait(a) +
                '<span><b>' +
                escape(nickname(a)) +
                '</b><small>' +
                (a.id === selectedAccount && tabMode === 'web'
                  ? '<span id="tab-identity">' + escape(dockIdentity.get(a.id) || platforms[a.platform]) + '</span>'
                  : escape(platforms[a.platform])) +
                '</small></span></button>' +
                (a.id === selectedAccount ? '<button class="pick-tools" data-desk="account-tools" title="账号工具" aria-label="账号工具">⋯</button>' : '') +
                '</div>'
            )
            .join('')
      )
      .join('') || '<p class="empty">没有匹配账号</p>')
  if (!a) {
    space.replaceChildren()
    placeTab()
    return
  }
  $('accounts').dataset.mode = tabMode
  const s = sessionOf(a),
    works = (analyticsData?.native || []).filter((w) => w.accountId === a.id)
  const profile =
    '<div class="profile-bar">' +
    portrait(a) +
    '<div><strong>' +
    escape(nickname(a)) +
    '</strong><small>' +
    escape(
      [
        platforms[a.platform],
        visibleHandle(a),
        s?.name ? (s.name !== a.name ? '备注 ' + a.name : '') : '本机备注 · 身份未核对'
      ]
        .filter(Boolean)
        .join(' · ')
    ) +
    '</small></div>' +
    '<button class="edit-name" data-action="account-meta" data-id="' +
    a.id +
    '">' +
    icon('square-pen') +
    '管理</button></div>'
  sessionBar.innerHTML = tabMode === 'web'
    ? '<div class="account-controls narrow-account"><button data-action="profile-mode">返回账号列表</button></div>' : ''
  space.innerHTML =
    (tabMode === 'web'
      ? '<div id="official-pane"><p class="empty">' +
        (dockErrors.has(a.id) ? '后台加载失败，请刷新网页' : '正在打开官方后台…') +
        '</p></div>'
      : profile + '<div class="profile-body"><div class="profile-facts"><div><small>最近核对</small><strong>' +
        escape(s?.checked ? fmtDate(s.checked) : a.archived === 2 ? '待清理' : '待核对') +
        '</strong></div><div><small>粉丝</small><strong>' +
        formatNumber(s?.followers) +
        '</strong></div><div><small>已同步作品</small><strong>' +
        works.length +
        '</strong></div></div>' +
        '<div class="actions">' +
        (catalog[a.platform]?.syncWorks && !a.archived
          ? button('同步资料与作品', 'native-sync', a.id)
          : '') +
        button('查看作品', 'account-works', a.id) +
        '</div>' +
        nativeRows(works.slice(0, 5)) +
        '</div>')
  placeTab()
}
async function visualAction(action, id) {
  switch (action) {
    case 'sync-dashboard': {
      const accounts = homeAccounts().filter(
        (a) => catalog[a.platform]?.syncWorks && sessionOf(a)
      )
      const out = await Promise.allSettled(accounts.map((a) => api['sync-works'](a.id, '0')))
      await sync()
      await refreshAnalytics()
      const failed = out.find((x) => x.status === 'rejected')
      toast(failed ? failed.reason.message : accounts.length ? '作品指标已更新' : '本机数据已刷新')
      break
    }
    case 'open-account-workspace':
      if (dialog.open) dialog.close()
      await navigate('accounts')
      return visualAction('account-open', id)
    case 'account-home':
      await navigate('accounts')
      break
    case 'save-current':
      await save()
      toast(draft.id ? '草稿已保存' : '先写入标题、正文或添加素材')
      break
    case 'profile':
      selectedAccount = id
      tabMode = 'info'
      $('account-search').value = ''
      $('account-platform').value = ''
      $('account-group').value = ''
      await navigate('accounts')
      break
    case 'account-open': {
      if (
        ![...$('account-list').querySelectorAll('.account-pick')].some((b) => b.dataset.id === id)
      ) {
        $('account-search').value = ''
        $('account-platform').value = ''
        $('account-group').value = ''
      }
      selectedAccount = id
      tabMode = accountById(id)?.archived ? 'info' : 'web'
      if (tabMode === 'info') {
        await api['account-tab'](null, null)
        renderAccounts()
        break
      }
      renderAccounts()
      break
    }
    case 'profile-mode':
      tabMode = 'info'
      renderAccounts()
      break
    case 'tab-command':
      dockErrors.delete(selectedAccount)
      await api['account-tab-action'](selectedAccount, id)
      break
    case 'all-works':
    case 'account-works':
    case 'platform-works':
      dataTab = 'native'
      workFilterAccount = action === 'account-works' ? id : ''
      workFilterPlatform = action === 'platform-works' ? id : ''
      libraryPage = 0
      libraryPeriod = 0
      workTerm = ''
      await navigate('data')
      break
    default:
      return false
  }
  return true
}
document.addEventListener('DOMContentLoaded', () => {
  api.onTabIdentity((id, label) => {
    dockIdentity.set(id, label)
    if (selectedAccount === id && $('tab-identity')) $('tab-identity').textContent = label
  })
  api.onTabError((id, code) => {
    dockErrors.set(id, code)
    if (screen === 'accounts' && selectedAccount === id)
      toast('后台加载失败（' + code + '），可刷新网页重试')
  })
})
