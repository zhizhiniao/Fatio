'use strict'
const $ = (id) => document.getElementById(id)
const api = window.studio
const dialog = $('dialog')
let platforms = {},
  catalog = {}
const states = {
  queued: '待执行',
  waiting: '待手动发表',
  sending: '发送中',
  hub_pending: 'CreatorHub 执行中',
  published: '已发布 · 有回执',
  recorded: '已登记',
  uncertain: '结果待核对',
  failed: '失败',
  cancelled: '已取消'
}
const groups = {
  pending: ['queued', 'waiting', 'sending', 'hub_pending'],
  done: ['published', 'recorded'],
  attention: ['failed', 'uncertain'],
  all: Object.keys(states)
}
const blank = (kind = 'article') => ({
  kind,
  videos: [],
  covers: {},
  id: null,
  revision: 0,
  title: '',
  body: '',
  xText: '',
  targets: [],
  assets: []
})
let imageIds = [],
  videoIds = [],
  variants = {}
let data = { accounts: [], drafts: [], jobs: [] },
  draft = blank(),
  screen = 'home',
  filter = 'all',
  timed = false
let autosave,
  saveChain = Promise.resolve(),
  toastTimer,
  countVersion = 0,
  modalOrigin,
  actionBusy = false
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
const icon = (name) => '<i aria-hidden="true" data-icon="' + name + '"></i>'
const badge = (platform) =>
  catalog[platform]
    ? '<img class="brand-icon" alt="" src="brands/' + encodeURIComponent(platform) + '.png">'
    : icon('users-round')
const button = (label, action, id = '', style = 'outline') =>
  '<button class="' +
  style +
  '" data-action="' +
  action +
  '" data-id="' +
  escape(id) +
  '">' +
  escape(label) +
  '</button>'
const displayName = (d) =>
  d.title.trim() || d.body.trim().split('\n')[0]?.slice(0, 32) || '未命名草稿'
