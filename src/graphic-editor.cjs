const { setTimeout: delay } = require('node:timers/promises')
const { platforms } = require('./catalog.cjs')
const { enterEditor } = require('./wechat-studio.cjs')
const { fillDraft } = require('./douyin-window.cjs')

const graphicPlatforms = new Set(['douyin', 'xhs', 'kuaishou', 'wechat'])
function graphicRoute(platform, raw) {
  if (!raw || !URL.canParse(raw)) return ''
  const u = new URL(raw), q = u.searchParams
  if (u.origin !== new URL(platforms[platform].article).origin ||
      [...q.keys()].some(k => /^(aid|id|appmsgid|draft_?id|item_?id|note_?id|workId|publishId|edit)$/i.test(k) && q.get(k))) return ''
  if (platform === 'wechat') {
    if (u.pathname === '/cgi-bin/home') return 'home'
    return u.pathname === '/cgi-bin/appmsg' && q.get('action') === 'edit' &&
      q.get('t') === 'media/appmsg_edit_v2' && q.get('type') === '77' ? 'editor' : ''
  }
  if (platform === 'douyin') {
    if (u.pathname === '/creator-micro/content/upload' && q.get('default-tab') === '3') return 'upload'
    return u.pathname === '/creator-micro/content/post/image' ? 'editor' : ''
  }
  if (platform === 'xhs') return u.pathname === '/publish/publish' && q.get('target') === 'image' ? 'upload' : ''
  return u.pathname === '/article/publish/video' && q.get('tabType') === '2' ? 'upload' : ''
}

