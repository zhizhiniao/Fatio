const { ORIGIN, clientFor } = require('./douyin.cjs')
const watched = new WeakMap()
const createRoutes = new Set(['/web/api/media/aweme/create', '/web/api/media/aweme/create_v2'])
function createdId(raw, route) {
  const value = JSON.parse(raw, (_, v, ctx) =>
    typeof v === 'number' && !Number.isSafeInteger(v) && /^\d{16,}$/.test(ctx?.source || '')
      ? ctx.source
      : v
  )
  if (Number(value.status_code ?? value.status) !== 0) return ''
  const candidates = (
    route?.endsWith('create_v2')
      ? [value.item_id]
      : route
        ? [value.aweme?.aweme_id]
        : [value.item_id, value.aweme?.aweme_id]
  )
    .filter((v) => typeof v === 'string' || Number.isSafeInteger(v))
    .map(String)
    .filter((v) => /^[1-9]\d*$/.test(v))
  return new Set(candidates).size === 1 ? candidates[0] : ''
}
// No body is collected except the response to the exact native publish operation in this job window.
function watchReceipt(wc, job, library, onChange) {
  const debug = wc.debugger,
    requests = new Map()
  if (debug.isAttached()) return
  const state = { uid: '', jobId: job.id, frame: null }
  try {
    debug.attach('1.3')
  } catch {
    return
  }
  watched.set(wc, state)
  debug.on('message', async (_, method, p) => {
    try {
      if (method === 'Runtime.bindingCalled' && p.name === '__jaInvalidateReceipt') {
        state.uid = ''
        return
      }
      if (method === 'Network.requestWillBeSent') {
        if (requests.has(p.requestId)) requests.delete(p.requestId)
        if (
          !state.uid ||
          !state.frame ||
          p.frameId !== state.frame ||
          p.request.method !== 'POST' ||
          !['XHR', 'Fetch'].includes(p.type)
        )
          return
        const u = new URL(p.request.url)
        const route = u.pathname.replace(/\/$/, '')
        if (
          u.origin === ORIGIN &&
          createRoutes.has(route) &&
          library.submitting(job.id, state.uid)
        ) {
          requests.set(p.requestId, { uid: state.uid, route, ready: false })
          state.uid = ''
          onChange()
        }
      } else if (method === 'Network.responseReceived') {
        const r = requests.get(p.requestId)
        if (r) r.ready = p.response.status >= 200 && p.response.status < 300
      } else if (method === 'Network.loadingFailed') requests.delete(p.requestId)
      else if (method === 'Network.loadingFinished' && requests.has(p.requestId)) {
        const r = requests.get(p.requestId)
        requests.delete(p.requestId)
        if (!r.ready || p.encodedDataLength > 2 * 1024 * 1024) return
        const body = await debug.sendCommand('Network.getResponseBody', { requestId: p.requestId })
        if (body.base64Encoded) return
        const item = createdId(body.body, r.route)
        if (item && (await clientFor(wc).who()).uid === r.uid) {
          state.uid = ''
          library.candidate(job.id, r.uid, item)
          onChange()
        }
      }
    } catch {
      /* The queue can still link a verified item explicitly if the website changes. */
    }
  })
  debug.on('detach', () => watched.delete(wc))
  wc.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) {
      state.uid = ''
      state.frame = null
    }
  })
  wc.on('did-finish-load', () => {
    void debug
      .sendCommand('Page.getFrameTree')
      .then((r) => {
        state.frame = r.frameTree.frame.id
      })
      .catch(() => {
        state.frame = null
      })
  })
  void debug.sendCommand('Network.enable').catch(() => {
    if (debug.isAttached()) debug.detach()
  })
}
async function armReceipt(wc, uid) {
  const state = watched.get(wc)
  if (!state) return
  try {
    if (!state.hasBinding) {
      await wc.debugger.sendCommand('Runtime.enable')
      await wc.debugger.sendCommand('Runtime.addBinding', { name: '__jaInvalidateReceipt' })
      state.hasBinding = true
    }
    await wc.executeJavaScript(
      "(()=>{const guard=e=>{if(e.type==='drop'||(e.target?.type==='file'&&!/^image\\/|^\\.(png|jpe?g|webp)/i.test(e.target.accept)))window.__jaInvalidateReceipt('changed')};document.addEventListener('change',guard,true);document.addEventListener('drop',guard,true)})()"
    )
    state.uid = uid
  } catch {
    state.uid = ''
  }
}
async function fillDraft(job, platform = 'douyin', graphic = false, readOnly = false) {
  const routes = {
    douyin: [
      'https://creator.douyin.com',
      /^\/creator-micro\/content\/(upload|publish|post-video|post\/image)(?:\/|$)/
    ],
    xhs: ['https://creator.xiaohongshu.com', /^\/publish\/publish\/?$/],
    wechat: ['https://mp.weixin.qq.com', /^\/cgi-bin\/appmsg$/],
    channels: ['https://channels.weixin.qq.com', /^\/platform\/post\/create\/?$/],
    kuaishou: ['https://cp.kuaishou.com', /^\/article\/publish\/video\/?$/],
    bilibili: [
      'https://member.bilibili.com',
      /^\/(?:platform\/upload\/video\/frame|york\/read-editor)\/?$/
    ],
    tiktok: ['https://www.tiktok.com', /^\/tiktokstudio\/upload\/?$/]
  }
  const route = routes[platform]
  const editing = [...new URLSearchParams(location.search).keys()].some((k) =>
    /^(aid|bvid|id|cvid|draft_?id|item_?id|note_?id|workId|publishId|edit)$/i.test(k)
  )
  if (!route || location.origin !== route[0] || !route[1].test(location.pathname) || editing)
    return '请先进入官方新投稿页'
  if (platform === 'wechat') {
    const query = new URLSearchParams(location.search)
    if (
      query.get('appmsgid') ||
      (graphic && query.get('type') !== '77') ||
      query.get('t') !== 'media/appmsg_edit_v2' ||
      query.get('action') !== 'edit'
    )
      return '请打开微信公众号的新建文章'
  }
  const visible = (el) => el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.disabled
  if (
    platform === 'bilibili' &&
    location.pathname === '/york/read-editor' &&
    job.body &&
    !document.querySelector('[contenteditable=true]')
  ) {
    const preview = document.querySelector('.editor-container .editor-preview')
    if (
      preview &&
      visible(preview) &&
      !preview.innerText.trim() &&
      !preview.querySelector('img,video,a')
    ) {
      preview.click()
      for (let i = 0; i < 10 && !document.querySelector('[contenteditable=true]'); i++)
        await new Promise((r) => setTimeout(r, 100))
    }
  }
  const titles = [
    ...document.querySelectorAll(
      platform === 'wechat' && graphic
        ? '.title-editor__input [contenteditable=true]'
        : platform === 'kuaishou' && graphic
        ? 'input[placeholder="作品标题"],textarea[placeholder="作品标题"]'
        : platform === 'wechat'
        ? 'textarea#title,input#title'
        : 'input[placeholder*="标题"],textarea[placeholder*="标题"],input[placeholder*="概括视频"]'
    )
  ].filter(visible)
  const editors = [
    ...document.querySelectorAll(
      platform === 'wechat' && graphic
        ? '.share-text__input [contenteditable=true]'
        : platform === 'kuaishou' && graphic
        ? '#work-description-edit[contenteditable=true]'
        : platform === 'xhs' && graphic
        ? '.tiptap.ProseMirror[contenteditable=true]'
        : platform === 'douyin' && graphic
        ? '.zone-container[contenteditable=true]'
        : platform === 'wechat'
        ? '.rich_media_content .ProseMirror[contenteditable="true"]'
        : '[contenteditable="true"],textarea[placeholder*="简介"]'
    )
  ].filter(visible)
  const plain = (s) =>
    String(s || '')
      .trim()
      .replace(/\r\n/g, '\n')
  if (graphic) {
    const combined = platform === 'kuaishou' && !titles.length
    const desiredBody = combined ? [job.title, job.body].filter(Boolean).join('\n') : job.body
    const fields = [
      ...(!combined && job.title ? [[titles, job.title, '标题']] : []),
      ...(desiredBody ? [[editors, desiredBody, '正文']] : [])
    ]
    for (const [nodes, value, label] of fields) {
      if (nodes.length !== 1) return { complete: false, message: '等待' + label + '编辑栏' }
      const el = nodes[0], read = () => plain((el.value ?? el.innerText)
        .replace(el.querySelector('.editor_placeholder')?.textContent || '', '').replace(/\u200b/g, ''))
      if (read() === plain(value)) continue
      if (read() || el.querySelector('img:not(.ProseMirror-separator),video,a')) return { complete: false, conflict: true, message: label + '已有其他内容，请核对' }
      if (readOnly) return { complete: false, message: label + '尚未填入' }
      if (el.isContentEditable) {
        el.focus()
        if (value.includes('\n')) {
          const html = value.replace(/\r\n/g, '\n').split('\n')
            .map(line => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>')
          document.execCommand('insertHTML', false, html)
        } else document.execCommand('insertText', false, value)
      } else {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (read() !== plain(value)) return { complete: false, conflict: true, message: label + '未完整写入，请检查平台字数限制' }
    }
    return { complete: true }
  }
  if (platform === 'tiktok') {
    const captions = [
      ...document.querySelectorAll(
        '[data-e2e*="caption"] [contenteditable=true], [contenteditable=true][data-e2e*="caption"], .public-DraftEditor-content[contenteditable=true],textarea[placeholder*="caption" i]'
      )
    ].filter(visible)
    if (captions.length !== 1) return '未识别到唯一描述框，可使用复制正文。'
    const caption = captions[0],
      text = [job.title, job.body].filter(Boolean).join('\n'),
      read = () => plain(caption.value ?? caption.innerText)
    if (!read() && !caption.querySelector('img,video,a')) {
      if (caption.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
          caption,
          text
        )
        caption.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        caption.focus()
        document.execCommand('insertText', false, text)
      }
    }
    return read() === plain(text)
      ? '已回读视频描述，请在 TikTok Studio 核对后发表。'
      : '描述栏已有内容，请核对当前稿件。'
  }
  const filled = []
  if (titles.length === 1 && job.title) {
    const field = titles[0]
    if (!field.value) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(
        field,
        job.title
      )
      field.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (plain(field.value) === plain(job.title)) filled.push('标题')
  }
  if (editors.length === 1 && job.body) {
    const field = editors[0]
    if (field.tagName === 'TEXTAREA') {
      if (!field.value) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
          field,
          job.body
        )
        field.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (plain(field.value) === plain(job.body)) filled.push('简介')
    } else {
      if (!plain(field.innerText) && !field.querySelector('img,video,a,button')) {
        field.focus()
        document.execCommand('insertText', false, job.body)
      }
      if (plain(field.innerText) === plain(job.body)) filled.push('简介')
    }
  }
  const missing = [
    job.title && !filled.includes('标题') ? '标题' : '',
    job.body && !filled.includes('简介') ? '正文' : ''
  ].filter(Boolean)
  return filled.length
    ? '已回读' +
        filled.join('和') +
        '。' +
        (missing.length ? missing.join('和') + '请手动核对。' : '请在官方页面核对后发表。')
    : '未识别到空白编辑栏，已保留当前内容；可使用复制标题或正文。'
}
module.exports = { watched, watchReceipt, armReceipt, createdId, fillDraft }
