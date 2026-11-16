'use strict'
let editorCovers = {},
  editorFormats = {},
  artNote = '',
  selectedClip = '',
  pickedKind =
    ['vault','postvela'].includes(localStorage.getItem('desk-source')) ? localStorage.getItem('desk-source') : 'local'
let composerTab = 'pub',
  assistField = '标题',
  assistReader = '第一次接触这个主题的读者',
  assistGoal = '帮读者做选择'
let suggestion = null,
  lastEdit = null,
  generating = false,
  sourceSeq = 0,
  aiSeq = 0,
  coverSeq = 0,
  sourceBusy = false,
  makingCovers = false
let coverOwner = 0, artPending = false
const candidateKey = (draftId,clip) => 'cover-candidate/' + draftId + '/' + clip
function currentCandidate() {
  try { return JSON.parse(localStorage.getItem(candidateKey(draft.id,selectedClip))) } catch { return null }
}
const sourceNames = {
  local: '图文工作台',
  vault: 'Obsidian 主稿',
  postvela: 'PostVela 图集',
  video: '视频目录'
}
const mediaUrl = (type, id) => 'studio-media://' + type + '/' + id
function resetAssist() {
  suggestion = null
  lastEdit = null
  aiSeq++
  generating = false
}
function sourceKind() {
  return screen === 'video' ? 'video' : pickedKind
}
async function loadSources() {
  const root = $('source-library'),
    kind = sourceKind(),
    seq = ++sourceSeq
  const links =
    screen === 'video'
      ? ''
      : Object.entries(sourceNames)
          .filter(([k]) => k !== 'video')
          .map(([k, l]) => selectorButton(l, 'source-kind', k, pickedKind))
          .join('')
  root.innerHTML =
    '<div class="section-row"><h2>' +
    (screen === 'video' ? '视频目录' : '稿件库') +
    '</h2>' +
    deskButton('绑定', 'bind-source') +
    '</div><div class="source-links">' +
    links +
    '</div><div id="source-items"><small>正在读取目录…</small></div>'
  try {
    const { root: path, items } = await api['source-list'](kind)
    if (seq !== sourceSeq || kind !== sourceKind()) return
    $('source-items').innerHTML =
      '<small title="' +
      escape(path) +
      '">' +
      escape(path || '尚未绑定目录') +
      '</small>' +
      items
        .map(
          (i) =>
            deskButton(i.label, 'load-source', i.key, 'source-item') +
            (i.draftId && i.draftId === draft.id
              ? deskButton('从磁盘载入新版草稿', 'fresh-source', i.key, 'plain')
              : '')
        )
        .join('') +
      (items.length ? '' : '<small>暂无可加载的稿件</small>')
  } catch (e) {
    if (seq === sourceSeq)
      $('source-items').innerHTML = '<small>' + escape(e.message) + '</small>'
  }
}
async function openSource(key, fresh) {
  if (sourceBusy) return
  sourceBusy = true
  const kind = sourceKind(),
    originalScreen = screen
  try {
    if(kind==='postvela') {
      const pack=await api['postvela-open'](key)
      if(screen!==originalScreen || sourceKind()!==kind)return
      showPostvela(pack)
      return
    }
    await save()
    const d = await api['source-load'](kind, key, !!fresh)
    if (screen !== originalScreen || sourceKind() !== kind) return
    await save()
    await sync()
    setDraft(d)
    renderScreen()
    if (dialog.open) dialog.close()
    toast('已打开工作台草稿')
  } finally {
    sourceBusy = false
  }
}
async function showMobileSources() {
  modal('稿件库', '<div id="mobile-sources"></div>')
  const kind = sourceKind(),
    el = $('mobile-sources')
  const bar =
    (screen === 'video'
      ? ''
      : ['local', 'vault', 'postvela']
          .map((k) =>
            selectorButton(sourceNames[k], 'mobile-source', k, pickedKind)
          )
          .join('')) + deskButton('绑定目录', 'mobile-bind')
  el.innerHTML = bar + '<p>正在读取目录…</p>'
  let files = ''
  try {
    const source = await api['source-list'](kind)
    files = source.items
      .map((i) => deskButton(i.label, 'load-source', i.key, 'source-item'))
      .join('')
  } catch (e) {
    files = '<small>' + escape(e.message) + '</small>'
  }
  el.innerHTML =
    bar +
    files +
    '<h3>本机草稿</h3>' +
    data.drafts
      .filter(
        (d) =>
          (d.kind || 'article') === (screen === 'video' ? 'video' : 'article')
      )
      .map((d) => button(displayName(d), 'draft', d.id))
      .join('')
}
function showPostvela(pack) {
  const live=pack.pages.filter(p=>p.kind==='live').length
  const gif=pack.pages.filter(p=>p.kind==='gif').length
  modal('PostVela 图集 · '+pack.pages.length+' 页',
    '<div class="postvela-pack"><p>'+live+' 页 Live · '+gif+' 页 GIF · '+(pack.pages.length-live-gif)+' 页静态图</p>'+
    '<h3>'+escape(pack.title)+'</h3>'+
    '<div class="postvela-import">'+deskButton(pack.draftId?'打开已导入的图文稿':'导入为图文稿，去发布','postvela-import',pack.key,'primary')+
      (pack.draftId?deskButton('从图集重新导入','postvela-reimport',pack.key,'outline'):'')+
      '<small>按页序导入全部 '+pack.pages.length+' 张图'+(live+gif?'，其中 '+(live+gif)+' 页 '+(live&&gif?'Live / GIF':live?'Live':'GIF')+' 使用静态备用图（网页端不支持动态，保留动态请用手机 App）':'')+'。导入后勾选账号即可加入发布队列。</small></div>'+
    '<div class="postvela-actions">'+deskButton('复制标题','postvela-title',pack.id)+deskButton('复制正文','postvela-body',pack.id)+deskButton('打开素材文件夹','postvela-folder',pack.id)+'</div>'+
    '<p>Live 请从手机 App 发布：先确认相册的 LIVE 标记及长按播放。每页只选一份，动态页不要选备用 PNG。</p>'+
    '<details><summary>查看发布文案</summary><p class="postvela-copy">'+escape(pack.body)+'</p></details>'+
    '<details><summary>三平台发布说明</summary><p>小红书网页不支持 GIF / Live；抖音网页不支持 GIF，Live 网页上传待核实。公众号长文请在 PostVela 公众号预览中同步原 GIF。</p><p class="hint">本页仅核对本地文件。手机相册识别、平台预览与正式发布仍需分别验收。</p><p class="hint">'+escape(pack.folder)+'</p></details>'+
    '<div class="postvela-pages">'+pack.pages.map(p=>'<figure><figcaption>第 '+p.number+' 页 · '+({live:'Live',gif:'GIF',static:'静态图'}[p.kind])+'</figcaption>'+
      (p.kind==='live'?'<video controls muted loop playsinline preload="metadata" poster="'+mediaUrl('image',p.image)+'" src="'+mediaUrl('video',p.preview)+'"></video>':
        '<img loading="lazy" alt="第 '+p.number+' 页" src="'+(p.kind==='gif'?p.preview:mediaUrl('image',p.image))+'">')+'</figure>').join('')+'</div></div>')
}
function showComposer() {
  const video = screen === 'video'
  $('video-tag-field').hidden = !video
  $('body-label').textContent = video ? '简介' : '正文'
  $('article-art').hidden = video
  $('art-host').append($('images'))
  renderImages()
  updateVideoPreview()
  renderAssistPane()
  void loadSources()
}
function selectVideo(id) {
  if (!videoIds.includes(id)) return
  selectedClip = id
  updateVideoPreview()
  renderAssistPane()
}
function updateVideoPreview() {
  const video = $('clip-player')
  if (!videoIds.includes(selectedClip)) selectedClip = videoIds[0] || ''
  const visible = !!selectedClip && screen === 'video'
  $('video-preview').hidden = !visible
  if (!visible) {
    if (video.hasAttribute('src')) {
      video.removeAttribute('src')
      video.load()
    }
    return
  }
  const url = mediaUrl('video', selectedClip)
  if (video.getAttribute('src') !== url) {
    video.src = url
    coverSeq++
    $('cover-frames').replaceChildren()
  }
  const cover = editorCovers[selectedClip]
  if (cover) video.poster = mediaUrl('image', cover)
  else video.removeAttribute('poster')
  showSelectedCover()
}
function showSelectedCover() {
  const formats = editorFormats[selectedClip] || {}
  document.querySelector('[data-desk=apply-pending-covers]').hidden = !Object.keys(formats).some(key => key !== 'wide' && key !== 'portrait') ||
    !data.jobs.some(j => j.draftId === draft.id && j.videoId === selectedClip && ['waiting','queued'].includes(j.status))
  const targets = [...$('targets').querySelectorAll('input:checked')].map(el => accountById(el.value)?.platform)
  const slots = Object.entries(catalog).filter(([p, spec]) => spec.coverSlots && (!targets.length || targets.includes(p)))
  const caption = key => slots.filter(([platform,spec]) => {
    const preferred = variants[platform]?.cover
    return preferred && !spec.coverSlots[preferred] ? key === preferred : Object.values(spec.coverSlots).includes(key)
  }).map(([,spec]) => spec.label).join(' · ')
  const entries = Object.entries(data.coverSizes || {}).filter(([key]) => caption(key) || (!slots.length && formats[key]))
  $('cover-formats').innerHTML = entries.map(([key, {label,width,height}]) =>
    '<div class="cover-slot">' + (formats[key] ? '<button class="cover-thumb" data-desk="preview-format" data-key="' +
      key + '" aria-label="预览' + label + '"><img alt="' + label + '封面" src="' + mediaUrl('image', formats[key]) +
      '"></button>' : '<div class="cover-thumb">' + icon('film') + '</div>') +
    '<div><b>' + label + '</b><small>' + width + ' × ' + height + (formats[key] ? '' : ' · 待生成') +
    '</small><small>' + caption(key) + '</small>' + deskButton('单独导入', 'import-format', key) + '</div></div>').join('')
  for (const image of $('cover-formats').querySelectorAll('img')) {
    image.onload = () => {
      image.closest('.cover-slot').querySelector('small').textContent = image.naturalWidth + ' × ' + image.naturalHeight
    }
  }
  const root = $('cover-frames')
  root.querySelector('.active-cover')?.remove()
  const id = editorCovers[selectedClip]
  const candidate = currentCandidate()
  $('cover-candidate').hidden = !candidate
  if (candidate) {
    $('cover-candidate').querySelector('img').src = mediaUrl('image', candidate.id)
    $('cover-candidate').querySelector('button').textContent = candidate.format ? '采用到' + data.coverSizes[candidate.format].label : '采用这张底图'
  }
  document.querySelector('[data-desk=generate-art]').disabled = artPending
  if (id)
    root.insertAdjacentHTML(
      'afterbegin',
      '<span class="active-cover"><img src="' +
        mediaUrl('image', id) +
        '" alt="当前底图"><small>当前底图</small></span>'
    )
}
function frameData(v, maxSide = 1920) {
  if (!v.videoWidth || v.readyState < 2)
    throw Error('请先播放视频，停在要选的画面')
  const canvas = document.createElement('canvas'),
    scale = Math.min(1, maxSide / v.videoWidth, maxSide / v.videoHeight)
  canvas.width = Math.round(v.videoWidth * scale)
  canvas.height = Math.round(v.videoHeight * scale)
  canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.88)
}
function waitFrame(v, event, action) {
  return new Promise((resolve, reject) => {
    const finish = (err) => {
      clearTimeout(timer)
      v.removeEventListener(event, ok)
      v.removeEventListener('error', bad)
      err ? reject(err) : resolve()
    }
    const ok = () => finish(),
      bad = () => finish(Error('浏览器无法读取视频画面'))
    const timer = setTimeout(bad, 5000)
    v.addEventListener(event, ok, { once: true })
    v.addEventListener('error', bad, { once: true })
    action()
  })
}
async function candidateFrames() {
  const main = $('clip-player'),
    src = main.getAttribute('src'),
    seq = ++coverSeq
  const v = document.createElement('video')
  v.crossOrigin = 'anonymous'
  v.muted = true
  try {
    await waitFrame(v, 'loadeddata', () => {
      v.src = src
    })
    if (!Number.isFinite(v.duration) || v.duration <= 0) return
    const buttons = []
    for (const fraction of [0.12, 0.39, 0.65, 0.86]) {
      if (seq !== coverSeq || main.getAttribute('src') !== src) return
      const time = v.duration * fraction
      await waitFrame(v, 'seeked', () => {
        v.currentTime = time
      })
      const raw = frameData(v),
        b = document.createElement('button')
      b.innerHTML =
        '<img alt="候选封面"><small>' + time.toFixed(1) + ' 秒</small>'
      b.querySelector('img').src = raw
      b.onclick = () => {
        main.pause()
        main.currentTime = time
        applyCover(raw).catch((e) => toast(e.message))
      }
      buttons.push(b)
    }
    if (seq === coverSeq && main.getAttribute('src') === src) {
      $('cover-frames').replaceChildren(...buttons)
      showSelectedCover()
    }
  } catch {
    /* The player and manual cover import remain available for unsupported codecs. */
  } finally {
    v.removeAttribute('src')
    v.load()
  }
}
async function applyCover(raw) {
  const clip = selectedClip, owner = coverOwner
  const id = raw
    ? await api['frame-cover'](raw)
    : (await api['pick-images']()).at(0)
  if (
    !id ||
    clip !== selectedClip ||
    owner !== coverOwner ||
    !videoIds.includes(clip)
  )
    return
  await makeCovers(null, id)
}
async function makeCovers(importKey, base) {
  if (makingCovers) throw Error('封面正在制作，请稍候')
  makingCovers = true
  try { await renderCoverSet(importKey, base) } finally { makingCovers = false }
}
async function renderCoverSet(importKey, base) {
  const clip = selectedClip, owner = coverOwner, keys = importKey ? [importKey] : Object.keys(data.coverSizes)
  if (!clip) throw Error('请先选择视频')
  const title = !importKey && $('cover-title').checked ? $('title').value.trim() : ''
  const cropped = $('cover-layout').value === 'fill'
  const image = new Image()
  image.crossOrigin = 'anonymous'
  let imported
  if (importKey) {
    const id = base || (await api['pick-images']())[0]
    if (!id) return
    imported = id
    image.src = mediaUrl('image', id)
  } else {
    base ||= editorCovers[clip] || await api['frame-cover'](frameData($('clip-player')))
    image.src = mediaUrl('image', base)
  }
  await image.decode()
  const formats = {}
  for (const key of keys) {
    const {width:w, height:h} = data.coverSizes[key]
    if (imported && image.naturalWidth === w && image.naturalHeight === h) {
      formats[key] = imported
      continue
    }
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    const iw = image.naturalWidth, ih = image.naturalHeight
    const fit = cropped ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih)
    const x = (w - iw * fit) / 2, y = (h - ih * fit) / 2
    ctx.fillStyle = '#181919'
    ctx.fillRect(0, 0, w, h)
    // Extend soft edge colors without repeating lettering or faces in the margins.
    if (y > 0.5 || x > 0.5) {
      const colors = document.createElement('canvas')
      colors.width = colors.height = 12
      colors.getContext('2d').drawImage(image,0,0,12,12)
      if (y > 0.5) {
        ctx.drawImage(colors,0,0,12,1,0,0,w,y+1)
        ctx.drawImage(colors,0,11,12,1,0,h-y-1,w,y+1)
      } else {
        ctx.drawImage(colors,0,0,1,12,0,0,x+1,h)
        ctx.drawImage(colors,11,0,1,12,w-x-1,0,x+1,h)
      }
    }
    ctx.drawImage(image,x,y,iw * fit,ih * fit)
    if (title) {
      const size = Math.round(w * 0.054), margin = Math.round(w * 0.065)
      ctx.font = 'bold ' + size + 'px "Microsoft YaHei", sans-serif'
      const lines = ['']
      for (const ch of title) {
        const i = lines.length - 1
        if (ctx.measureText(lines[i] + ch).width <= w - margin * 2) lines[i] += ch
        else if (lines.length < 3) lines.push(ch)
        else { lines[i] = Array.from(lines[i]).slice(0, -1).join('') + '…'; break }
      }
      const first = h - margin - (lines.length - 1) * size * 1.22
      const shade = ctx.createLinearGradient(0, first - size * 2, 0, h)
      shade.addColorStop(0, 'transparent')
      shade.addColorStop(1, 'rgba(0,0,0,.88)')
      ctx.fillStyle = shade
      ctx.fillRect(0, first - size * 2, w, h - first + size * 2)
      ctx.fillStyle = '#fff'
      lines.forEach((line, i) => ctx.fillText(line, margin, first + i * size * 1.22))
    }
    formats[key] = await api['frame-cover'](canvas.toDataURL('image/jpeg', 0.91))
  }
  if (!videoIds.includes(clip) || owner !== coverOwner) return
  if (base && !importKey) editorCovers[clip] = base
  editorFormats[clip] = { ...editorFormats[clip], ...formats }
  updateVideoPreview()
  dirty()
  await save()
  toast(importKey ? '已替换这个尺寸的封面' : '各平台封面已保存')
}
async function generateCoverArt(format) {
  if (artPending) return
  const clip = selectedClip, owner = coverOwner
  if (!clip) throw Error('请先选入视频')
  const idea = $('cover-idea').value.trim()
  artPending = true
  $('art-status').textContent = 'Codex 正在生图，通常需要几分钟…'
  showSelectedCover()
  try {
    await save()
    if (owner !== coverOwner || selectedClip !== clip) return
    const key = candidateKey(draft.id,clip)
    const id = await api['cover-art']({idea, format, title:$('title').value,
      image:editorCovers[clip] || editorFormats[clip]?.[format] || null})
    localStorage.setItem(key,JSON.stringify({id,format}))
    if (owner !== coverOwner || !videoIds.includes(clip)) return
    $('art-status').textContent = (data.coverSizes[format]?.label || '系列底图') + '候选已生成'
  } catch (error) {
    if (owner === coverOwner) $('art-status').textContent = error.message
  } finally {
    artPending = false
    showSelectedCover()
  }
}
function context() {
  const video = screen === 'video'
  return {
    kind: video ? '视频' : '图文',
    field: assistField,
    reader: assistReader,
    purpose: assistGoal,
    title: $('title').value,
    body: $('body').value,
    images: video
      ? editorCovers[selectedClip]
        ? [editorCovers[selectedClip]]
        : []
      : [...imageIds],
    platforms: localValues().targets.map(
      (id) => platforms[accountById(id).platform]
    ),
    video: video ? selectedClip : ''
  }
}
function contextStamp(c) {
  return JSON.stringify([
    draft.id,
    c.kind,
    c.field,
    c.reader,
    c.purpose,
    c.title,
    c.body,
    c.images,
    c.platforms,
    c.video
  ])
}
function localIssues(c) {
  const issues = []
  for (const [position, text] of [
    ['标题', c.title],
    ['正文', c.body]
  ]) {
    for (const [word, advice] of [
      ['保证见效', '核对承诺是否有依据，说明适用条件。'],
      ['稳赚', '核对收益承诺的依据。'],
      ['100%有效', '避免无依据的绝对效果承诺。'],
      ['扫码领取', '核对领取内容和目标平台的要求。'],
      ['私信我', '核对联系方式和领取流程是否必要。']
    ])
      if (text.includes(word)) issues.push({ position, quote: word, advice })
  }
  return issues
}
function checkKey(item) {
  return [draft.id || 'new', screen, item].join('|')
}
function readChecks() {
  try {
    return JSON.parse(localStorage.getItem('desk-media-checks')) || []
  } catch {
    return []
  }
}
function markChecked(item) {
  const id = checkKey(item)
  const keys = readChecks().filter((k) => k !== id)
  keys.push(id)
  localStorage.setItem('desk-media-checks', JSON.stringify(keys.slice(-600)))
}
function reviewChecklist(c) {
  const marks = readChecks()
  const pending = c.images.filter((id) => !marks.includes(checkKey(id)))
  let html = c.images.length
    ? deskButton(
        '查看图片 · ' + pending.length + ' 张待核对',
        'review-art',
        String(Math.max(0, c.images.indexOf(pending[0])))
      )
    : ''
  if (screen === 'video' && selectedClip) {
    for (const [k, n] of [
      ['picture', '画面与字幕'],
      ['audio', '原声与音乐授权']
    ]) {
      const key = selectedClip + '-' + k
      html +=
        '<div class="advice"><b>' +
        n +
        '</b><small>' +
        (marks.includes(checkKey(key)) ? '已人工核对' : '待人工核对') +
        '</small>' +
        deskButton('查看视频', 'review-video') +
        deskButton('标为已核对', 'mark-video', key) +
        '</div>'
    }
  }
  return html
}
function renderAssistPane() {
  $('assist-tabs').innerHTML = [
    ['ai', 'AI 优化'],
    ['risk', '风险检测'],
    ['pub', '发布设置']
  ]
    .map(([k, n]) => selectorButton(n, 'assist-tab', k, composerTab))
    .join('')
  $('pub-options').hidden = composerTab !== 'pub'
  $('assist-pane').hidden = composerTab === 'pub'
  if (composerTab === 'pub') return
  const c = context(),
    risk = composerTab === 'risk',
    r = suggestion,
    valid = r && r.stamp === contextStamp(c)
  const fields =
    screen === 'video' ? ['标题', '简介', '封面'] : ['标题', '正文', '配图']
  const issues = risk
    ? [...localIssues(c), ...(valid ? r.reply.issues : [])]
    : []
  $('assist-pane').innerHTML =
    '<div class="section-row"><h2>' +
    (risk ? '发布前复核' : '改稿助手') +
    '</h2><small>本机 Codex</small></div>' +
    (!risk
      ? '<div class="desk-switch">' +
        fields
          .map((k) => selectorButton(k, 'assist-field', k, assistField))
          .join('') +
        '</div><label class="form-row">写给谁<input id="assist-reader" maxlength="500" value="' +
        escape(assistReader) +
        '"></label><label class="form-row">修改目的<input id="assist-goal" maxlength="500" value="' +
        escape(assistGoal) +
        '"></label>'
      : '') +
    '<p class="hint">点击后，当前文案和最多 8 张配图会交给本机 Codex 使用的模型。' +
    (screen === 'video'
      ? '视频审核只包含文案和所选封面，画面和音轨需自行复核。'
      : '') +
    '</p>' +
    deskButton(
      generating ? '正在等待 Codex…' : risk ? 'AI 复核本稿' : '生成修改建议',
      'generate',
      '',
      'primary'
    ) +
    (risk
      ? issues.length
        ? issues
            .map(
              (x, i) =>
                '<article class="advice"><small>' +
                escape(x.position) +
                '</small><b>' +
                escape(x.quote) +
                '</b><p>' +
                escape(x.advice) +
                '</p>' +
                deskButton('定位原文或配图', 'locate', String(i)) +
                '</article>'
            )
            .join('')
        : '<p class="hint">' +
          (valid
            ? '本次 AI 复核未返回具体提示。'
            : '本地文字规则未命中提示，可继续核对配图与素材来源。') +
          '</p>'
      : '') +
    (!risk && valid
      ? '<article class="advice"><small>候选' +
        escape(c.field) +
        '</small><b>' +
        escape(r.reply.text) +
        '</b><p>' +
        escape(r.reply.reason) +
        '</p>' +
        deskButton('采纳建议', 'apply-advice') +
        '</article>'
      : '') +
    (risk ? reviewChecklist(c) : '') +
    (lastEdit ? deskButton('撤销采纳', 'undo-advice') : '') +
    deskButton('复制 Codex 交接任务', 'handoff') +
    (artNote
      ? '<div class="advice"><small>当前改图说明</small><p>' +
        escape(artNote) +
        '</p></div>'
      : '')
  $('assist-pane').querySelector('[data-desk=generate]').disabled = generating
}
async function askAI() {
  if (generating) return
  const c = context()
  if (!c.title.trim() && !c.body.trim() && !c.images.length)
    throw Error('先填写稿件或选择素材')
  const stamp = contextStamp(c),
    seq = ++aiSeq
  generating = true
  suggestion = null
  renderAssistPane()
  try {
    const reply = await api['author-assist'](c)
    if (seq !== aiSeq) return
    if (contextStamp(context()) === stamp) suggestion = { stamp, reply }
    else toast('稿件已变化，可针对当前版本重新生成')
  } finally {
    if (aiSeq === seq) {
      generating = false
      renderAssistPane()
    }
  }
}
function applyAdvice() {
  if (!suggestion || suggestion.stamp !== contextStamp(context()))
    throw Error('稿件已变化，请重新生成建议')
  const r = suggestion.reply,
    field = assistField
  if (field === '标题' || field === '正文' || field === '简介') {
    const el = $(field === '标题' ? 'title' : 'body')
    if (!r.text.trim() || r.text.length > el.maxLength)
      throw Error('候选文案为空或超过字数上限')
    lastEdit = { id: el.id, before: el.value, after: r.text }
    el.value = r.text
  } else {
    const before = [...imageIds],
      old = artNote
    if (
      field === '配图' &&
      r.order.length === before.length &&
      new Set(r.order).size === before.length &&
      r.order.every((n) => Number.isInteger(n) && n > 0 && n <= before.length)
    )
      imageIds = r.order.map((n) => before[n - 1])
    artNote = r.text.slice(0, 8000)
    if (field === '封面') $('cover-idea').value = artNote.slice(0,4000)
    lastEdit = { before, after: [...imageIds], note: old, endNote: artNote }
    renderImages()
  }
  suggestion = null
  dirty()
  renderAssistPane()
  toast('已采纳到当前稿件')
}
function undoAdvice() {
  if (!lastEdit) return
  if (lastEdit.id) {
    const el = $(lastEdit.id)
    if (el.value !== lastEdit.after)
      throw Error('该字段已再次编辑，请核对当前内容')
    el.value = lastEdit.before
  } else {
    if (
      JSON.stringify(imageIds) !== JSON.stringify(lastEdit.after) ||
      artNote !== lastEdit.endNote
    )
      throw Error('素材已变化')
    imageIds = lastEdit.before
    artNote = lastEdit.note
    renderImages()
  }
  lastEdit = null
  dirty()
  renderAssistPane()
}
function showArt(index = 0) {
  const ids = context().images,
    id = ids[index]
  if (!id) return
  const a = data.assets.find((a) => a.id === id)
  modal(
    '第 ' + (index + 1) + ' 张 · ' + (a?.name || '视频封面'),
    '<img class="review-image" src="' +
      mediaUrl('image', id) +
      '" alt="当前图片"><div class="actions">' +
      (index ? deskButton('上一张', 'art', String(index - 1)) : '') +
      (index + 1 < ids.length
        ? deskButton('下一张', 'art', String(index + 1))
        : '') +
      (composerTab === 'risk'
        ? deskButton(
            readChecks().includes(checkKey(id))
              ? '已人工核对'
              : '标为已人工核对',
            'mark-art',
            id
          )
        : '') +
      (screen === 'write' && index > 0
        ? deskButton('移到首图', 'lead-art', id)
        : '') +
      (screen === 'write' ? deskButton('移除本图', 'remove-art', id) : '') +
      '</div>'
  )
}
async function composerAction(cmd, id) {
  if (cmd === 'postvela-import' || cmd === 'postvela-reimport') {
    await save()
    const d = await api['postvela-draft'](id, cmd === 'postvela-reimport')
    await sync()
    if (screen !== 'write') screen = 'write'
    timing(false)
    setDraft(d)
    renderScreen()
    if (dialog.open) dialog.close()
    toast((cmd === 'postvela-reimport' ? '已重新导入' : '已打开') + '图文稿：' + (d.assets?.length || 0) + ' 张图，勾选账号后加入发布队列')
    return
  }
  if(['postvela-title','postvela-body','postvela-folder'].includes(cmd)) {
    await api['postvela-action'](id,cmd.slice(9))
    toast(cmd==='postvela-folder'?'已打开素材文件夹':'已复制')
  }
  if (cmd === 'fresh-source') await openSource(id, true)
  if (cmd === 'mobile-source') {
    pickedKind = id
    localStorage.setItem('desk-source', id)
    await showMobileSources()
  }
  if (cmd === 'mobile-bind') {
    await api['source-bind'](sourceKind())
    await showMobileSources()
  }
  if (cmd === 'bind-source') {
    if (await api['source-bind'](sourceKind())) await loadSources()
  }
  if (cmd === 'source-kind') {
    pickedKind = id
    localStorage.setItem('desk-source', id)
    await loadSources()
  }
  if (cmd === 'load-source') await openSource(id, false)
  if (cmd === 'frame') await applyCover(frameData($('clip-player')))
  if (cmd === 'make-covers' || cmd === 'import-format') await makeCovers(cmd === 'import-format' ? id : null)
  if (cmd === 'preview-format' && editorFormats[selectedClip]?.[id]) {
    const size = data.coverSizes[id]
    modal(size.label + ' · ' + size.width + ' × ' + size.height,
      '<img class="cover-inspect" alt="投稿封面预览" src="' + mediaUrl('image',editorFormats[selectedClip][id]) + '">' +
      deskButton('让 Codex 为这个比例重新构图','recompose-art',id))
  }
  if (cmd === 'recompose-art' && Object.hasOwn(data.coverSizes,id)) {
    dialog.close()
    await generateCoverArt(id)
  }
  if (cmd === 'generate-art') await generateCoverArt()
  if (cmd === 'apply-pending-covers') {
    if (makingCovers) throw Error('封面正在制作，请稍候')
    await save()
    const {updated,skipped} = await api['apply-pending-covers'](draft.id,draft.revision,selectedClip)
    toast('已更新 ' + updated + ' 项' + (skipped ? '，另有 ' + skipped + ' 项正在核对或已有同版任务' : ''))
  }
  if (cmd === 'use-art') {
    const key = candidateKey(draft.id,selectedClip), candidate = currentCandidate()
    if (!candidate) return
    await makeCovers(candidate.format, candidate.id)
    if (JSON.parse(localStorage.getItem(key))?.id === candidate.id) localStorage.removeItem(key)
    showSelectedCover()
  }
  if (cmd === 'cover') await applyCover(null)
  if (cmd === 'assist-tab' || cmd.startsWith('assist-')) {
    if (cmd === 'assist-tab') composerTab = id
    else composerTab = 'ai'
    assistField =
      composerTab === 'risk'
        ? '风险复核'
        : cmd === 'assist-field'
          ? id
          : cmd === 'assist-images'
            ? '配图'
            : cmd === 'assist-body'
              ? screen === 'video'
                ? '简介'
                : '正文'
              : '标题'
    suggestion = null
    renderAssistPane()
    if (matchMedia('(max-width:760px)').matches)
      $('assist-tabs').scrollIntoView({ block: 'center' })
  }
  if (cmd === 'generate') await askAI()
  if (cmd === 'apply-advice') applyAdvice()
  if (cmd === 'undo-advice') undoAdvice()
  if (cmd === 'handoff') {
    const c = context()
    await api.copy(
      '请审阅以下稿件并返回修改建议。\n' +
        JSON.stringify(
          {
            ...c,
            images: c.images.map(
              (id) => data.assets.find((a) => a.id === id)?.name || id
            ),
            封面改图说明: artNote
          },
          null,
          2
        )
    )
    toast('已复制本稿交接任务')
  }
  if (cmd === 'review-video') {
    const player = $('clip-player')
    player.scrollIntoView({ block: 'center' })
    player.focus()
  }
  if (cmd === 'mark-art' || cmd === 'mark-video') {
    markChecked(id)
    if (dialog.open) dialog.close()
    renderAssistPane()
  }
  if (cmd === 'lead-art' && imageIds.includes(id)) {
    imageIds = [id, ...imageIds.filter((x) => x !== id)]
    dialog.close()
    renderImages()
    dirty()
    renderAssistPane()
  }
  if (cmd === 'review-art' || cmd === 'art') showArt(Number(id) || 0)
  if (cmd === 'remove-art') {
    imageIds = imageIds.filter((k) => k !== id)
    dialog.close()
    renderImages()
    dirty()
    renderAssistPane()
  }
  if (cmd === 'locate') {
    const c = context(),
      valid = suggestion?.stamp === contextStamp(c)
    const x = [...localIssues(c), ...(valid ? suggestion.reply.issues : [])][
      Number(id)
    ]
    if (!x) return
    for (const el of [$('title'), $('body')]) {
      const i = el.value.indexOf(x.quote)
      if (x.quote && i >= 0) {
        el.focus()
        el.setSelectionRange(i, i + x.quote.length)
        return
      }
    }
    const n = String(x.position).match(/第?\s*(\d+)\s*张/)
    if (n && c.images[Number(n[1]) - 1]) showArt(Number(n[1]) - 1)
    else toast('请按提示核对：' + x.position)
  }
}
document.addEventListener('DOMContentLoaded', () => {
  $('clip-player').addEventListener('loadedmetadata', candidateFrames)
  $('clip-player').addEventListener('error', () => {
    if ($('clip-player').hasAttribute('src'))
      toast('当前格式无法预览，可重新导入视频')
  })
  for (const k of ['title', 'body', 'targets'])
    $(k).addEventListener('input', () => {
      if (composerTab !== 'pub') renderAssistPane()
    })
  document.addEventListener('input', (e) => {
    if (e.target.id === 'assist-reader') assistReader = e.target.value
    if (e.target.id === 'assist-goal') assistGoal = e.target.value
  })
})
