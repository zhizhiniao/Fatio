const fs = require('node:fs/promises')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { platforms } = require('./catalog.cjs')
const { attachMedia } = require('./videos.cjs')
const { advanceCover } = require('./video-cover-editor.cjs')
const { editorExpression } = require('./video-editor-dom.cjs')

function withTopics(body, tags) {
  const used = new Set(Array.from(body.matchAll(/[#＃]([^\s#＃,，、]+)/gu), m => m[1]))
  const suffix = tags.filter(t => !used.has(t)).map(t => '#' + t).join(' ')
  return [body, suffix].filter(Boolean).join('\n')
}
function draftCopy(job) {
  return [job.title, withTopics(job.body, JSON.parse(job.videoTags || '[]'))].filter(Boolean).join('\n')
}
async function videoMaterials(store, job, root) {
  if (!job.videoId) throw Error('请选择视频任务')
  const folder = path.join(root, job.id, job.fingerprint?.slice(0,16) || '')
  await fs.mkdir(folder, {recursive: true})
  const formats = JSON.parse(job.coverFormats || '{}')
  if (!Object.keys(formats).length && job.coverId) formats.single = job.coverId
  const files = {}
  for (const [kind, id] of Object.entries(formats)) {
    const image = store.asset(id, true)
    if (!image) throw Error('封面素材缺失')
    const ext = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}[image.mime]
    files[kind] = path.join(folder, {wide: '横版封面', portrait: '竖版封面', single: '视频封面'}[kind] + ext)
    await fs.writeFile(files[kind], image.bytes)
  }
  await fs.writeFile(path.join(folder, '投稿文案.txt'), draftCopy(job))
  return { folder, files }
}
function videoRoute(platform, raw, afterUpload) {
  if (!URL.canParse(raw || '')) return false
  const u = new URL(raw), base = new URL(platforms[platform].video)
  if (u.origin !== base.origin || [...u.searchParams.keys()].some(k =>
    /^(aid|bvid|cvid|id|item_?id|note_?id|draft_?id|workId|publishId|edit)$/i.test(k))) return false
  const p = u.pathname.replace(/\/$/, '')
  if (platform === 'douyin' && afterUpload && isDouyinDetails(p)) return true
  return p === base.pathname && [...base.searchParams].every(([k,v]) => u.searchParams.get(k) === v) &&
    !(platform === 'douyin' && u.searchParams.get('default-tab') === '3')
}
function isDouyinDetails(pathname) {
  return /^\/creator-micro\/content\/(publish|post-video|post\/video)\/?$/.test(pathname)
}

// Executed in an identity-verified new video editor. Never submit the surrounding form.
function videoFields(root, platform, copy, writing, verifying = false) {
  const visible = n => !n.disabled && !n.readOnly && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden'
  const all = s => [...root.querySelectorAll(s)].filter(visible)
  const read = n => (n.value ?? n.innerText ?? '').replace(/\u200b/g, '').replace(/\r\n/g, '\n').trim()
  const title = all('input[placeholder*="标题"],textarea[placeholder*="标题"],input[placeholder*="概括视频"]')
  const caption = platform === 'tiktok'
    ? all('[data-e2e*="caption"] [contenteditable=true], [contenteditable=true][data-e2e*="caption"], .public-DraftEditor-content[contenteditable=true],textarea[placeholder*="caption" i]')
    : all('textarea[placeholder*="简介"],textarea[placeholder*="描述"],[contenteditable=true],[contenteditable=""]').filter(n => !title.includes(n))
  const combined = platform === 'tiktok' || (platform === 'kuaishou' && !title.length)
  const tagInput = all('input[placeholder*="标签"],input[placeholder*="按回车"],input[aria-label="标签"],input[aria-label="Tags"]')
  const structuredTags = platform === 'bilibili' || tagInput.length === 1
  const bodyText = structuredTags ? copy.rawBody : copy.body
  const fields = [
    ...(!combined && copy.title ? [[title, copy.title, '标题']] : []),
    [caption, combined ? [copy.title, bodyText].filter(Boolean).join('\n') : bodyText, '简介']
  ].filter(([,value]) => value)
  const fileNodes = [...root.querySelectorAll(platform === 'bilibili'
    ? '.bcc-upload-wrapper input[type=file]' : 'input[type=file]')].filter(n => !n.disabled && /video|mp4|mov|webm/i.test(n.accept))
  if (!writing) return {
    documentTime: performance.timeOrigin,
    emptyUpload: fileNodes.length === 1 && !fileNodes[0].files.length,
    occupied: [...title, ...caption, ...tagInput].some(n => read(n) || n.querySelector('img:not(.ProseMirror-separator),video,a')) ||
      fileNodes.some(n => n.files.length) || all('video[src]:not([src=""])').length > 0
  }
  if (fileNodes.some(n => n.files.length && n.files[0].name !== copy.filename))
    return { conflict: '视频已在平台更换，请核对当前稿件' }
  const failure = all('[role=alert],.ant-message-error,[class*="upload-error"]').map(read)
    .find(s => /失败|不支持|超出|超限|上传错误|upload failed/i.test(s))
  if (failure) return { conflict: failure.slice(0,120) }
  const pending = []
  for (const [nodes, value, label] of fields) {
    if (nodes.length !== 1) { pending.push(label); continue }
    const n = nodes[0], before = read(n)
    if (before === value.trim()) continue
    // Some uploaders initialize the title from our content-addressed filename.
    const filenameTitle = label === '标题' && copy.filename && (before === copy.filename ||
      (/^[0-9a-f]{8,64}(?:…|\.\.\.)?$/i.test(before) && copy.filename.startsWith(before.replace(/…|\.\.\.$/,''))))
    if ((before && !filenameTitle) || n.querySelector('img:not(.ProseMirror-separator),video,a')) {
      pending.push(label + '已有其他内容，请在后台核对')
      continue
    }
    if (!verifying) {
      n.focus()
      if (n.isContentEditable) n.ownerDocument.execCommand('insertText', false, value)
      else {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n),'value').set.call(n, value)
        n.dispatchEvent(new Event('input',{bubbles:true}))
        n.dispatchEvent(new Event('change',{bubbles:true}))
      }
    }
    if (read(n) !== value.trim()) pending.push(label)
  }
  if (structuredTags && copy.tags.length) {
    const input = tagInput.length === 1 ? tagInput[0] : null
    const parent = input?.closest('.tag-container,[class*="tag-wrapper"],[class*="tag-list"],[class*="tag-input"]')?.parentElement || input?.parentElement?.parentElement
    const chips = () => new Set(parent ? [...parent.querySelectorAll('[class*="tag-item"],[class*="tag-chip"],.bcc-tag,[role=listitem]')].map(n => read(n).replace(/^#/, '')) : [])
    for (const tag of copy.tags) {
      if (chips().has(tag)) continue
      if (!input || verifying || read(input)) { pending.push('平台标签'); break }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, tag)
      input.dispatchEvent(new Event('input',{bubbles:true}))
      for (const type of ['keydown','keyup']) input.dispatchEvent(new KeyboardEvent(type,{key:'Enter', code:'Enter', keyCode:13, bubbles:true, cancelable:true}))
      if (!chips().has(tag)) { pending.push('平台标签'); break }
    }
  }
  return { pending, inlineTopics: copy.tags.length > 0 && !structuredTags }
}

function createVideoHandoff({win, account, job, verify, video, materials, pending, arm, report}) {
  const wc = win.webContents, platform = account.platform
  let busy = false, sent = false, videoFile, coverFiles, documentTime, uploadURL
  const states = new Map()
  const tags = JSON.parse(job.videoTags || '[]')
  const copy = {title: job.title, rawBody: job.body, body: withTopics(job.body, tags), tags}
  const run = async () => {
    if (busy || win.isDestroyed()) return
    busy = true
    let last = '等待新建视频页', identityUrl = '', user, coverSince = 0
    report('working', sent ? '正在检查未完成项' : '正在检查平台编辑器')
    const execute = (href, writing, verifying = false) => wc.executeJavaScript(
      editorExpression(platform,href,videoFields,platform,copy,writing,verifying),true)
    for (const state of states.values()) {
      if (state.unverified) { state.sent = false; state.unverified = false; state.recheck = true }
      if (!state.sent) { state.opened = false; state.tab = false; state.local = false }
    }
    try {
      const end = Date.now() + 120000
      while (Date.now() < end && !win.isDestroyed()) {
        if (!pending()) throw Error('任务状态已改变')
        const href = wc.getURL()
        if (!videoRoute(platform,href,sent)) {
          last = '请登录目标账号并进入新建视频页'
          report('working',last)
          await delay(650); continue
        }
        if (href !== identityUrl) {
          report('working','正在核对账号')
          user = await verify()
          if (wc.getURL() !== href) continue
          identityUrl = href
        }
        if (!sent) {
          const state = await execute(href,false)
          if (!state) continue
          if (state.occupied) throw Error('后台已有稿件或素材，请先核对')
          if (!state.emptyUpload) { last = '等待视频上传框'; report('working',last); await delay(650); continue }
          videoFile ||= await video()
          copy.filename = path.basename(videoFile)
          user = await verify()
          if (!pending() || wc.getURL() !== href) continue
          await attachMedia(win,account,job,[videoFile])
          sent = true
          documentTime = state.documentTime
          uploadURL = href
          if (user && platform === 'douyin') await arm(user.uid)
          report('working','视频已选入，等待平台文案栏')
          await delay(400); continue
        }
        if (!pending() || wc.getURL() !== href) continue
        const currentDocument = await wc.executeJavaScript('performance.timeOrigin')
        if (currentDocument !== documentTime) {
          const next = new URL(href)
          if (platform !== 'douyin' || !uploadURL || next.pathname === new URL(uploadURL).pathname ||
              !isDouyinDetails(next.pathname))
            throw Error('投稿页已重新加载，请核对当前视频；需要重新选入时请关闭并重开本任务')
          documentTime = currentDocument
          uploadURL = null
        }
        const text = await execute(href,true)
        if (!text) continue
        if (text.conflict) throw Error(text.conflict)
        last = text.pending.length ? '待核对：' + text.pending.join('、') : '文案已填入'
        if (!coverFiles) coverFiles = (await materials()).files
        const keys = Object.keys(coverFiles)
        const preferred = job.preferredCover || (platform === 'bilibili' ? 'wide' : 'portrait')
        const fallback = coverFiles[preferred] ? preferred : keys[0]
        const ordered = [...new Set([fallback,...keys])].filter(Boolean)
        let coverMessage = ''
        for (const key of ordered) {
          if (!states.has(key)) states.set(key,{generic:key === fallback})
          const state = states.get(key)
          if (state.done || state.unverified) continue
          if (!pending() || wc.getURL() !== href) break
          coverMessage = await advanceCover(wc,href,platform,key,coverFiles[key],state) || ''
          if (state.unverified) throw Error('图片已交给平台，尚未读到封面。可查看平台预览或继续检查该封面。')
          if (state.done && state.single) {
            for (const other of keys) if (other !== key) states.set(other,{done:true,unused:true})
          }
          // One modal owns focus. Complete it before opening a different slot.
          if (!state.done && (state.opened || state.sent)) break
        }
        const missing = keys.filter(k => !states.get(k)?.done)
        const names = {wide:'横版封面',portrait:'竖版封面',single:'封面'}
        if (!missing.length) {
          const checked = await execute(href,true,true)
          if (!checked || wc.getURL() !== href || !pending()) continue
          if (checked.conflict) throw Error(checked.conflict)
          if (!checked.pending.length) {
            report('ready','视频、文案' + (keys.length ? '和封面' : '') + '已带入，待审核')
            return
          }
          if (checked.pending.some(p => p.includes('已有其他内容'))) throw Error(checked.pending.join('、'))
        }
        if (missing.length) {
          if (!coverSince) coverSince = Date.now()
          last += ' · ' + (coverMessage && coverMessage !== 'done' ? coverMessage : '等待' + missing.map(k=>names[k]).join('、') + '入口或预览')
          if (Date.now() - coverSince > 45000) throw Error(last + '。请检查平台转码或封面面板后继续。')
        }
        report('working',last)
        await delay(650)
      }
      if (!win.isDestroyed()) report('partial',last)
    } catch (err) {
      if (!win.isDestroyed()) report('partial', err.message)
    } finally { busy = false }
  }
  return run
}
module.exports = { createVideoHandoff, draftCopy, videoMaterials, videoRoute, withTopics }
