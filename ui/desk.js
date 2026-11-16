'use strict'
let homeMetric = 'followers', homePlatform = '', homeAccount = '', homeDays = 7
let rankMetric = 'views', comparisonOrder = 'followers', libraryOrder = 'posted', libraryPage = 0, libraryPeriod = 0
const deskMetrics = { followers: '粉丝', likes: '点赞', comments: '评论', views: '播放 / 阅读' }
const deskButton = (text, cmd, id = '', style = '') =>
  '<button class="' +
  style +
  '" data-desk="' +
  cmd +
  '" data-key="' +
  escape(id) +
  '">' +
  escape(text) +
  '</button>'
function selectorButton(text, cmd, id, current) {
  return (
    '<button data-desk="' +
    cmd +
    '" data-key="' +
    escape(id) +
    '" aria-pressed="' +
    (current === id) +
    '">' +
    escape(text) +
    '</button>'
  )
}
function workArt(w) {
  if (w.cover) return { src: w.cover, source: '平台封面' }
  const j = w.jobId && data.jobs.find((j) => j.id === w.jobId)
  const id = j && (j.coverId || JSON.parse(j.assets)[0])
  return id ? { src: 'studio-media://image/' + id, source: '稿件首图' } : null
}
function artHTML(w) {
  const a = workArt(w)
  return a
    ? '<img src="' +
        escape(a.src) +
        '" alt="' +
        a.source +
        '" title="' +
        a.source +
        '">'
    : '<span class="empty-art">' + icon('image') + '暂无封面</span>'
}
function reportSummary() {
  const perf = data.performance
  if (!perf?.date) return '<div class="report-link">' + button('导入账号日报', 'report-import', '', 'plain') + '</div>'
  return (
    '<section class="panel report-panel">' +
    sectionHead('账号日报', button('导入报表', 'report-import', '', 'plain')) +
    (perf?.date
      ? '<small>' +
        escape(perf.date) +
        '</small>' +
        counters([
          ['昨日播放 / 阅读', perf.totals.yesterdayViews],
          ['昨日点赞', perf.totals.yesterdayLikes],
          ['昨日评论', perf.totals.yesterdayComments],
          ['昨日涨粉', perf.totals.yesterdayFollowers],
          ['昨日收益（元）', perf.totals.yesterdayRevenue],
          ['总收益（元）', perf.totals.revenue]
        ])
      : '<small>暂无账号日报</small>') +
    '</section>'
  )
}
let queuePlatform = ''
function renderJobGroups() {
  const all = data.jobs.filter(
    (j) =>
      !queuePlatform || accountById(j.accountId)?.platform === queuePlatform
  )
  const counts = [
    ['待处理', 'pending'],
    ['需核对', 'attention'],
    ['已完成', 'done']
  ]
  const groupsByBatch = new Map()
  for (const j of all.filter((j) => groups[filter].includes(j.status))) {
    const key = JSON.stringify([j.draftId, j.created, j.videoId])
    if (!groupsByBatch.has(key)) groupsByBatch.set(key, [])
    groupsByBatch.get(key).push(j)
  }
  $('jobs').innerHTML =
    (all.some(j => j.videoId && j.status === 'waiting' && (data.videoProgress?.[j.id] || data.lastVideoSync?.[j.id]))
      ? '<h2 class="sync-heading">' + icon('layers-2') + '视频同步中心</h2>' : '') +
    '<div class="queue-counts">' +
    counts
      .map(
        ([s, k]) =>
          '<button data-desk="queue-filter" data-key="' +
          k +
          '"><small>' +
          s +
          '</small><strong>' +
          all.filter((j) => groups[k].includes(j.status)).length +
          '</strong></button>'
      )
      .join('') +
    '</div><select id="queue-platform" aria-label="队列平台"><option value="">全部平台</option>' +
    [
      ...new Set(
        data.jobs.map((j) => accountById(j.accountId)?.platform).filter(Boolean)
      )
    ]
      .map(
        (k) =>
          '<option value="' +
          escape(k) +
          '" ' +
          (k === queuePlatform ? 'selected' : '') +
          '>' +
          escape(platforms[k]) +
          '</option>'
      )
      .join('') +
    '</select>' +
    ([...groupsByBatch.values()]
      .map((batch) => {
        const j = batch[0],
          cover = j.coverId || JSON.parse(j.assets)[0]
        return (
          '<section class="job-group"><div class="job-group-head">' +
          (cover
            ? '<img src="studio-media://image/' +
              escape(cover) +
              '" alt="稿件封面">'
            : icon('film')) +
          '<span><b>' +
          escape(j.title || j.body || '未命名稿件') +
          '</b><small>' +
          batch.length +
          ' 个账号 · ' +
          (j.videoId ? '视频' : '图文') +
          ' · ' +
          fmtDate(j.due) +
          '</small></span></div>' +
          batch
            .map((j) => {
              const a = accountById(j.accountId),
                progress = j.status === 'waiting' && data.videoProgress?.[j.id],
                last = !progress && data.lastVideoSync?.[j.id],
                work = analyticsData?.native?.find((w) => w.jobId === j.id)
              return (
                '<div class="row">' +
                badge(a.platform) +
                '<div class="row-main"><b>' +
                escape(nickname(a)) +
                '</b><small>' +
                escape(platforms[a.platform]) +
                '</small>' + (progress ? '<small class="sync-stage" data-phase="' + escape(progress.phase) + '">' + escape(progress.message) + '</small>' : last ? '<small>上次同步 · ' + escape(last) + '</small>' : '') +
                '</div><span class="status">' +
                states[j.status] +
                '</span><div class="actions">' +
                (j.status === 'waiting'
                  ? progress && progress.phase !== 'queued'
                    ? button('打开核对', 'open-only', j.id, 'queue-open') + (progress.phase === 'partial' ? button('重新带入', 'open', j.id) : '')
                    : progress ? '' : button(j.videoId ? '一键带入平台' : '打开编辑器', 'open', j.id, 'queue-open')
                  : work
                    ? button('作品数据', 'native-detail', work.id)
                    : j.url
                      ? button('查看作品', 'visit', j.id)
                      : '') +
                (j.status==='waiting'?deskButton('标记已发表','await-receipt',j.id,'queue-mark'):'') +
                (progress?.phase === 'partial' && j.coverId ? button('封面文件夹','video-materials',j.id) : '') +
                (data.manualMarks?.includes(j.id) ? deskButton('退回待处理', 'undo-manual', j.id, 'queue-return') : '') +
                button('详情', 'detail', j.id, '') +
                '</div></div>'
              )
            })
            .join('') +
          '</section>'
        )
      })
      .join('') || '<p class="empty">此处暂无发布任务</p>')
}
function accountTools() {
  const a = accountById(selectedAccount)
  if (!a) return
  modal(
    nickname(a),
    '<div class="actions">' +
      button('账号概览', 'profile-mode') +
      button('官方后台', 'account-open', a.id) +
      button('管理账号', 'account-meta', a.id) +
      '</div><div class="actions">' +
      [
        ['back', '后退'],
        ['forward', '前进'],
        ['reload', '刷新网页']
      ]
        .map(([k, v]) => button(v, 'tab-command', k))
        .join('') +
      '</div>'
  )
}
function setTheme(name) {
  document.documentElement.dataset.theme = name
  localStorage.setItem('desk-theme', name)
}
function refreshDeskScreen() {
  if (screen === 'accounts') {
    $('header-tools').insertAdjacentHTML(
      'beforeend',
      deskButton('筛选', 'account-search', '', 'filter-toggle') +
        deskButton(
          document.body.classList.contains('folded') ? '展开' : '收起',
          'fold',
          '',
          'fold-toggle'
        )
    )
  }
  if (screen === 'accounts') {
    $('screen-title').textContent='账号'
    const commands=[
      ['[data-action=new-douyin]','扫码添加抖音','qr-code'],
      ['[data-action=add]','添加账号','plus'],
      ['.filter-toggle','搜索与筛选','search'],
      ['.fold-toggle',document.body.classList.contains('folded')?'展开账号栏':'收起账号栏','panel-left']
    ]
    for(const [selector,label,glyph] of commands){
      const b=$('header-tools').querySelector(selector)
      if(!b)continue
      b.title=label;b.setAttribute('aria-label',label);b.innerHTML=icon(glyph)
    }
  }
  if (screen === 'write' || screen === 'video') {
    $('header-tools').insertAdjacentHTML(
      'beforeend',
      deskButton('Codex 交接', 'handoff')
    )
    showComposer()
  } else {
    const player = $('clip-player')
    player.pause()
  }
  if (screen === 'home')
    $('header-tools').insertAdjacentHTML(
      'beforeend',
      deskButton(
        document.documentElement.dataset.theme === 'dark' ? '浅色' : '暗色',
        'theme'
      )
    )
}
document.addEventListener('change', (e) => {
  const el = e.target
  if (el.id === 'queue-platform') {
    queuePlatform = el.value
    renderQueue()
    return
  }
  if (el.id === 'home-days' || el.id === 'comparison-days') {
    homeDays = Number(el.value)
    if (screen === 'home') renderHome()
    else renderAnalytics()
  } else if (el.id === 'home-account') {
    homeAccount = el.value
    renderHome()
  } else if (el.id === 'library-order' || el.id === 'library-period') {
    if (el.id === 'library-order') libraryOrder = el.value
    else libraryPeriod = Number(el.value)
    libraryPage = 0
    renderAnalytics()
  } else if (el.id === 'comparison-order') {
    comparisonOrder = el.value
    renderAnalytics()
  }
})
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-desk]')
  if (!b) return
  const id = b.dataset.key,
    cmd = b.dataset.desk
  try {
    switch (cmd) {
      case 'work-sources':
        workSources(workFilterAccount || activeAccounts().find(a => a.platform === workFilterPlatform)?.id)
        break
      case 'theme':
        setTheme(
          document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
        )
        renderScreen()
        break
      case 'home-platform':
        homePlatform = id
        homeAccount = ''
        renderHome()
        break
      case 'home-metric':
        homeMetric = id
        renderHome()
        break
      case 'rank-metric':
        rankMetric = id
        renderHome()
        break
      case 'library-page':
        libraryPage += Number(id)
        renderAnalytics()
        break
      case 'await-receipt':
        await api['await-receipt'](id)
        filter='attention'
        await sync()
        await checkPublicationStatus(true)
        break
      case 'undo-manual':
        await api['undo-manual'](id)
        filter = 'pending'
        if (dialog.open) dialog.close()
        await sync()
        renderQueue()
        toast('已退回待处理')
        break
      case 'queue-filter':
        filter = id
        renderQueue()
        break
      case 'account-tools':
        accountTools()
        break
      case 'account-search':
        document.body.classList.toggle('show-filters')
        if (document.body.classList.contains('show-filters'))
          $('account-search').focus()
        break
      case 'fold':
        resizeDirectory(
          document.body.classList.contains('folded')
            ? Number(localStorage.getItem('desk-account-width')) || 242
            : 60
        )
        renderScreen()
        break
      default:
        await composerAction(cmd, id)
    }
  } catch (err) {
    toast(err.message)
  }
})
document.addEventListener('DOMContentLoaded', () => {
  setTheme(localStorage.getItem('desk-theme') === 'light' ? 'light' : 'dark')
  resizeDirectory(
    localStorage.getItem('desk-fold') === 'true'
      ? 60
      : Number(localStorage.getItem('desk-account-width')) || 242
  )
  const bar = $('account-split')
  let origin = null
  bar.onpointerdown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    bar.focus()
    bar.setPointerCapture(e.pointerId)
    origin = [
      e.clientX,
      document.querySelector('.account-directory').getBoundingClientRect().width
    ]
  }
  bar.onpointermove = (e) => {
    if (origin) resizeDirectory(origin[1] + e.clientX - origin[0])
  }
  bar.onlostpointercapture = () => (origin = null)
  bar.ondblclick = () => resizeDirectory(242)
  bar.onkeydown = (e) => {
    const w = Number(bar.getAttribute('aria-valuenow'))
    if (e.key === 'Home') resizeDirectory(242)
    else if (e.key === 'ArrowRight') resizeDirectory(w === 60 ? 174 : w + 12)
    else if (e.key === 'ArrowLeft') resizeDirectory(w <= 174 ? 60 : w - 12)
    else return
    e.preventDefault()
  }
})
function resizeDirectory(w) {
  const fold = w < 120
  w = fold ? 60 : Math.max(174, Math.min(392, Math.round(w)))
  document.body.classList.toggle('folded', fold)
  document.body.style.setProperty('--directory-width', w + 'px')
  $('account-split').setAttribute('aria-valuenow', w)
  localStorage.setItem('desk-fold', String(fold))
  if (!fold) localStorage.setItem('desk-account-width', String(w))
  const toggle = document.querySelector('.fold-toggle')
  if (toggle) {toggle.title=fold?'展开账号栏':'收起账号栏';toggle.setAttribute('aria-label',toggle.title)}
  placeTab()
}
