'use strict'
/*
 * 发布日历：参考 AiToEarn 的日历排期（月 / 周视图、拖动改期、点日期新建、节日与营销节点）。
 * 数据仍来自本机发布队列；只有「排期中」（未到点）的任务可以拖动改期。
 */
let queueView = localStorage.getItem('queue-view') === 'calendar' ? 'calendar' : 'list'
let calMode = localStorage.getItem('calendar-mode') === 'week' ? 'week' : 'month'
let calCursor = new Date()
const DAY = 86400000
const pad2 = (n) => String(n).padStart(2, '0')
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const LUNAR_DAYS = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十']
const SOLAR_DAYS = {
  '01-01': ['元旦', 1], '02-14': ['情人节', 1], '03-08': ['妇女节', 1], '03-12': ['植树节', 0], '03-15': ['3·15', 0],
  '04-01': ['愚人节', 0], '05-01': ['劳动节', 1], '05-04': ['青年节', 0], '05-20': ['520', 1], '06-01': ['儿童节', 1],
  '06-18': ['618', 1], '07-01': ['建党节', 0], '08-01': ['建军节', 0], '09-10': ['教师节', 1], '10-01': ['国庆节', 1],
  '10-31': ['万圣夜', 0], '11-11': ['双11', 1], '12-12': ['双12', 1], '12-24': ['平安夜', 0], '12-25': ['圣诞节', 1]
}
const LUNAR_FESTIVALS = {
  '正-1': ['春节', 1], '正-15': ['元宵节', 1], '二-2': ['龙抬头', 0], '五-5': ['端午节', 1], '七-7': ['七夕', 1],
  '七-15': ['中元节', 0], '八-15': ['中秋节', 1], '九-9': ['重阳节', 1], '腊-8': ['腊八节', 0], '腊-23': ['小年', 0]
}
function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month, 1)
  return 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7
}
function lunarOf(d) {
  const months = FATIO_CALENDAR_DATA.months
  const key = ymd(d)
  if (key < months[0][0] || key > '2030-12-31') return null
  let lo = 0, hi = months.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (months[mid][0] <= key) lo = mid
    else hi = mid - 1
  }
  const [start, month] = months[lo]
  const [y, m, dd] = start.split('-').map(Number)
  const day = Math.round((dayStart(d) - new Date(y, m - 1, dd)) / DAY) + 1
  return { month, day }
}
/** 当天的节日、节气与农历文字。important=1 的进入「近期节点」。 */
function dayInfo(d) {
  const labels = []
  const md = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  if (SOLAR_DAYS[md]) labels.push({ name: SOLAR_DAYS[md][0], important: SOLAR_DAYS[md][1], kind: 'festival' })
  const y = d.getFullYear(), m = d.getMonth(), date = d.getDate()
  if (m === 4 && date === nthWeekday(y, 4, 0, 2)) labels.push({ name: '母亲节', important: 1, kind: 'festival' })
  if (m === 5 && date === nthWeekday(y, 5, 0, 3)) labels.push({ name: '父亲节', important: 1, kind: 'festival' })
  if (m === 10 && date === nthWeekday(y, 10, 4, 4)) labels.push({ name: '感恩节', important: 0, kind: 'festival' })
  const lunar = lunarOf(d)
  if (lunar && !lunar.month.startsWith('闰')) {
    const f = LUNAR_FESTIVALS[lunar.month + '-' + lunar.day]
    if (f) labels.unshift({ name: f[0], important: f[1], kind: 'festival' })
    const next = lunarOf(addDays(d, 1))
    if (next && next.month === '正' && next.day === 1) labels.unshift({ name: '除夕', important: 1, kind: 'festival' })
  }
  const term = FATIO_CALENDAR_DATA.terms[ymd(d)]
  if (term) labels.push({ name: term, important: ['清明', '冬至', '立春', '立秋'].includes(term) ? 1 : 0, kind: 'term' })
  const lunarText = lunar ? (lunar.day === 1 ? lunar.month + '月' : LUNAR_DAYS[lunar.day - 1] || '') : ''
  return { labels, lunarText }
}
function calendarRange() {
  if (calMode === 'week') {
    const start = addDays(dayStart(calCursor), -((calCursor.getDay() + 6) % 7))
    return { start, days: 7 }
  }
  const first = new Date(calCursor.getFullYear(), calCursor.getMonth(), 1)
  const start = addDays(first, -((first.getDay() + 6) % 7))
  const last = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 0)
  const days = Math.ceil((Math.round((last - start) / DAY) + 1) / 7) * 7
  return { start, days }
}
const statusTone = (s) =>
  s === 'queued' ? 'scheduled' : groups.pending.includes(s) ? 'pending' : groups.done.includes(s) ? 'done' : groups.attention.includes(s) ? 'attention' : 'muted'
const calendarJobs = () =>
  data.jobs.filter(
    (j) => j.status !== 'cancelled' && (!queuePlatform || accountById(j.accountId)?.platform === queuePlatform)
  )
