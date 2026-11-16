const path = require('node:path')
const {editorExpression} = require('./video-editor-dom.cjs')

// Runs inside the official new-post editor. All confirmation clicks are scoped
// to a recognized cover dialog that this handoff has supplied with an image.
function coverDom(root, platform, action, key, state) {
  const visible = n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden'
  const all = (scope, css) => [...scope.querySelectorAll(css)]
  const unique = nodes => nodes.length === 1 ? nodes[0] : null
  const leaf = nodes => unique(nodes.filter(n => !nodes.some(child => n !== child && n.contains(child))))
  const words = n => (n.innerText || '').trim()
  const controls = (scope, re) => leaf(all(scope,'button,[role=button],[role=tab],a,span,div')
    .filter(n => visible(n) && !n.disabled && n.getAttribute('aria-disabled') !== 'true' &&
      !(n.form && n.type === 'submit') && !n.closest('label') && !n.querySelector('input[type=file]') && re.test(words(n))))
  function activate(node, result) {
    if (platform !== 'douyin') { node.click(); return result }
    // Some Douyin cover controls require trusted pointer events. Check the
    // visible hit target before dispatch, including a possible tutorial overlay.
    node.scrollIntoView({block:'center',inline:'nearest'})
    const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
    const hit = root.elementFromPoint(x,y)
    if (!hit || !node.contains(hit) || hit.closest('button[type=submit],input[type=submit]')) return null
    return {point:{x,y}, result}
  }
  const dialogs = all(root,'[role=dialog],dialog[open],.ant-modal,.weui-desktop-dialog,.dy-creator-content-modal,.d-modal,.bcc-dialog,.bcc-modal')
    .filter(n => visible(n) && /封面|cover|个人主页卡片|分享卡片/i.test([n.getAttribute('aria-label'),words(n)].join(' ')))
  const crop = dialogs.find(n => /^(裁剪封面图|裁剪封面|Crop cover)$/i.test(
    n.querySelector('h2,h3,[role=heading],.weui-desktop-dialog__title')?.textContent.trim() || words(n).split('\n')[0]))
  const dialog = crop || leaf(dialogs)
  const slotSelector = key === 'wide' ? '.horizon-cover-wrap,.horizontal-cover-wrap' : '.vertical-cover-wrap'
  const entry = platform === 'channels' ? unique(all(root,slotSelector).filter(visible)) : null
  const tabs = dialog ? all(dialog,'button,[role=tab],span,div').filter(n => visible(n) && /^设置[横竖]封面$/.test(words(n))) : []
  const preview = entry ? [...all(entry,'img').map(i => i.currentSrc || i.src), ...all(entry,'[style]').map(n => n.style.backgroundImage)].filter(Boolean).join('|') : ''
  if (action === 'status') {
    if (dialogs.length && !dialog) return '等待封面弹窗'
    if (dialog) {
      if (all(dialog,'.uploading-status,.uploading-wrap,[aria-busy=true]').some(visible)) return '等待平台处理封面'
      const confirm = controls(dialog,/^(确定|确认|完成|保存|应用|Done|Save|Confirm)$/i)
      if (confirm && !confirm.closest('[class*="button-disabled"],[aria-disabled=true],button:disabled') && Date.now() - (state.lastClick || 0) > 1500) {
        return activate(confirm,crop ? '正在确认封面裁剪' : '正在确认封面')
      }
      return '等待平台处理封面'
    }
    if (state.preview !== null) return preview && preview !== state.preview ? 'done' : '等待平台更新封面预览'
    return state.confirmed ? 'done' : '封面弹窗已关闭，等待确认结果'
  }
  const markedScope = dialog || root
  const inputs = all(markedScope,'input[type=file]').filter(n => {
    const container = n.closest('[role=dialog],dialog,.ant-modal,.weui-desktop-dialog,.dy-creator-content-modal,.d-modal,.bcc-dialog,.bcc-modal')
    if (container && !visible(container)) return false
    if (n.disabled || /video|mp4/i.test(n.accept)) return false
    if (!/image|jpe?g|png|webp/i.test(n.accept) && !(dialog && n.closest('.single-cover-uploader-wrap'))) return false
    if (n.closest('[hidden],[aria-hidden=true]')) return false
    // A reference-image uploader is a different operation in Douyin's cover dialog.
    if (n.closest('.semi-upload') && !n.closest('.semi-upload')?.querySelector('.semi-upload-drag-area-main-text')) return false
    if (/replace/i.test(n.className) || n.closest('[class*=reference]')) return false
    return true
  })
  const matches = []
  for (const n of inputs) {
    let labels = [n.name,n.id,n.getAttribute('aria-label'),n.title,...Array.from(n.labels || [],l => l.innerText)]
    for (let e=n.parentElement, i=0; e && e!==root && e!==dialog && e.tagName!=='BODY' && i<4; i++,e=e.parentElement) {
      if (e.querySelectorAll('input[type=file]').length !== 1) break
      labels.push(e.className,e.innerText?.length < 90 ? e.innerText : '')
    }
    if (dialog) labels.push(dialog.getAttribute('aria-label'),dialog.querySelector('h2,h3,.weui-desktop-dialog__title')?.innerText)
    if (dialog && inputs.length === 1) labels.push('cover')
    const label = labels.join(' ')
    if (!/cover|poster|封面|个人主页卡片|分享卡片/i.test(label)) continue
    const wide = /横|宽屏|landscape|horizontal|wide|分享卡片|(?:16\s*[:：/]\s*(9|10)|4\s*[:：/]\s*3)/i.test(label)
    const portrait = /竖|纵|portrait|vertical|个人主页卡片|[39]\s*[:：/]\s*(?:4|16)/i.test(label)
    if (wide && portrait) continue
    const direction = wide ? 'wide' : portrait ? 'portrait' : null
    const scoped = dialog && state.opened && (entry || tabs.length)
    if (direction ? direction !== key : !scoped && !state.generic) continue
    matches.push({n,generic:!direction && !scoped})
  }
  const match = matches.length === 1 ? matches[0] : null
  if (action === 'input') return match?.n || null
  if (tabs.length && !state.tab) {
    const tab = controls(dialog,key === 'wide' ? /^设置横封面$/ : /^设置竖封面$/)
    if (tab) return activate(tab,{tab:true,opened:true})
  }
  if (match) return {input:true,generic:match.generic,dialog:!!dialog,preview:entry ? preview : null}
  if (dialog) {
    if (!state.local) {
      const local = controls(dialog,/^(上传封面|本地上传|自定义封面|上传图片|Upload cover|Upload photo)$/i)
      if (local) return activate(local,{local:true})
    }
    return {}
  }
  if (state.opened && platform === 'channels') {
    const edit = unique(all(root,'.img-recommend-wrap .btn-directly-edit').filter(visible))
    if (edit && words(edit) === '直接编辑') { edit.click(); return {} }
  }
  if (state.opened) return {}
  if (entry?.querySelector('.loading-wrap')) return {}
  let button = entry
  if (!button && platform === 'channels' && key === 'wide' && all(root,'.vertical-cover-wrap').some(visible)) return {unused:true}
  if (!button && platform === 'kuaishou') {
    const label = unique(all(root,'span').filter(n => visible(n) && words(n) === '封面设置'))
    button = label?.parentElement?.nextElementSibling?.querySelector('div') || null
  }
  if (!button && platform === 'xhs') button = unique(all(root,'.upload-cover,.cover-plugin-preview .default.pointer').filter(visible))
  if (!button) button = controls(root,/^(设置封面|编辑封面|选择封面|修改封面|编辑视频封面|更换封面|Edit cover)$/i)
  if (!button && platform === 'douyin') button = leaf(all(root,'[class*="cover-"]').filter(n =>
    visible(n) && n.querySelector('img') && !n.closest('label,button[type=submit]') && getComputedStyle(n).cursor === 'pointer'))
  if (button) return activate(button,{opened:true})
  return {}
}