const fmtDate = (t) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(t)
const accountById = (id) => data.accounts.find((a) => a.id === id)
const modeName = (a) => (a.mode === 'api' ? 'API' : a.mode === 'creatorhub' ? 'CreatorHub' : '网页')
const activeAccounts = () => data.accounts.filter((a) => !a.archived)
function toast(message) {
  $('toast').textContent = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => ($('toast').textContent = ''), 5000)
}
function localValues() {
  return {
    kind: draft.kind || 'article',
    videos: [...videoIds],
    artNote,
    covers: Object.fromEntries(Object.entries(editorCovers).filter(([id])=>videoIds.includes(id))),
    coverFormats: Object.fromEntries(Object.entries(editorFormats).filter(([id]) => videoIds.includes(id))),
    videoTags: draft.kind === 'video' ? $('video-tags').value : '',
    variants: structuredClone(variants),
    title: $('title').value,
    body: $('body').value,
    xText: $('x-text').value,
    assets: [...imageIds],
    targets: [...$('targets').querySelectorAll('input:checked')].map((el) => el.value)
  }
}
function signature(d) {
  return JSON.stringify([
    d.kind || 'article',
    d.title,
    d.body,
    d.xText,
    d.targets,
    d.assets ?? [],
    d.videos ?? [],
    d.variants ?? {},
    d.covers ?? {},
    d.coverFormats ?? {},
    d.videoTags ?? '',
    d.artNote ?? ''
  ])
}
function renderImages() {
  $('images').innerHTML = imageIds
    .map((id) => data.assets.find((a) => a.id === id))
    .filter(Boolean)
    .map(
      (a) =>
        '<div class="art-tile"><button class="thumb" data-desk="art" data-key="'+imageIds.indexOf(a.id)+'"><img alt="'+escape(a.name)+'" src="studio-media://image/'+a.id+'"></button><button class="remove-art" data-action="remove-image" data-id="'+a.id+'" aria-label="移除 '+escape(a.name)+'">×</button><small>'+escape(a.name)+'</small></div>'
    )
    .join('')
}
function renderVideoList() {
  updateVideoPreview()
  const size = (n) =>
    n < 1024
      ? n + ' B'
      : n < 1048576
        ? formatNumber(n / 1024) + ' KB'
        : n < 1073741824
          ? formatNumber(n / 1048576) + ' MB'
          : formatNumber(n / 1073741824) + ' GB'
  $('video-list').innerHTML = videoIds
    .map((id) => data.videos?.find((v) => v.id === id))
    .filter(Boolean)
    .map(
      (v) =>
        '<div class="source-line"><span>' +
        escape(v.name) +
        '<small>' +
        size(v.size) +
        '</small></span>' +
        button('预览', 'select-clip', v.id, '') + button('移除', 'remove-video', v.id, '') +
        '</div>'
    )
    .join('')
}
async function importVideoSelection(read) {
  const button = $('video-drop')
  button.disabled = true
  button.textContent = '正在导入视频…'
  try {
    await addVideos(await read())
  } finally {
    button.innerHTML = icon('film') + '选择或拖入视频'
    button.disabled = false
  }
}
async function addVideos(ids) {
  if (!ids.length) return
  const all = [...new Set([...videoIds, ...ids])]
  if (all.length > 32) throw Error('每批最多 32 个视频')
  await sync()
  videoIds = all
  renderVideoList()
  dirty()
}
function save() {
  clearTimeout(autosave)
  const op = saveChain.then(async () => {
    const values = localValues()
    if (signature(values) === signature(draft)) return
    $('saved').textContent = '保存中…'
    draft = await api.save({ ...values, id: draft.id, revision: draft.revision })
    data.drafts = [draft, ...data.drafts.filter((d) => d.id !== draft.id)]
    $('saved').textContent = signature(localValues()) === signature(draft) ? '已保存' : '待保存'
    renderDraftList()
  })
  saveChain = op.catch(() => {
    $('saved').textContent = '保存失败'
  })
  return op
}
function dirty() {
  $('saved').textContent = '待保存'
  clearTimeout(autosave)
  autosave = setTimeout(() => save().catch((e) => toast(e.message)), 380)
  updateControls()
}
function renderDraftList() {
  $('draft-list').innerHTML = data.drafts
    .filter((d) => (d.kind || 'article') === (screen === 'video' ? 'video' : 'article'))
    .map(
      (d) =>
        '<button class="draft-link ' +
        (draft.id === d.id ? 'current' : '') +
        '" data-action="draft" data-id="' +
        d.id +
        '" title="' +
        escape(displayName(d)) +
        '">' +
        escape(displayName(d)) +
        '</button>'
    )
    .join('')
}
function setDraft(d) {
  coverOwner++
  $('art-status').textContent = ''
  $('cover-title').checked = false
  $('cover-idea').value = d.artNote || localStorage.getItem('series-cover-idea') || ''
  $('cover-layout').value = localStorage.getItem('series-cover-layout') || 'contain'
  draft = d
  $('title').value = d.title
  $('body').value = d.body
  $('x-text').value = d.xText
  imageIds = [...(d.assets ?? [])]
  videoIds = [...(d.videos ?? [])]
  artNote=d.artNote || ''
  editorCovers = {...d.covers}
  editorFormats = structuredClone(d.coverFormats || {})
  $('video-tags').value = d.videoTags || ''
  resetAssist()
  variants = structuredClone(d.variants ?? {})
  $('variant-platform').replaceChildren()
  renderVideoList()
  renderImages()
  $('saved').textContent = d.id ? '已保存' : '空白草稿'
  renderTargets(d.targets)
  renderDraftList()
  updateControls()
}
function renderTargets(selected) {
  const kind = draft.kind || 'article'
  const active = activeAccounts().filter((a) => catalog[a.platform]?.[kind])
  $('targets').innerHTML = active.length
    ? active
        .map(
          (a) =>
            '<label class="target"><input type="checkbox" aria-label="' +
            escape([platforms[a.platform], a.name, a.identity, modeName(a)].join(' ')) +
            '" value="' +
            a.id +
            '" ' +
            (selected.includes(a.id) ? 'checked' : '') +
            '>' +
            portrait(a) +
            '<span class="name">' +
            escape(nickname(a)) +
            '<small>' +
            escape(a.platform === 'x' ? '@' + a.identity : a.identity) +
            ' · ' +
            modeName(a) +
            '</small></span></label>'
        )
        .join('')
    : '<button class="platform-add" data-action="add" data-id="douyin">' +
      icon('plus') +
      '添加发布账号</button>'
  document.querySelector('[aria-label="添加目标账号"]').hidden = !active.length
}
async function updateControls() {
  const version = ++countVersion
  const v = localValues(),
    targets = v.targets.map(accountById).filter(Boolean)
  $('word-count').textContent = Array.from(v.body.trim()).length + ' 字'
  const hasX = targets.some((a) => a.platform === 'x')
  $('x-option').hidden = !hasX
  const others = [...new Set(targets.map((a) => a.platform).filter((p) => p !== 'x'))]
  const chooser = $('variant-platform')
  if (JSON.stringify([...chooser.options].map((o) => o.value)) !== JSON.stringify(others)) {
    const previous = chooser.value
    chooser.innerHTML = others
      .map((p) => '<option value="' + p + '">' + platforms[p] + '</option>')
      .join('')
    if (others.includes(previous)) chooser.value = previous
    loadVariant()
  }
  $('variants').hidden = !others.length
  $('variant-video').hidden = v.kind !== 'video'
  renderPrecheck(v)
  $('enqueue').disabled =
    !targets.length ||
    (v.kind === 'video'
      ? !videoIds.length
      : targets.some(
          (a) =>
            !(a.platform === 'x'
              ? v.xText.trim() || v.body.trim()
              : variants[a.platform]?.body.trim() || v.body.trim())
        ))
  const direct = targets.some((a) => a.mode !== 'web')
  const batchAvailable = v.kind === 'video' && !direct && !timed
  $('sync-video').hidden = !batchAvailable
  $('sync-video').disabled = $('enqueue').disabled
  $('sync-video').querySelector('span').textContent = targets.length ? '一键带入 ' + targets.length + ' 个账号' : '一键带入所选账号'
  $('enqueue').classList.toggle('primary', !batchAvailable)
  $('enqueue').querySelector('span').textContent = direct
    ? timed
      ? '安排发布'
      : '立即发布'
    : timed
      ? '安排发布'
      : '加入发布队列'
  if (hasX) {
    const n = await api.count(v.xText.trim() || v.body.trim())
    if (version !== countVersion) return
    $('x-count').textContent = n + ' / 280'
    $('x-count').classList.toggle('over', n > 280)
    if (n > 280) $('enqueue').disabled = true
  }
}
function renderScreen() {
  for (const name of ['home', 'write', 'data', 'queue', 'accounts'])
    $(name).hidden = name !== (screen === 'video' ? 'write' : screen)
  const video = screen === 'video'
  $('draft-heading').textContent = video ? '我的视频' : '我的图文'
  document.body.dataset.screen = screen
  const bar = $('command-bar')
  const barHost = document.querySelector(screen === 'accounts' ? '.account-directory' : 'main')
  if (bar.parentElement !== barHost) barHost.prepend(bar)
  document
    .querySelectorAll('[data-action=format]')
    .forEach((b) => b.classList.toggle('active', b.dataset.id === (video ? 'video' : 'article')))
  $('video-panel').hidden = !video
  $('images').hidden = video
  document.querySelector('[data-action=images]').hidden = video
  $('title').placeholder = video ? '视频标题（可沿用文件名）' : '文章标题'
  $('body').placeholder = video ? '视频简介（选填）' : '从这里开始写…'
  document.querySelectorAll('[data-nav]').forEach((b) => {
    const active = b.dataset.nav === screen
    b.classList.toggle('active', active)
    b.setAttribute('aria-current', active ? 'page' : 'false')
  })
  $('screen-title').textContent = {
    home: '工作台',
    video: '发视频',
    data: '数据',
    write: '发图文',
    accounts: '账号管理',
    queue: '发布队列'
  }[screen]
  $('header-tools').innerHTML = ['write', 'video'].includes(screen)
    ? '<button class="mobile-drafts" data-action="drafts">' +
      icon('files') +
      '草稿</button><button data-action="import">' +
      icon('file-input') +
      '导入</button><button class="outline" data-action="new">' +
      icon('plus') +
      '新稿</button>'
    : screen === 'accounts'
      ? button('扫码添加抖音', 'new-douyin') +
        '<button class="primary" data-action="add">' +
        icon('plus') +
        '添加账号</button>'
      : screen === 'data'
        ? button('导入历史资料', 'history-menu') + button('导出到 NAS', 'nas-export') + button('刷新', 'data-refresh')
        : screen === 'queue'
          ? button('核对发表状态', 'reconcile-queue') + button('发图文', 'to-write')
          : '<span class="today">' +
            new Intl.DateTimeFormat('zh-CN', {
              month: 'long',
              day: 'numeric',
              weekday: 'long'
            }).format(new Date()) +
            '</span>' +
            button('刷新数据', 'sync-dashboard')
  renderDraftList()
  renderQueue()
  renderAccounts()
  renderHome()
  if (screen === 'data') renderAnalytics()
  refreshDeskScreen()
}
async function sync() {
  data = await api.snapshot()
  catalog = data.catalog
  platforms = Object.fromEntries(Object.entries(catalog).map(([id, p]) => [id, p.label]))
  renderDraftList()
  renderQueue()
  renderAccounts()
  if (screen === 'home') renderHome()
}
async function navigate(to) {
  await save()
  await sync()
  if (['write', 'video'].includes(to)) {
    const kind = to === 'video' ? 'video' : 'article'
    if ((draft.kind || 'article') !== kind)
      setDraft(data.drafts.find((d) => (d.kind || 'article') === kind) || blank(kind))
  }
  const selected = draft.targets.filter((id) => activeAccounts().some((a) => a.id === id))
  renderTargets(selected)
  if (selected.length !== draft.targets.length) dirty()
  screen = to
  renderScreen()
  if (to !== 'accounts') {
    placement = JSON.stringify([null, null])
    await api['account-tab'](null, null)
  }
  updateControls()
  if (to === 'queue') void checkPublicationStatus(false)
  if (to === 'data' || to === 'home') await refreshAnalytics()
}
let checkingQueue = false
async function checkPublicationStatus(force) {
  if (checkingQueue) return
  const status = $('queue-check-status')
  if (!force && !data.jobs.some(j => ['waiting','uncertain'].includes(j.status))) return
  checkingQueue = true
  status.hidden = false
  status.textContent = '正在从账号后台核对发表状态…'
  try {
    const result = await api['reconcile-queue'](force)
    await sync()
    const remaining=data.jobs.filter(j=>['waiting','uncertain'].includes(j.status)).length
    status.textContent = result.errors.length ? result.errors.join('；') : remaining
      ? '还有 ' + remaining + ' 条未核实，可在任务详情选择本人作品。'
      : '当前可核对的任务均已处理。'
  } catch (error) { status.textContent = error.message } finally { checkingQueue = false }
}
function renderQueue() {
  const pending = data.jobs.filter((j) => groups.pending.includes(j.status)).length
  $('pending').textContent = pending || ''
  $('queue-filters').innerHTML = Object.entries({
    pending: '待处理',
    attention: '需核对',
    done: '已完成',
    all: '全部'
  })
    .map(
      ([k, name]) =>
        '<button data-action="filter" data-id="' +
        k +
        '" class="' +
        (k === filter ? 'active' : '') +
        '">' +
        name +
        '</button>'
    )
    .join('')
  renderJobGroups()
  applyQueueView()
}
function modal(title, body) {
  if (!dialog.open) modalOrigin = document.activeElement
  $('dialog-inner').innerHTML =
    '<div class="modal-head"><h2>' +
    escape(title) +
    '</h2><button class="icon" data-action="close" aria-label="关闭">' +
    icon('x') +
    '</button></div>' +
    body
  if (!dialog.open) dialog.showModal()
}
function showAccount(platform = 'x') {
  modal(
    '添加账号',
    '<form id="account-form"><label class="form-row">平台<span class="brand-select"><span id="platform-symbol"></span><select id="platform">' +
      Object.keys(platforms)
        .map(
          (p) =>
            '<option value="' +
            p +
            '" ' +
            (platform === p ? 'selected' : '') +
            '>' +
            platforms[p] +
            '</option>'
        )
        .join('') +
      '</select></span></label><button type="button" id="platform-login" class="outline">通过官方窗口登录</button><label class="form-row">本机备注<input id="a-name" maxlength="64" required autocomplete="off" placeholder="账号名称或备注"></label><label class="form-row"><span id="identity-label"></span><input id="identity" required autocomplete="off"></label><label id="mode-row" class="form-row">发布方式<select id="mode"><option value="web">官方网页</option><option value="api">官方 API 直发</option></select></label><div id="credentials"></div><p class="message" id="modal-error" role="alert"></p><div class="modal-foot"><button class="primary" type="submit">保存账号</button></div></form>'
  )
  function fields(reset = false) {
    const p = $('platform').value
    $('platform-symbol').innerHTML = badge(p)
    $('platform-login').hidden = !catalog[p]?.login
    $('platform-login').onclick = async () => {
      try {
        await (p === 'douyin' ? api['new-douyin']() : api['new-creator'](p))
        dialog.close()
      } catch (e) {
        $('modal-error').textContent = e.message
      }
    }
    if (reset) {
      $('identity').value = ''
      $('mode').value = 'web'
    }
    $('identity-label').textContent = catalog[p].hint
    $('identity').placeholder =
      {
        x: '@username',
        xiaobot: 'https://xiaobot.net/p/专栏ID',
        weibo: '个人主页中的数字'
      }[p] || catalog[p].hint
    $('mode-row').hidden = p !== 'x'
    $('credentials').innerHTML =
      p === 'x' && $('mode').value === 'api'
        ? Object.entries({
            appKey: 'API Key',
            appSecret: 'API Key Secret',
            accessToken: 'Access Token',
            accessSecret: 'Access Token Secret'
          })
            .map(
              ([k, l]) =>
                '<label class="form-row">' +
                l +
                '<input type="password" id="' +
                k +
                '" required autocomplete="new-password"></label>'
            )
            .join('')
        : ''
  }
  fields()
  $('platform').onchange = () => fields(true)
  $('mode').onchange = () => fields()
  $('account-form').onsubmit = async (ev) => {
    ev.preventDefault()
    const submit = ev.submitter
    if (submit.disabled) return
    submit.disabled = true
    $('modal-error').textContent = ''
    try {
      const keys = Object.fromEntries(
        ['appKey', 'appSecret', 'accessToken', 'accessSecret'].map((k) => [k, $(k)?.value])
      )
      const a = await api['add-account']({
        platform: $('platform').value,
        name: $('a-name').value,
        identity: $('identity').value,
        mode: $('mode').value,
        keys
      })
      const selected = localValues().targets
      await sync()
      renderTargets(['write', 'video'].includes(screen) ? [...selected, a.id] : selected)
      if (['write', 'video'].includes(screen)) dirty()
      dialog.close()
      toast('账号已保存')
    } catch (e) {
      $('modal-error').textContent = e.message
    } finally {
      submit.disabled = false
    }
  }
}
function details(id) {
  const j = data.jobs.find((row) => row.id === id),
    a = accountById(j.accountId)
  const canRecord = ['waiting', 'uncertain'].includes(j.status)
  const actions = [
    button('复制正文', 'copy', id),
    ...(j.title ? [button('复制标题', 'copy-title', id)] : [])
  ]
  JSON.parse(j.assets).forEach((a, i) =>
    actions.push(button('复制图 ' + (i + 1), 'copy-img', id + '|' + a))
  )
  if (j.status === 'waiting') actions.push(button(j.videoId ? '一键带入平台' : '打开编辑器', 'open', id))
  if (j.videoId) {
    if (j.status === 'waiting') actions.push(button('仅打开后台', 'open-only', id))
    actions.push(button('复制整份文案', 'copy-video-copy', id), button('打开封面文件夹', 'video-materials', id))
  }
  if (data.manualMarks?.includes(id)) actions.push(deskButton('退回待处理', 'undo-manual', id))
  if (j.videoId) actions.push(button('复制视频路径', 'video-path', id))
  if (j.status === 'failed') actions.push(button('重试', 'retry', id))
  if (['waiting', 'queued', 'failed'].includes(j.status))
    actions.push(button('取消任务', 'cancel', id))
  if (j.status === 'uncertain') actions.push(button('已核对未发布', 'missing', id))
  modal(
    states[j.status],
    '<p class="meta">' +
      escape(platforms[a.platform] + ' · ' + a.name + ' · ' + a.identity + ' · ' + fmtDate(j.due)) +
      '</p><div class="preview">' +
      escape([j.title, j.body, ...JSON.parse(j.videoTags || '[]').map(tag => '#' + tag)].filter(Boolean).join('\n\n')) +
      '</div><p class="hint">' +
      escape(j.note) +
      '</p><div class="actions">' +
      actions.join('') +
      '</div>' +
      (catalog[a.platform]?.syncWorks && canRecord
        ? button('选择本人作品', 'choose-work', id) +
          (data.candidates?.some((c) => c.jobId === id)
            ? button('核对本窗口回执', 'candidate', id)
            : '')
        : '') +
      (canRecord
        ? '<form id="record-form"><label class="form-row">已发表的作品链接<input type="url" id="receipt" required placeholder="https://…"></label><p class="hint">登记为本人确认发表。</p><div class="modal-foot"><button class="primary" type="submit">登记链接</button></div></form>'
        : '') +
      '<p class="message" id="modal-error" role="alert"></p>'
  )
  if (canRecord)
    $('record-form').onsubmit = async (ev) => {
      ev.preventDefault()
      try {
        await api.record(id, $('receipt').value)
        await sync()
        dialog.close()
        toast('已登记作品链接')
      } catch (e) {
        $('modal-error').textContent = e.message
      }
    }
}
async function showNasExport() {
  const s = await api['nas-export-status']()
  const auto = await api['auto-sample-status']()
  const name = (r) => (platforms[r.platform] || r.platform) + ' · ' + r.name
  const autoHtml =
    '<h3>自动采样</h3><p class="hint">发条开着时，按作品发布后 1 小时、24 小时、3 天、7 天、30 天去各账号官方后台读一次指标；30 天内的作品每天至少读一次。每次只读一个账号，同一账号至少间隔 30 分钟，读取失败的账号 2 小时后再试。</p>' +
    '<p class="meta">状态：' + (auto.enabled ? '已开启' : '已关闭') + '</p>' +
    (auto.recent.length
      ? '<p class="meta">' + auto.recent.map((r) => escape(fmtDate(r.time) + ' ' + name(r) + '：' + (r.ok ? r.message || '成功' : '失败，' + r.message))).join('<br>') + '</p>'
      : '') +
    button(auto.enabled ? '关闭自动采样' : '开启自动采样', 'auto-sample-toggle', auto.enabled ? 'off' : 'on')
  modal(
    '自动采样与导出到 NAS',
    autoHtml +
    '<h3>导出到 NAS</h3><p class="hint">把账号、作品、指标和发布状态导出成只读快照，供 NAS 上的 Agent 读数据、写复盘。不导出登录态、密钥和稿件正文。设置目录后，有新数据时每 10 分钟自动导出一次，关闭程序前也会导出。</p>' +
      '<p class="meta">导出目录：' + escape(s.dir || '未设置') + '</p>' +
      (s.lastExport
        ? '<p class="meta">上次导出：' + fmtDate(s.lastExport) +
          (s.counts ? ' · ' + s.counts.works + ' 条作品、' + s.counts.metrics + ' 条指标' +
            (s.counts.works_with_quality_flags ? '，' + s.counts.works_with_quality_flags + ' 条带质量标记' : '') : '') + '</p>'
        : '') +
      (s.lastError ? '<p class="message">上次导出失败：' + escape(s.lastError.replace(/^\d+ /, '')) + '</p>' : '') +
      '<p class="hint">建议选 NAS 上 Obsidian 仓库之外的文件夹，例如 \\\\DXP4800PLUS-JY\\Obsidian\\_发条数据。</p>' +
      '<div class="modal-foot">' +
      button(s.dir ? '更换目录' : '选择目录', 'nas-export-bind') +
      (s.dir ? button('立即导出', 'nas-export-run', '', 'primary') : '') +
      '</div>'
  )
}
function confirmAction(title, body, label, fn) {
  modal(
    title,
    '<p>' +
      escape(body) +
      '</p><p class="message" id="modal-error"></p><div class="modal-foot">' +
      button('返回', 'close') +
      '<button id="confirm" class="primary">' +
      escape(label) +
      '</button></div>'
  )
  $('confirm').onclick = async (ev) => {
    ev.target.disabled = true
    try {
      await fn()
      await sync()
      dialog.close()
    } catch (e) {
      $('modal-error').textContent = e.message
      ev.target.disabled = false
    }
  }
}
function timing(next) {
  timed = next
  $('due').hidden = !next
  $('schedule-note').hidden = !next
  $('now').classList.toggle('selected', !next)
  $('later').classList.toggle('selected', next)
  if (next && !$('due').value) {
    const date = new Date(Date.now() + 3600000)
    $('due').value = new Date(date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  }
  updateControls()
}
async function enqueue(prepare = false) {
  if (makingCovers) throw Error('封面正在保存，请稍候再带入')
  if (!(await precheckGate())) return
  await save()
  const due = timed ? new Date($('due').value).getTime() : null
  if (timed && (!Number.isFinite(due) || due <= Date.now())) throw Error('请选择未来的排期时间')
  const ids = await api.queue(draft.id, draft.revision, due, prepare)
  await sync()
  const statuses = ids.map((id) => data.jobs.find((j) => j.id === id)?.status)
  filter = statuses.every((s) => groups.done.includes(s))
    ? 'done'
    : statuses.some((s) => groups.attention.includes(s))
      ? 'attention'
      : 'pending'
  screen = 'queue'
  renderScreen()
  toast(prepare ? '同步中心已打开，按账号查看进度' : '已定位 ' + ids.length + ' 项发布任务')
}
async function dispatch(action, id) {
  if (dialog.open && ['profile-mode','account-open','tab-command'].includes(action)) dialog.close()
  if (action === 'select-clip') { selectVideo(id); return }
  if (await visualAction(action, id)) return
  switch (action) {
    case 'new':
      await save()
      screen = screen === 'video' ? 'video' : 'write'
      timing(false)
      setDraft(blank(screen === 'video' ? 'video' : 'article'))
      renderScreen()
      $('title').focus()
      break
    case 'draft':
      await save()
      await sync()
      screen = data.drafts.find((d) => d.id === id)?.kind === 'video' ? 'video' : 'write'
      timing(false)
      setDraft(data.drafts.find((d) => d.id === id))
      renderScreen()
      if (dialog.open) dialog.close()
      break
    case 'drafts':
      await showMobileSources()
      break
    case 'draft-list-only':
      modal(
        '草稿',
        data.drafts.map((d) => button(displayName(d), 'draft', d.id)).join('') || '<p>尚无草稿</p>'
      )
      break
    case 'import': {
      await save()
      const item = await api.import()
      if (!item) break
      await sync()
      setDraft(blank())
      screen = 'write'
      imageIds = item.assets
      renderImages()
      $('title').value = item.title
      $('body').value = item.body
      dirty()
      await save()
      renderScreen()
      break
    }
    case 'add':
      showAccount(id || (screen === 'video' ? 'douyin' : 'x'))
      break
    case 'videos':
      await importVideoSelection(() => api['pick-videos']())
      break
    case 'remove-video':
      videoIds = videoIds.filter((x) => x !== id)
      renderVideoList()
      dirty()
      break
    case 'video-path':
      await api['video-path'](id)
      toast('视频路径已复制')
      break
    case 'data-refresh':
      await refreshAnalytics()
      break
    case 'new-douyin':
      await api['new-douyin']()
      break
    case 'format': {
      await save()
      const kind = id === 'video' ? 'video' : 'article'
      if (!draft.id) setDraft(blank(kind))
      else {
        const next = await api['creative-variant'](draft.id, kind)
        await sync()
        setDraft(next)
      }
      screen = kind === 'video' ? 'video' : 'write'
      renderScreen()
      break
    }
    case 'project-info':
      await save()
      if (!draft.id) {
        toast('先写入标题、正文或添加素材')
        break
      }
      await projectInfo()
      break
    case 'version-save':
      await save()
      await saveProjectNotes()
      await api['version-save'](draft.id)
      await projectInfo()
      break
    case 'version-restore': {
      await saveProjectNotes()
      const next = await api['version-restore'](draft.id, Number(id), draft.revision)
      await sync()
      setDraft(next)
      dialog.close()
      renderScreen()
      toast('已恢复，原版本仍保留')
      break
    }
    case 'lookup-work': {
      modal(
        '读取本人作品',
        '<form id="lookup-form"><label class="form-row">作品链接<input id="lookup-url" type="url" required></label><button class="primary">读取</button><p id="lookup-error" class="message"></p></form>'
      )
      $('lookup-form').onsubmit = async (e) => {
        e.preventDefault()
        try {
          const w = await api['lookup-work'](id, $('lookup-url').value)
          await refreshAnalytics()
          await nativeDetail(w.id)
        } catch (error) {
          $('lookup-error').textContent = error.message
        }
      }
      break
    }
    case 'work-report': {
      const n = await api['work-report'](id)
      if (n !== null) {
        await refreshAnalytics()
        toast('已读取 ' + n + ' 行作品指标')
      }
      break
    }
    case 'native-sync':
    case 'native-next': {
      const out = await api['sync-works'](id, action === 'native-next' ? workCursors.get(id) : '0')
      workCursors.set(id, out.next)
      await sync()
      await refreshAnalytics()
      if (dialog.open && $('work-source-account')) workSources(id)
      toast('已核对 ' + out.count + ' 条作品')
      break
    }
    case 'native-detail':
      await nativeDetail(id)
      break
    case 'native-refresh':
      try {
        await api['work-refresh'](id)
        await refreshAnalytics()
        await nativeDetail(id)
      } catch (e) {
        if ($('native-error')) $('native-error').textContent = e.message
        else throw e
      }
      break
    case 'nas-export':
      await showNasExport()
      break
    case 'nas-export-bind':
      if (await api['nas-export-bind']()) toast('已选择目录并完成导出')
      await showNasExport()
      break
    case 'auto-sample-toggle':
      await api['auto-sample-toggle'](id === 'on')
      await showNasExport()
      break
    case 'nas-export-run':
      await api['nas-export-run']()
      toast('已导出最新数据')
      await showNasExport()
      break
    case 'history-menu':
      modal(
        '导入资料',
        button('易媒报表 CSV', 'report-import') +
          button('账号快照数据库', 'history-import', 'creator') +
          button('观看与收藏归档', 'history-import', 'review')
      )
      break
    case 'history-import':
      if (await api['history-import'](id)) {
        await refreshAnalytics()
        toast('历史资料已迁入本机')
      }
      dialog.close()
      break
    case 'data-tab':
      dataTab = id
      sourceFilter = ''
      pageIndex = 0
      renderAnalytics()
      break
    case 'data-page':
      pageIndex += Number(id)
      renderAnalytics()
      break
    case 'report-import': {
      if (dialog.open) dialog.close()
      const count = await api['report-import']()
      if (count !== null) {
        await sync()
        await refreshAnalytics()
        toast('已读取 ' + count + ' 行')
      }
      break
    }
    case 'account-meta': {
      const a = accountById(id)
      modal(
        '账号设置',
        '<form id="meta-form"><label class="form-row">名称<input id="edit-name" required maxlength="64" value="' +
          escape(a.name) +
          '"></label><label class="form-row">分组<input id="edit-group" maxlength="40" value="' +
          escape(a.groupName) +
          '"></label><button class="primary">保存</button></form>' +
          button(a.archived === 2 ? '重试清理' : '移除账号', 'archive', a.id, 'plain')
      )
      $('meta-form').onsubmit = async (e) => {
        e.preventDefault()
        try {
          await api['account-meta'](id, $('edit-name').value, $('edit-group').value)
          await sync()
          dialog.close()
        } catch (err) {
          toast(err.message)
        }
      }
      break
    }
    case 'projects':
      await save()
      await showProjects()
      break
    case 'easel-export':
      await save()
      await saveProjectNotes()
      if (draft.id && (await api['easel-export'](draft.id))) toast('作品项目已导出')
      break
    case 'easel-item': {
      await save()
      const d = await api['easel-import'](...JSON.parse(id))
      await sync()
      setDraft(d)
      screen = d.kind === 'video' ? 'video' : 'write'
      renderScreen()
      dialog.close()
      break
    }
    case 'images': {
      const ids = await api['pick-images']()
      if (!ids.length) break
      const combined = [...new Set([...imageIds, ...ids])]
      if (combined.length > 64) throw Error('单稿最多 64 张配图')
      await sync()
      imageIds = combined
      renderImages()
      dirty()
      break
    }
    case 'remove-image':
      imageIds = imageIds.filter((x) => x !== id)
      renderImages()
      dirty()
      break
    case 'copy-img':
      await api['copy-image'](...id.split('|'))
      toast('配图已复制')
      break
    case 'to-write':
      await navigate('write')
      break
    case 'archive':
      confirmAction('移除账号', '移除本机登录会话，保留草稿和历史记录。', '移除', async () => {
        await api.archive(id)
      })
      break
    case 'login':
      await api.login(id)
      break
    case 'filter':
      filter = id
      renderQueue()
      break
    case 'reconcile-queue':
      void checkPublicationStatus(true)
      break
    case 'choose-work': {
      const job = data.jobs.find((j) => j.id === id)
      await api['sync-works'](job.accountId, '0')
      await refreshAnalytics()
      const items = analyticsData.native.filter(
        (w) => w.accountId === job.accountId && (!w.jobId || w.jobId === id)
      )
      modal(
        '选择本任务在' +
          platforms[data.accounts.find((a) => a.id === job.accountId).platform] +
          '发表的作品',
        items
          .map((w) => button(w.title || w.itemId, 'confirm-link', JSON.stringify([id, w.itemId])))
          .join('') || '<p>此账号尚未返回作品，请稍后再试。</p>'
      )
      break
    }
    case 'candidate': {
      const c = data.candidates.find((c) => c.jobId === id)
      if (c) await dispatch('confirm-link', JSON.stringify([id, c.itemId]))
      break
    }
    case 'confirm-link': {
      const [job, item] = JSON.parse(id)
      confirmAction(
        '核对作品关联',
        '将平台作品 ' + item + ' 关联到此发布任务。确认它对应本稿和所选素材。',
        '核对并关联',
        async () => {
          await api['sync-job-work'](job, item)
          await refreshAnalytics()
        }
      )
      break
    }
    case 'detail':
      details(id)
      break
    case 'open':
    case 'open-only':
      await api['open-job'](id, action === 'open')
      if (dialog.open) dialog.close()
      break
    case 'copy-video-copy':
    case 'video-materials':
      await api[action](id)
      if (action === 'copy-video-copy') toast('已复制标题、正文和话题')
      break
    case 'visit':
      await api.visit(id)
      break
    case 'copy':
    case 'copy-title':
      await api.copy(id, action === 'copy' ? 'body' : 'title')
      toast('已复制')
      break
    case 'retry':
      await api.retry(id)
      await sync()
      dialog.close()
      break
    case 'cancel':
      confirmAction(
        '取消发布任务',
        '本机队列将结束此任务，请另行核对已经打开的官方编辑器。',
        '取消任务',
        () => api.cancel(id)
      )
      break
    case 'missing':
      confirmAction(
        '核对发送结果',
        '请确认目标账号未发表。CreatorHub 任务还须核对原工具队列，确认没有待发或执行中的同一稿件。',
        '确认未发布',
        () => api['resolve-missing'](id)
      )
      break
    case 'close':
      dialog.close()
      break
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b || (b.type === 'submit' && b.closest('form')) || actionBusy) return
  if (!b.dataset.action && !b.dataset.nav && !['enqueue', 'sync-video', 'now', 'later'].includes(b.id)) return
  actionBusy = true
  try {
    if (b.dataset.nav) await navigate(b.dataset.nav)
    else if (b.id === 'enqueue') await enqueue()
    else if (b.id === 'sync-video') await enqueue(true)
    else if (b.id === 'now' || b.id === 'later') timing(b.id === 'later')
    else await dispatch(b.dataset.action, b.dataset.id)
  } catch (err) {
    toast(err.message)
  } finally {
    actionBusy = false
  }
})
dialog.addEventListener('close', () => {
  $('dialog-inner').replaceChildren()
  modalOrigin?.focus()
})
const dropZone = $('video-drop')
$('cover-idea').oninput = () => {
  artNote = $('cover-idea').value
  localStorage.setItem('series-cover-idea', artNote)
  dirty()
}
$('cover-layout').onchange = () => localStorage.setItem('series-cover-layout', $('cover-layout').value)
$('targets').addEventListener('change', () => { if (screen === 'video') showSelectedCover() })
function loadVariant() {
  const v = variants[$('variant-platform').value]
  $('variant-title').value = v?.title || ''
  $('variant-body').value = v?.body || ''
  $('variant-tags').value = v?.tags || ''
  $('variant-cover').value = v?.cover || ''
}
$('variant-platform').onchange = loadVariant
for (const id of ['variant-title', 'variant-body', 'variant-tags', 'variant-cover'])
  $(id).oninput = () => {
    const p = $('variant-platform').value
    if (!p) return
    const value = { title: $('variant-title').value, body: $('variant-body').value }
    if (draft.kind === 'video' && $('variant-tags').value) value.tags = $('variant-tags').value
    if (draft.kind === 'video' && $('variant-cover').value) value.cover = $('variant-cover').value
    if (Object.values(value).some(Boolean)) variants[p] = value
    else delete variants[p]
    if (id === 'variant-cover') showSelectedCover()
    dirty()
  }