const movable = (j) => j.status === 'queued' && j.due > Date.now()
const hm = (t) => {
  const d = new Date(t)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}
function jobChip(j) {
  const a = accountById(j.accountId)
  const text = j.title || j.body.split('\n')[0] || '未命名稿件'
  return (
    '<button class="cal-job tone-' +
    statusTone(j.status) +
    '" data-cal="job" data-key="' +
    escape(j.id) +
    '"' +
    (movable(j) ? ' draggable="true"' : '') +
    ' title="' +
    escape([states[j.status], platforms[a?.platform], a?.name, hm(j.due), text].filter(Boolean).join(' · ')) +
    '">' +
    (a ? badge(a.platform) : '') +
    '<time>' +
    hm(j.due) +
    '</time><span>' +
    escape(text) +
    '</span></button>'
  )
}
function upcomingNodes(from, days = 45) {
  const out = []
  for (let i = 0; i < days && out.length < 6; i++) {
    const d = addDays(from, i)
    for (const l of dayInfo(d).labels) if (l.important) out.push({ date: d, name: l.name, inDays: i })
  }
  return out.slice(0, 6)
}
function renderCalendar() {
  const host = $('calendar')
  const today = dayStart(new Date())
  const { start, days } = calendarRange()
  const jobs = calendarJobs()
  const byDay = new Map()
  for (const j of jobs) {
    const key = ymd(new Date(j.due))
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(j)
  }
  for (const list of byDay.values()) list.sort((a, b) => a.due - b.due)
  const inRange = jobs.filter((j) => j.due >= start.getTime() && j.due < addDays(start, days).getTime())
  const scheduled = inRange.filter((j) => j.status === 'queued').length
  const title =
    calMode === 'month'
      ? calCursor.getFullYear() + ' 年 ' + (calCursor.getMonth() + 1) + ' 月'
      : (start.getMonth() + 1) + ' 月 ' + start.getDate() + ' 日 – ' + (addDays(start, 6).getMonth() + 1) + ' 月 ' + addDays(start, 6).getDate() + ' 日'
  const nodes = upcomingNodes(today)
  const cells = []
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i)
    const key = ymd(d)
    const info = dayInfo(d)
    const list = byDay.get(key) || []
    const past = d < today
    const outside = calMode === 'month' && d.getMonth() !== calCursor.getMonth()
    const limit = calMode === 'month' ? 3 : 99
    const label = info.labels[0]
    cells.push(
      '<div class="cal-day' +
        (past ? ' past' : '') +
        (outside ? ' outside' : '') +
        (+d === +today ? ' is-today' : '') +
        (d.getDay() === 0 || d.getDay() === 6 ? ' weekend' : '') +
        '" data-day="' +
        key +
        '"><div class="cal-day-head"><b>' +
        d.getDate() +
        '</b>' +
        (label
          ? '<em class="cal-' + label.kind + (label.important ? ' important' : '') + '" title="' + escape(info.labels.map((l) => l.name).join(' · ')) + '">' + escape(label.name) + '</em>'
          : '<small>' + escape(info.lunarText) + '</small>') +
        (past ? '' : '<button class="cal-add" data-cal="new" data-key="' + key + '" aria-label="在 ' + key + ' 新建定时稿" title="在这天新建定时稿">' + icon('plus') + '</button>') +
        '</div><div class="cal-jobs">' +
        list.slice(0, limit).map(jobChip).join('') +
        (list.length > limit
          ? '<button class="cal-more" data-cal="day" data-key="' + key + '">还有 ' + (list.length - limit) + ' 条</button>'
          : '') +
        '</div></div>'
    )
  }
  host.innerHTML =
    '<div class="cal-toolbar"><div class="cal-nav"><button class="icon" data-cal="prev" aria-label="上一' +
    (calMode === 'month' ? '月' : '周') +
    '">' +
    icon('chevron-left') +
    '</button><button data-cal="today">今天</button><button class="icon" data-cal="next" aria-label="下一' +
    (calMode === 'month' ? '月' : '周') +
    '">' +
    icon('chevron-right') +
    '</button><h2>' +
    title +
    '</h2><small>' +
    inRange.length +
    ' 条任务' +
    (scheduled ? ' · ' + scheduled + ' 条排期中' : '') +
    '</small></div><div class="seg" role="group" aria-label="日历范围">' +
    ['month', 'week']
      .map(
        (m) =>
          '<button data-cal="mode" data-key="' + m + '" class="' + (m === calMode ? 'selected' : '') + '">' + (m === 'month' ? '月' : '周') + '</button>'
      )
      .join('') +
    '</div></div>' +
    (nodes.length
      ? '<div class="cal-nodes" aria-label="近期营销节点"><span>' +
        icon('flag') +
        '近期节点</span>' +
        nodes
          .map(
            (n) =>
              '<button data-cal="goto" data-key="' +
              ymd(n.date) +
              '"><b>' +
              escape(n.name) +
              '</b><small>' +
              (n.date.getMonth() + 1) +
              '/' +
              n.date.getDate() +
              ' · ' +
              (n.inDays ? n.inDays + ' 天后' : '今天') +
              '</small></button>'
          )
          .join('') +
        '</div>'
      : '') +
    '<div class="cal-grid cal-' +
    calMode +
    '"><div class="cal-week-head">' +
    ['一', '二', '三', '四', '五', '六', '日'].map((w) => '<span>周' + w + '</span>').join('') +
    '</div><div class="cal-cells">' +
    cells.join('') +
    '</div></div><p class="cal-legend"><span class="tone-scheduled">排期中，可拖动改期</span><span class="tone-pending">待手动发表</span><span class="tone-done">已完成</span><span class="tone-attention">需核对</span></p>'
}
function applyQueueView() {
  const calendar = queueView === 'calendar'
  $('jobs').hidden = calendar
  $('calendar').hidden = !calendar
  $('queue-filters').hidden = calendar
  document.querySelectorAll('#queue-view [data-cal=view]').forEach((b) => {
    const on = b.dataset.key === queueView
    b.classList.toggle('selected', on)
    b.setAttribute('aria-pressed', on)
  })
  if (calendar) renderCalendar()
}
function localInput(d) {
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
async function newOnDay(key) {
  const [y, m, d] = key.split('-').map(Number)
  let when = new Date(y, m - 1, d, 9, 0)
  if (when.getTime() < Date.now() + 10 * 60000) {
    when = new Date(Date.now() + 3600000)
    when.setMinutes(0, 0, 0)
  }
  await navigate('write')
  await dispatch('new')
  timing(true)
  $('due').value = localInput(when)
  updateControls()
  toast('已新建定时稿，排期 ' + fmtDate(when))
}
function showDay(key) {
  const list = calendarJobs()
    .filter((j) => ymd(new Date(j.due)) === key)
    .sort((a, b) => a.due - b.due)
  modal(key + ' 的发布任务', '<div class="cal-day-list">' + list.map(jobChip).join('') + '</div>')
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cal]')
  if (!b) return
  const key = b.dataset.key
  try {
    switch (b.dataset.cal) {
      case 'view':
        queueView = key
        localStorage.setItem('queue-view', key)
        applyQueueView()
        break
      case 'mode':
        calMode = key
        localStorage.setItem('calendar-mode', key)
        renderCalendar()
        break
      case 'prev':
      case 'next': {
        const step = b.dataset.cal === 'next' ? 1 : -1
        calCursor =
          calMode === 'month'
            ? new Date(calCursor.getFullYear(), calCursor.getMonth() + step, 1)
            : addDays(calCursor, step * 7)
        renderCalendar()
        break
      }
      case 'today':
        calCursor = new Date()
        renderCalendar()
        break
      case 'goto': {
        const [y, m, d] = key.split('-').map(Number)
        calCursor = new Date(y, m - 1, d)
        renderCalendar()
        document.querySelector('.cal-day[data-day="' + key + '"]')?.classList.add('flash')
        break
      }
      case 'new':
        await newOnDay(key)
        break
      case 'day':
        showDay(key)
        break
      case 'job':
        details(key)
        break
    }
  } catch (err) {
    toast(err.message)
  }
})
let draggingJob = null
document.addEventListener('dragstart', (e) => {
  const chip = e.target.closest?.('.cal-job[draggable=true]')
  if (!chip) return
  draggingJob = chip.dataset.key
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', draggingJob)
  chip.classList.add('dragging')
})
document.addEventListener('dragend', () => {
  draggingJob = null
  document.querySelectorAll('.cal-job.dragging,.cal-day.drop').forEach((el) => el.classList.remove('dragging', 'drop'))
})
function dropTarget(e) {
  const cell = e.target.closest?.('.cal-day')
  return draggingJob && cell && !cell.classList.contains('past') ? cell : null
}
document.addEventListener('dragover', (e) => {
  const cell = dropTarget(e)
  if (!cell) return
  e.preventDefault()
  document.querySelectorAll('.cal-day.drop').forEach((el) => el !== cell && el.classList.remove('drop'))
  cell.classList.add('drop')
})
document.addEventListener('drop', async (e) => {
  const cell = dropTarget(e)
  if (!cell) return
  e.preventDefault()
  const job = data.jobs.find((j) => j.id === draggingJob)
  draggingJob = null
  if (!job) return
  const old = new Date(job.due)
  const [y, m, d] = cell.dataset.day.split('-').map(Number)
  const due = new Date(y, m - 1, d, old.getHours(), old.getMinutes()).getTime()
  if (due === job.due) return
  try {
    if (due <= Date.now() + 60000) throw Error('这天的同一时刻已经过去，请拖到之后的日期')
    await api.reschedule(job.id, due)
    await sync()
    toast('已改期到 ' + fmtDate(due))
  } catch (err) {
    toast(err.message)
    renderCalendar()
  }
})