async function advanceCover(wc, href, platform, key, file, state) {
  const expression = action => editorExpression(platform, href, coverDom, platform, action, key, state)
  const interact = async action => {
    const step = await wc.executeJavaScript(expression(action),true)
    if (!step?.point || wc.getURL() !== href) return step?.point ? null : step
    const dbg = wc.debugger, owns = !dbg.isAttached()
    if (owns) dbg.attach('1.3')
    try {
      for (const type of ['mousePressed','mouseReleased']) {
        if (wc.getURL() !== href) return null
        await dbg.sendCommand('Input.dispatchMouseEvent',{type,...step.point,button:'left',clickCount:1})
      }
      return step.result
    } finally { if (owns && dbg.isAttached()) dbg.detach() }
  }
  if (state.sent) {
    const status = await interact('status')
    if (status?.startsWith('正在确认封面')) state.lastClick = Date.now()
    if (status === '正在确认封面') state.confirmed = true
    if (status === 'done') state.done = true
    return status
  }
  const step = await interact('prepare')
  if (!step || wc.getURL() !== href) return
  if (step.unused) { state.unused = true; state.done = true; return }
  for (const flag of ['opened','tab','local']) if (step[flag]) state[flag] = true
  if (!step.input) return
  const dbg = wc.debugger, owns = !dbg.isAttached()
  if (owns) dbg.attach('1.3')
  let objectId
  try {
    objectId = (await dbg.sendCommand('Runtime.evaluate',{expression:expression('input')})).result.objectId
    if (!objectId || wc.getURL() !== href) return
    const names = async () => (await dbg.sendCommand('Runtime.callFunctionOn',{objectId,
      functionDeclaration:'function(){return this.isConnected ? Array.from(this.files, f=>f.name) : null}',returnByValue:true})).result.value
    const before = await names()
    if (!before) return
    if (before.length && (!state.recheck || before[0] !== path.basename(file))) throw Error('封面栏已有人选入图片，请在平台核对')
    if (wc.getURL() !== href) return
    if (!before.length) await dbg.sendCommand('DOM.setFileInputFiles',{objectId,files:[file]})
    state.sent = true
    state.single = step.generic
    state.preview = step.preview
    const after = await names()
    if (!step.dialog) {
      state.done = after?.[0] === path.basename(file)
      if (!state.done) state.unverified = true
    }
    return '封面已选入，等待平台回显'
  } finally {
    if (objectId) await dbg.sendCommand('Runtime.releaseObject',{objectId}).catch(()=>{})
    if (owns && dbg.isAttached()) dbg.detach()
  }
}
module.exports = { advanceCover }