$('account-search').oninput = renderAccounts
$('account-group').onchange = renderAccounts
$('account-platform').onchange = renderAccounts
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropZone.classList.add('dragging')
})
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'))
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault()
  dropZone.classList.remove('dragging')
  if (actionBusy) return
  actionBusy = true
  const files = [...e.dataTransfer.files]
  try {
    await importVideoSelection(() => api.dropVideos(files))
  } catch (error) {
    toast(error.message)
  } finally {
    actionBusy = false
  }
})
for (const id of ['body', 'title', 'x-text', 'targets', 'video-tags']) $(id).addEventListener('input', dirty)
for (const id of ['body', 'title', 'x-text'])
  $(id).addEventListener('paste', (event) => {
    const field = event.target,
      pasted = event.clipboardData?.getData('text/plain') || ''
    if (
      field.value.length - (field.selectionEnd - field.selectionStart) + pasted.length >
      field.maxLength
    ) {
      event.preventDefault()
      toast('此栏最多 ' + field.maxLength + ' 个字符，已保留原稿，请缩短后粘贴。')
    }
  })
api.onQueue(() => sync().catch((e) => toast(e.message)))
api.onWorks(() => {
  dataTab = 'native'
  navigate('data').catch((e) => toast(e.message))
})
api.onJob((id) =>
  navigate('queue')
    .then(() => details(id))
    .catch((e) => toast(e.message))
)
api.onClose(() =>
  save()
    .then(() => api.closed())
    .catch((e) => toast('草稿未保存：' + e.message))
)
sync()
  .then(() => {
    setDraft(data.drafts[0] || blank())
    renderScreen()
    return refreshAnalytics()
  })
  .catch((e) => toast(e.message))
