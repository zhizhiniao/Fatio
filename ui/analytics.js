'use strict'
const metricIcons = { followers: 'users-round', views: 'play', likes: 'heart', comments: 'message-circle' }
const signedCount = n => n == null ? '—' : (n > 0 ? '+' : '') + formatNumber(n)
const movement = n => n == null ? 'missing' : n > 0 ? 'up' : n < 0 ? 'down' : 'steady'
function optionsHTML(entries, selected) {
  return entries.map(([value, label]) => `<option value="${escape(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${escape(label)}</option>`).join('')
}
function periodSelect(id) {
  return `<select id="${id}" aria-label="比较时段">${optionsHTML([[7, '近 7 天'], [30, '近 30 天']], homeDays)}</select>`
}
function scopeMetrics(accounts, rows) {
  const history = analyticsData?.growth?.[homeDays]?.accounts || {}
  return Object.fromEntries(Object.keys(deskMetrics).map(key => {
    const isFans = key === 'followers'
    const values = isFans ? accounts.map(a => sessionOf(a)?.followers) : rows.map(w => w[key])
    const known = values.filter(Number.isFinite)
    const samples = accounts.map(a => history[a.id]?.[key]).filter(Boolean)
    const daily = {}
    for (const sample of samples) {
      for (const [day, diff] of Object.entries(sample.daily)) daily[day] = (daily[day] ?? 0) + diff
    }
    return [key, { current: known.length ? known.reduce((n, v) => n + v, 0) : null,
      change: total(samples, 'change'), comparable: total(samples, 'comparable') || 0,
      daily, known: known.length, count: values.length, unit: isFans ? '个账号' : '篇作品' }]
  }))
}
function metricTiles(metrics) {
  return '<div class="metrics kpis desk-metrics growth-kpis">' + Object.entries(metrics).map(([key, m]) => {
    const label = key === 'followers' ? '净增粉丝' : deskMetrics[key] + '变化'
    return `<button data-desk="home-metric" data-key="${key}" aria-pressed="${homeMetric === key}">
      <span class="growth-label">${icon(metricIcons[key])} ${label}</span>
      <span class="growth-value"><strong class="${movement(m.change)}">${signedCount(m.change)}</strong>
      <small>${m.comparable ? m.comparable + ' ' + m.unit + '可比' : m.known ? '等待第二次读数' : '暂无读数'}</small></span>
      <span class="growth-base">${m.current == null ? '暂无累计读数' : '累计 ' + formatNumber(m.current)}
      <small>${m.known}/${m.count} ${m.unit}</small></span></button>`
  }).join('') + '</div>'
}
function growthChart(metrics) {
  const m = metrics[homeMetric], dates = analyticsData?.growth?.[homeDays]?.days || []
  const unit = homeMetric === 'followers' ? '粉丝净增' : deskMetrics[homeMetric] + '变化'
  const hint = homeMetric === 'followers' ? '小红书取官方净涨粉日报，其余账号比较时段内首末两次粉丝读数。' :
    '比较同一作品在时段内的首末读数，差额记在后一次采样日。只有一次读数的作品不参与。'
  const values = Object.values(m.daily)
  let graph = '<div class="growth-empty">本时段暂无可比数据<br><small>同步作品后，已有两次读数或官方日报时显示变化。</small></div>'
  if (values.length) {
    const high = Math.max(0, ...values), low = Math.min(0, ...values)
    const span = high - low || 1
    const y = v => 12 + ((high - v) / span) * 74
    const baseline = high === low ? 55 : y(0)
    const width = 600 / dates.length
    const bars = dates.map((day, i) => {
      const value = m.daily[day], x = i * width + width / 2
      const barWidth = Math.min(width * 0.54, 38)
      const shape = value == null ? `<circle class="no-point" cx="${x}" cy="${baseline}" r="2"/>` :
        `<rect class="${movement(value)}" x="${x - barWidth / 2}" y="${value === 0 ? baseline - 1 : Math.min(baseline, y(value))}"
          width="${barWidth}" height="${Math.max(2, Math.abs(baseline - y(value)) * (value === 0 ? 0 : 1))}" rx="2"/>`
      const label = value && (homeDays === 7 || day === dates.find(d => Math.abs(m.daily[d]) === Math.max(high, -low)))
        ? `<text x="${x}" y="${value > 0 ? y(value) - 3 : y(value) + 11}" text-anchor="middle">${signedCount(value)}</text>` : ''
      return `<g><title>${day} · ${value == null ? '无可比读数' : signedCount(value)}</title>
        <rect x="${i * width}" y="0" width="${width}" height="100" fill="transparent"/>${shape}${label}</g>`
    }).join('')
    const latest = dates.findLast(day => m.daily[day] != null)
    const labels = homeDays === 7 ? dates : dates.filter((_, i) => [0, 7, 14, 21, 29].includes(i))
    graph = `<div class="growth-latest">最近有数据的日期 <b>${latest.slice(5)} · ${signedCount(m.daily[latest])}</b></div>
      <svg viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label="${unit}，合计 ${signedCount(m.change)}">
      <path class="guide" d="M0 12H600 M0 49H600 M0 86H600"/><path class="axis" d="M0 ${baseline}H600"/>${bars}</svg>
      <div class="chart-dates">${labels.map(d => '<span>' + d.slice(5).replace('-', '/') + '</span>').join('')}</div>`
  }
  return `<section class="growth-chart"><div class="section-row"><h2>${unit}趋势</h2>
    <small>${m.comparable} ${m.unit}可比</small></div>${graph}
    <div class="chart-note">${hint}${values.length ? ' 圆点表示缺少对照。' : ''}</div></section>`
}
function workCard(w, key, rank) {
  const stamp = w.posted ? new Date(w.posted * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''
  return `<button class="poster-card rank work-card" data-action="native-detail" data-id="${escape(w.id)}">
    <span class="poster">${artHTML(w)}${rank ? '<em>' + String(rank).padStart(2, '0') + '</em>' : ''}</span>
    <span class="poster-text"><small class="work-byline">${badge(w.platform)} ${escape(w.account)}<time>${escape(stamp)}</time></small>
    <b title="${escape(w.title)}">${escape(w.title || w.itemId)}</b>
    <span class="card-counts">${[...new Set([key, 'views', 'likes', 'comments'])].map(k =>
      `<span title="${metricNames[k]}" aria-label="${metricNames[k]} ${formatNumber(w[k])}">${icon(metricIcons[k] || (k === 'shares' ? 'share-2' : 'bookmark'))} ${formatNumber(w[k])}</span>`).join('')}</span>
    </span></button>`
}
function homeAccounts() {
  return activeAccounts().filter(a => (!homePlatform || a.platform === homePlatform) && (!homeAccount || a.id === homeAccount))
}
function renderPersonalHome() {
  const accounts = activeAccounts()
  const platformKeys = [...new Set(accounts.map(a => a.platform))]
  if (!platformKeys.includes(homePlatform)) homePlatform = ''
  const group = accounts.filter(a => a.platform === homePlatform)
  if (!group.some(a => a.id === homeAccount)) homeAccount = ''
  const selected = homeAccounts(), ids = new Set(selected.map(a => a.id))
  const works = (analyticsData?.native || []).filter(w => ids.has(w.accountId))
  const metrics = scopeMetrics(selected, works)
  const chips = [['', '全部平台'], ...platformKeys.map(p => [p, platforms[p]])].map(([key, name]) =>
    `<button data-desk="home-platform" data-key="${escape(key)}" aria-pressed="${key === homePlatform}">${key ? badge(key) : ''}${escape(name)}</button>`).join('')
  const ranked = rankMetric === 'posted' ? recentWorks(works) :
    works.filter(w => Number.isFinite(w[rankMetric])).sort((a, b) => b[rankMetric] - a[rankMetric])
  const controls = ['views', 'likes', 'comments', 'posted'].map(k =>
    selectorButton(deskMetrics[k] || '最近发布', 'rank-metric', k, rankMetric)).join('')
  const drill = homeAccount ? ['account-works', homeAccount] : homePlatform ? ['platform-works', homePlatform] : ['all-works', '']
  $('overview').innerHTML = `<div class="insight-head"><h2>运营概览</h2>${periodSelect('home-days')}</div>
    <div class="scope-bar">${chips}${group.length > 1 ? '<select id="home-account" aria-label="选择账号">' +
      selectOptions(group.map(a => [a.id, nickname(a)]), homeAccount, '全部账号') + '</select>' : ''}</div>
    <div class="overview-band">${metricTiles(metrics)}${growthChart(metrics)}</div>
    <section class="desk-ranks"><div class="section-row"><h2>${rankMetric === 'posted' ? '最近发布' : '作品累计排行'} <small>${works.length} 篇</small></h2>
    <div class="desk-switch">${controls}${button('查看全部', drill[0], drill[1], 'plain')}</div></div>
    <div class="poster-grid">${ranked.slice(0, 5).map((w, i) => workCard(w, rankMetric === 'posted' ? 'views' : rankMetric, rankMetric === 'posted' ? 0 : i + 1)).join('') || '<p class="empty">暂无符合条件的作品</p>'}</div></section>
    ${pendingSection(ids)}${homePlatform ? '' : reportSummary()}`
}
function comparisonView() {
  const works = analyticsData.native
  const groups = new Map()
  for (const a of activeAccounts()) {
    if (!groups.has(a.platform)) groups.set(a.platform, [])
    groups.get(a.platform).push(a)
  }
  const entries = [...groups].map(([platform, accounts]) => {
    const rows = works.filter(w => accounts.some(a => a.id === w.accountId))
    return { platform, accounts, rows, metrics: scopeMetrics(accounts, rows) }
  }).sort((a, b) => (b.metrics[comparisonOrder].change ?? -Infinity) - (a.metrics[comparisonOrder].change ?? -Infinity))
  function row(name, subtitle, key, action, id, metrics, count) {
    return `<tr><th scope="row"><button class="compare-link" data-action="${action}" data-id="${escape(id)}">${badge(key)}
      <span>${escape(name)}<small>${escape(subtitle)}</small></span></button></th>${['followers', 'likes', 'comments', 'views'].map(k =>
        `<td title="${metrics[k].comparable} ${metrics[k].unit}可比"><b class="${movement(metrics[k].change)}">${signedCount(metrics[k].change)}</b><small>累计 ${formatNumber(metrics[k].current)}</small></td>`).join('')}
        <td>${button(count + ' 篇', action, id, 'plain')}</td></tr>`
  }
  const table = entries.map(({ platform, accounts, rows, metrics }) => {
    const multiple = accounts.length > 1
    return row(platforms[platform], multiple ? accounts.length + ' 个账号' : nickname(accounts[0]), platform, 'platform-works', platform, metrics, rows.length)
      + (multiple ? accounts.map(a => {
        const owned = rows.filter(w => w.accountId === a.id)
        return row(nickname(a), '账号明细', platform, 'account-works', a.id, scopeMetrics([a], owned), owned.length)
      }).join('') : '')
  }).join('')
  return `<section class="comparison"><div class="insight-head"><h2>平台与账号表现</h2><div class="desk-filter">${periodSelect('comparison-days')}
    <select id="comparison-order" aria-label="对比排序">${optionsHTML(Object.entries(deskMetrics).map(([k,v]) => [k,'按' + v + '变化']), comparisonOrder)}</select></div></div>
    <p class="meta">按近 ${homeDays} 天的变化排序。点击平台或账号查看对应作品。</p>
    ${entries.length ? `<div class="table-scroll"><table class="compare-table"><thead><tr><th>平台 / 账号</th><th>净增粉丝</th><th>点赞变化</th><th>评论变化</th><th>播放 / 阅读变化</th><th>作品</th></tr></thead><tbody>${table}</tbody></table></div>` : '<p class="empty">添加账号并同步作品后，可在这里比较表现。</p>'}
    <small class="chart-note">累计数只含已有读数。“—”表示缺少读数或对照。互动变化比较同一作品的首末采样。</small></section>`
}
function workLibrary() {
  const sorted = filteredWorks().sort((a, b) => (b[libraryOrder] ?? -1) - (a[libraryOrder] ?? -1) || b.seen - a.seen)
  const pages = Math.max(1, Math.ceil(sorted.length / 12))
  libraryPage = Math.max(0, Math.min(libraryPage, pages - 1))
  const page = sorted.slice(libraryPage * 12, (libraryPage + 1) * 12)
  return `<div class="insight-head"><h2>作品库 <small>${sorted.length} 篇</small></h2>${deskButton('同步与导入', 'work-sources', '', 'outline')}</div>
    <div class="library-tools">${nativeFilters()}<div class="desk-filter"><select id="library-period" aria-label="发布时间">${optionsHTML([[0,'全部时间'],[7,'近 7 天发布'],[30,'近 30 天发布']], libraryPeriod)}</select><select id="library-order" aria-label="作品排序">${optionsHTML([
      ['posted','最新发布'], ['views','播放 / 阅读最多'], ['likes','点赞最多'], ['comments','评论最多'], ['shares','分享最多'], ['collects','收藏最多']
    ], libraryOrder)}</select></div></div>
    <div class="library-grid">${page.map(w => workCard(w, libraryOrder === 'posted' ? 'views' : libraryOrder, 0)).join('') ||
      '<p class="empty">没有匹配的作品</p>'}</div>
    ${pages > 1 ? `<div class="pager">${libraryPage ? deskButton('上一页', 'library-page', '-1') : ''} ${libraryPage + 1} / ${pages} ${libraryPage + 1 < pages ? deskButton('下一页', 'library-page', '1') : ''}</div>` : ''}`
}
