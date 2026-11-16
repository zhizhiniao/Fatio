let analyticsData = null,
  dataTab = 'platforms',
  pageIndex = 0,
  loadingData = false,
  sourceFilter = '',
  archiveKind = 'accounts',
  archiveMetric = 'views',
  archivePlatform = ''
const workCursors = new Map()
function formatNumber(value) {
  return value == null
    ? '—'
    : Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
}
function counters(entries) {
  return (
    '<div class="metrics">' +
    entries
      .map(
        ([name, value]) =>
          '<div><span>' + escape(name) + '</span><strong>' + formatNumber(value) + '</strong></div>'
      )
      .join('') +
    '</div>'
  )
}
function dataTable(rows, columns, paginate = true) {
  const limit = 50,
    pages = Math.max(1, Math.ceil(rows.length / limit))
  const page = paginate ? Math.max(0, Math.min(pageIndex, pages - 1)) : 0
  if (!rows.length) return '<p class="empty">暂无此类数据</p>'
  return (
    '<div class="table-scroll"><table><thead><tr>' +
    columns.map(([_, label]) => '<th>' + label + '</th>').join('') +
    '</tr></thead><tbody>' +
    (paginate ? rows.slice(page * limit, (page + 1) * limit) : rows)
      .map(
        (row) =>
          '<tr>' +
          columns
            .map(
              ([k]) =>
                '<td>' +
                escape(typeof row[k] === 'number' ? formatNumber(row[k]) : (row[k] ?? '—')) +
                '</td>'
            )
            .join('') +
          '</tr>'
      )
      .join('') +
    '</tbody></table></div>' +
    (paginate && pages > 1
      ? '<div class="pager">' +
        (page > 0 ? button('上一页', 'data-page', '-1') : '') +
        ' ' +
        (page + 1) +
        ' / ' +
        pages +
        ' ' +
        (page < pages - 1 ? button('下一页', 'data-page', '1') : '') +
        '</div>'
      : '')
  )
}
function renderAnalytics() {
  const container = $('analytics')
  if (!analyticsData) {
    container.innerHTML =
      '<p class="empty">' + (loadingData ? '正在读取本机数据…' : '数据尚未读取') + '</p>'
    return
  }
  const tabs = { platforms: '账号表现', native: '作品库', archive: '历史资料' }
  const content = dataTab === 'platforms' ? comparisonView() : dataTab === 'native' ? workLibrary() : archiveView()
  container.innerHTML = '<div class="tabs data-sections">' + Object.entries(tabs).map(([id, name]) =>
    '<button data-action="data-tab" data-id="' + id + '" class="' + (id === dataTab ? 'active' : '') + '">' + name + '</button>'
  ).join('') + '</div><div class="data-content">' + content + Object.values(analyticsData.errors).map(message =>
    '<p class="message">' + escape(message) + '</p>').join('') + '</div>'
  bindWorkFilters()
}
function archiveView() {
  const { creator, review, reports } = analyticsData
  const kinds = { accounts: '账号报表', platforms: '平台报表', works: '导入的作品', reference: '参考样本' }
  const columns = {
    accounts: [['account','账号'], ['followers','粉丝'], ['views','播放'], ['yesterdayViews','昨日播放'], ['yesterdayLikes','昨日点赞'], ['yesterdayComments','昨日评论'], ['yesterdayFollowers','昨日涨粉'], ['revenue','收益'], ['yesterdayRevenue','昨日收益']],
    platforms: [['accountsCount','账号数'], ['recommended','推荐'], ['views','阅读 / 播放'], ['likes','点赞'], ['comments','评论'], ['followerGain','涨粉'], ['revenue','收益']],
    works: [['title','作品'], ['account','账号'], ['views','阅读 / 播放'], ['likes','点赞'], ['comments','评论'], ['collects','收藏'], ['shares','分享'], ['recommended','推荐']],
    reference: [['account','归档账号'], ['watched','观看记录'], ['liked','点赞记录'], ['favorites','收藏记录'], ['unique','不同作品'], ['time','归档更新时间']]
  }
  const hubPlatforms = [...new Set(creator.accounts.map(a => a.platform))].map(platform => ({
    platform, source: 'CreatorHub', accountsCount: creator.accounts.filter(a => a.platform === platform).length
  }))
  const lists = { accounts: [...reports.accounts, ...creator.accounts], platforms: [...reports.platforms, ...hubPlatforms],
    works: [...reports.works, ...creator.works], reference: review }
  const all = lists[archiveKind], isRef = archiveKind === 'reference', isWork = archiveKind === 'works'
  const rows = all.filter(r => (!sourceFilter || r.source === sourceFilter) && (!archivePlatform || r.platform === archivePlatform))
  if (isWork) rows.sort((a,b) => (b[archiveMetric] ?? -1) - (a[archiveMetric] ?? -1))
  const filters = '<select id="archive-kind" aria-label="资料类型">' + optionsHTML(Object.entries(kinds), archiveKind) + '</select>' +
    (!isRef ? '<select id="archive-source" aria-label="报表来源">' + selectOptions([...new Set(all.map(r => r.source))].map(s => [s,s]), sourceFilter, '全部来源') +
    '</select><select id="archive-platform" aria-label="报表平台">' + selectOptions([...new Set(all.map(r => r.platform))].map(s => [s,s]), archivePlatform, '全部平台') + '</select>' : '') +
    (isWork ? '<select id="archive-order" aria-label="排名指标">' + optionsHTML(columns.works.slice(2), archiveMetric) + '</select>' : '')
  let body = dataTable(rows, isRef ? columns.reference : [['source','来源'], ['platform','平台'], ...columns[archiveKind], ['time', isWork ? '发布时间' : '快照时间']])
  const history = archiveKind === 'accounts' ? rows.flatMap(a => (a.history || []).map(h => ({ account:a.account, platform:a.platform, ...h }))) : []
  if (history.length) body += '<details><summary>粉丝历史快照</summary>' + dataTable(history, [['platform','平台'], ['account','账号'], ['date','日期'], ['followers','粉丝']]) + '</details>'
  return '<div class="insight-head"><h2>历史资料</h2></div><div class="desk-filter">' + filters + '</div>' + body
}
function workSources(selected) {
  const accounts = activeAccounts(), a = accounts.find(a => a.id === selected) || accounts[0]
  const actions = !a ? '' :
    (catalog[a.platform]?.syncWorks ? button('同步作品','native-sync',a.id,'primary') +
      (workCursors.get(a.id) ? button('同步下一页','native-next',a.id) : '') : '') +
    button('官方后台','open-account-workspace',a.id) +
    (['bilibili','kuaishou','xhs','tiktok','wechat'].includes(a.platform) ? button('按链接读取','lookup-work',a.id) : '') +
    (!['douyin','channels'].includes(a.platform) ? button('导入指标','work-report',a.id) : '')
  modal('同步与导入', (a ? '<label class="form-row">账号<select id="work-source-account">' +
    optionsHTML(accounts.map(a => [a.id, platforms[a.platform] + ' · ' + nickname(a)]), a.id) + '</select></label>' : '') +
    '<div class="actions">' + actions + button('添加账号','add') + '</div>')
}
document.addEventListener('change', e => {
  const el = e.target
  if (el.id === 'work-source-account') return workSources(el.value)
  if (!el.id.startsWith('archive-')) return
  if (el.id === 'archive-kind') { archiveKind = el.value; sourceFilter = ''; archivePlatform = '' }
  if (el.id === 'archive-source') sourceFilter = el.value
  if (el.id === 'archive-platform') archivePlatform = el.value
  if (el.id === 'archive-order') archiveMetric = el.value
  pageIndex = 0
  renderAnalytics()
})
async function refreshAnalytics() {
  loadingData = true
  try {
    analyticsData = await api.insights()
  } finally {
    loadingData = false
    renderAnalytics()
    if (screen === 'home') renderHome()
    if (screen === 'accounts') renderAccounts()
  }
}
async function showProjects() {
  const projects = await api['project-import']()
  if (!projects) return
  modal(
    '导入创作项目',
    projects.length
      ? projects
          .map(
            (p) =>
              '<section><strong>' +
              escape(p.title) +
              '</strong>' +
              (p.error
                ? '<p>' + escape(p.error) + '</p>'
                : p.items
                    .map((n) => button(n, 'easel-item', JSON.stringify([p.key, n])))
                    .join('') || '<p>无可导入成品</p>') +
              '</section>'
          )
          .join('')
      : '<p>此目录没有可导入的项目。</p>'
  )
}
async function projectInfo() {
  const notes = await api['creative-notes'](draft.id),
    versions = await api.versions(draft.id)
  modal(
    '作品资料',
    '<form id="project-form"><label class="form-row">想法<textarea id="project-idea" maxlength="12000">' +
      escape(notes.idea) +
      '</textarea></label><label class="form-row">参考资料<textarea id="project-refs" maxlength="20000">' +
      escape(notes.refs) +
      '</textarea></label><button class="primary">保存资料</button></form>' +
      '<div class="desk-section"><h3>稿件版本</h3>' +
      button('保存当前版本', 'version-save') +
      versions
        .map((v) =>
          button('恢复版本 ' + v.revision + ' · ' + fmtDate(v.time), 'version-restore', v.revision)
        )
        .join('') +
      '</div>' +
      button('导出作品项目', 'easel-export')
  )
  $('project-form').onsubmit = async (e) => {
    e.preventDefault()
    try {
      await saveProjectNotes()
      dialog.close()
      toast('作品资料已保存')
    } catch (error) {
      toast(error.message)
    }
  }
}
async function saveProjectNotes() {
  if (dialog.open && $('project-form'))
    await api['creative-save-notes'](draft.id, $('project-idea').value, $('project-refs').value)
}
async function nativeDetail(id) {
  const w = analyticsData.native.find((x) => x.id === id)
  if (!w) throw Error('作品不存在')
  const history = await api['work-history'](id)
  const job = w.jobId && data.jobs.find(j => j.id === w.jobId)
  const sameBatch = job ? new Set(data.jobs.filter(j => j.draftId === job.draftId && j.created === job.created && j.videoId === job.videoId).map(j => j.id)) : new Set()
  const related = analyticsData.native.filter(other => other.id !== w.id && sameBatch.has(other.jobId))
  modal(
    '作品数据',
    '<h3>' +
      escape(w.title || w.itemId) +
      '</h3><p class="meta">' +
      escape(w.platformLabel + ' · ' + w.account + ' · ' + w.status) +
      '</p>' +
      counters([
        [w.platform === 'wechat' ? '阅读人数' : '播放', w.views],
        ['点赞', w.likes],
        ['评论', w.comments],
        ['分享', w.shares],
        ['收藏', w.collects]
      ]) +
      historyChart(history) +
      (related.length ? '<details><summary>同稿在其他平台的表现</summary>' + nativeRows(related) + '</details>' : '') +
      '<p class="hint">' +
      escape([w._source, w.linkSource, '最近采样 ' + fmtDate(w.seen)].filter(Boolean).join(' · ')) +
      (w._times && Object.values(w._times).some((t) => t < w.seen)
        ? ' · 部分指标沿用前次采样'
        : '') +
      '</p><div class="actions">' +
      (catalog[w.platform]?.syncWorks
        ? button('刷新指标', 'native-refresh', id)
        : button('导入指标', 'work-report', w.accountId)) +
      (w.draftId ? button('回到原稿', 'draft', w.draftId) : '') +
      button('官方后台', 'login', w.accountId) +
      '</div>' +
      (history.length > 1
        ? '<details><summary>历史快照</summary>' +
          dataTable(
            history.map((h) => ({ ...h, time: fmtDate(h.time) })),
            [
              ['time', '回读时间'],
              ['views', '播放'],
              ['likes', '点赞'],
              ['comments', '评论']
            ],
            false
          ) +
          '</details>'
        : '') +
      '<p class="message" id="native-error" role="alert"></p>'
  )
  const chart = $('chart-metric')
  if (chart)
    chart.onchange = async (e) => {
      chartMetric = e.target.value
      await nativeDetail(id)
    }
}