// Runs in the official editor. Count the task album, excluding site logos and duplicated phone previews.
function inspectGraphic(platform) {
  const visible = el => el?.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden'
  const all = selector => [...document.querySelectorAll(selector)].filter(visible)
  const albumSelectors = {
    wechat: '.image-selector__bottom-list-item',
    kuaishou: '.ant-tabs-tabpane-active [class*="_upload-item_"] img',
    douyin: '[class*="content-upload-"] [class*="mycard-"]',
    xhs: '.img-container .format-img img.preview'
  }
  let count
  if (platform === 'kuaishou') {
    count = all(albumSelectors.kuaishou).filter(e => e.complete && e.naturalWidth > 0).length
  } else {
    const cards = all(albumSelectors[platform])
    count = cards.filter(e => !cards.some(other => other !== e && other.contains(e)) &&
      (e.matches('img') || e.querySelector('img') || /url\(/.test(getComputedStyle(e).backgroundImage))).length
  }
  const warnings = all('[role=alert],.ant-message-error,.weui-desktop-toast,[class*="upload-error"]')
    .map(e => (e.innerText || e.parentElement?.innerText || '').trim())
    .find(t => /失败|不支持|超过|错误/.test(t))
  const uploadSelectors = {
    douyin: 'input[type=file]', xhs: 'input[type=file]', kuaishou: '.ant-tabs-tabpane-active input[type=file]',
    wechat: '.image-selector__add .js_upload_btn_container input[type=file]'
  }
  const input = [...document.querySelectorAll(uploadSelectors[platform])].filter(e => !e.disabled && /image|png|jpe?g/i.test(e.accept))
  const editors = all(platform === 'wechat'
    ? '.title-editor__input [contenteditable=true],.share-text__input [contenteditable=true]'
    : 'input[placeholder*="标题"],textarea[placeholder*="简介"],[contenteditable=true]')
  return { count, input: input.length === 1 && !input[0].files.length,
    occupied: editors.some(e => (e.value ?? e.innerText).replace(e.querySelector('.editor_placeholder')?.textContent || '', '')
      .replace(/\u200b/g, '').trim()),
    progress: all('.image-selector__bottom-list-item .weui-desktop-loading, .image-selector__bottom-list-item .deleted_mask').length > 0 ||
      all('.ant-progress,[class*="uploading"],[class*="Uploading"]').some(e => e.innerText.includes('%')),
    warning: warnings || '' }
}

async function sendImages(wc, platform, files) {
  const href = wc.getURL()
  const dbg = wc.debugger
  if (dbg.isAttached()) throw Error('上传窗口正忙，请重试')
  dbg.attach('1.3')
  let onMessage, timer
  try {
    const selector = { wechat: '.image-selector__add .js_upload_btn_container input[type=file]',
      kuaishou: '.ant-tabs-tabpane-active input[type=file]' }[platform] || 'input[type=file]'
    const { result } = await dbg.sendCommand('Runtime.evaluate', { expression:
      '(()=>{const n=[...document.querySelectorAll(' + JSON.stringify(selector) +
      ')].filter(e=>!e.disabled && /image|png|jpe?g/i.test(e.accept));return n.length===1 && !n[0].files.length && (' +
      files.length + '===1 || n[0].multiple) ? n[0] : null})()' })
    if (!result.objectId || wc.getURL() !== href) throw Error('未找到对应的空配图上传框')
    const { node } = await dbg.sendCommand('DOM.describeNode', { objectId: result.objectId })
    if (platform === 'kuaishou') {
      // The official upload button installs the FIRST upload listener before opening the chooser.
      await dbg.sendCommand('Page.enable')
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      const chooser = new Promise(resolve => {
        onMessage = (_, method, data) => { if (method === 'Page.fileChooserOpened') resolve(data.backendNodeId) }
        dbg.on('message', onMessage)
        timer = setTimeout(() => resolve(null), 4500)
      })
      const clicked = await wc.executeJavaScript(
        '(()=>{const b=[...document.querySelectorAll(".ant-tabs-tabpane-active button")].filter(e=>e.innerText.trim()==="上传图片" && e.getBoundingClientRect().height>0);if(b.length!==1)return false;b[0].click();return true})()', true)
      if (!clicked || await chooser !== node.backendNodeId) throw Error('快手未打开图集的「上传图片」控件')
    }
    if (wc.getURL() !== href) throw Error('投稿页已切换，请核对当前页面')
    await dbg.sendCommand('DOM.setFileInputFiles', { backendNodeId: node.backendNodeId, files })
  } finally {
    clearTimeout(timer)
    if (onMessage) dbg.off('message', onMessage)
    if (dbg.isAttached()) {
      if (platform === 'kuaishou')
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
      if (dbg.isAttached()) dbg.detach()
    }
  }
}

function installGraphicEditor({ win, account, job, label, menu, verify, getFiles, pending }) {
  const wc = win.webContents, platform = account.platform, expected = JSON.parse(job.assets).length
  let running = false, finished = false, sent = false, opened = false
  const report = message => { if (!win.isDestroyed()) win.setTitle(message + ' · ' + label) }
  const execute = (fn, ...args) => {
    const href = wc.getURL()
    return wc.executeJavaScript('location.href === ' + JSON.stringify(href) + ' ? (' + fn.toString() +
      ')(...' + JSON.stringify(args) + ') : null', true).catch(error => {
        if (!win.isDestroyed() && (wc.getURL() !== href || /context was destroyed|frame was detached/i.test(error.message))) return null
        throw error
      })
  }
  const run = async () => {
    if (running || finished || win.isDestroyed()) return
    running = true
    try {
      report('正在准备图文')
      const deadline = Date.now() + 65000
      let checkedURL = '', count = 0
      while (Date.now() < deadline && !win.isDestroyed()) {
        if (!pending()) throw Error('任务已结束')
        const href = wc.getURL(), route = graphicRoute(platform, href)
        if (route && checkedURL !== href) {
          await verify()
          if (wc.getURL() !== href) continue
          checkedURL = href
        }
        if (route === 'home' && !opened) opened = !!await execute(enterEditor, '贴图')
        if (route === 'upload' || route === 'editor') {
          const state = await execute(inspectGraphic, platform)
          if (!state) continue
          count = state.count
          if (state.warning) throw Error(state.warning)
          if (!sent) {
            if (count || state.occupied) throw Error('官方编辑器已有内容，请核对现有稿件')
            if (state.input) {
              const files = await getFiles()
              if (!pending() || wc.getURL() !== href) throw Error('任务或投稿页已改变')
              await verify()
              if (!pending() || wc.getURL() !== href) throw Error('任务或投稿页已改变')
              await sendImages(wc, platform, files)
              sent = true
            }
          } else if (count === expected && !state.progress) {
            await verify()
            if (!pending() || wc.getURL() !== href) continue
            const result = await execute(fillDraft, { title: job.title, body: job.body }, platform, true)
            if (result?.complete) {
              await delay(350)
              if (!pending() || wc.getURL() !== href) continue
              const final = await execute(inspectGraphic, platform)
              const text = await execute(fillDraft, { title: job.title, body: job.body }, platform, true, true)
              if (final?.count === expected && !final.progress && !final.warning && text?.complete) {
                finished = true
                report('已就绪 · ' + expected + ' 张配图及文案已核对，请手动发布')
                return
              }
            }
            if (result?.conflict) throw Error(result.message)
          }
          report(sent ? '正在核对配图 ' + count + '/' + expected : '等待配图上传区')
        }
        await delay(350)
      }
      if (!win.isDestroyed()) throw Error(sent ? '已选图，页面核对到 ' + count + '/' + expected + ' 张，配图或文案尚未就绪' :
        '未找到新建图文的配图入口，请检查登录和页面')
    } catch (e) {
      report('图文待检查 · ' + e.message)
    } finally { running = false }
  }
  wc.once('did-finish-load', run)
  menu.push({ label: '重新检查本稿', click: run })
}

module.exports = { graphicPlatforms, graphicRoute, installGraphicEditor }
