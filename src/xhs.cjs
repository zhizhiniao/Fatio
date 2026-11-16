const origin = 'https://creator.xiaohongshu.com'
const manager = origin + '/new/note-manager'
const selfPath = '/api/galaxy/user/info'
const postedPath = '/api/galaxy/v2/creator/note/user/posted'
function payload(raw) {
  if (
    !raw ||
    raw.success === false ||
    (raw.code != null && Number(raw.code) !== 0) ||
    !raw.data ||
    typeof raw.data !== 'object'
  )
    throw Error('小红书创作服务平台未返回有效数据，请检查当前窗口登录状态')
  return raw.data
}
function profile(raw) {
  const d = payload(raw),
    uid = d.userId || d.user_id
  if (typeof uid !== 'string' || !/^[\da-f]{24}$/i.test(uid))
    throw Error('尚未读取到小红书登录身份')
  return {
    uid,
    handle: String(d.redId || d.red_id || ''),
    name: d.userName || d.user_name || d.nickname || '',
    avatarUrl: d.userAvatar || d.user_avatar || d.avatar || ''
  }
}
const count = (v) =>
  (typeof v === 'number' || typeof v === 'string') &&
  /^\d+$/.test(String(v)) &&
  Number.isSafeInteger(Number(v))
    ? Number(v)
    : null
function postedTime(value) {
  if (value == null) return null
  const n = count(value)
  if (n != null) return n > 1e11 ? Math.floor(n / 1000) : n
  if (typeof value !== 'string') return null
  const s = /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(value)
    ? value.replace(' ', 'T') + '+08:00'
    : value
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}
function notes(raw, uid, cursor) {
  const d = payload(raw)
  if (!Array.isArray(d.notes)) throw Error('小红书笔记列表结构未识别')
  const items = d.notes.map((n) => {
    const id = n.id
    if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))
      throw Error('小红书未提供可核对的笔记 ID')
    if ([n.user_id, n.author?.user_id, n.author?.userId].some((v) => v && String(v) !== uid))
      throw Error('笔记作者与绑定账号不符')
    const image = n.images_list?.[0]
    return {
      itemId: id,
      url: 'https://www.xiaohongshu.com/explore/' + id,
      title: String(n.display_title || n.title || ''),
      status: '已发布',
      publishedAt: postedTime(n.time || n.visible_time),
      coverUrl: String(typeof image === 'string' ? image : image?.url || image?.url_default || '')
        .replace(/^http:\/\//i, 'https://'),
      views: count(n.view_count),
      likes: count(n.likes),
      comments: count(n.comments_count),
      shares: count(n.shared_count),
      collects: count(n.collected_count)
    }
  })
  const next = count(d.page)
  return {
    items,
    next: items.length && next != null && next > Number(cursor) ? String(next) : null
  }
}
// Run on the platform origin so that only the selected account partition participates.
async function readOnCreator(path) {
  if (location.origin !== 'https://creator.xiaohongshu.com')
    throw Error('请在小红书创作服务平台完成登录')
  const r = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  })
  if (!r.ok) throw Error('小红书创作服务平台返回 HTTP ' + r.status)
  const body = await r.text()
  if (body.length > 4 * 1024 * 1024) throw Error('小红书单页数据过大')
  return JSON.parse(body)
}
function client(wc) {
  const read = (path) =>
    wc.executeJavaScript('(' + readOnCreator.toString() + ')(' + JSON.stringify(path) + ')')
  const self = async () => profile(await read(selfPath))
  return { self }
}
// Only the official page requests the published list. This also preserves the site's pagination.
function selectPublished(advance) {
  if (
    location.origin !== 'https://creator.xiaohongshu.com' ||
    location.pathname !== '/new/note-manager'
  )
    return
  const tabs = [...document.querySelectorAll('.tab-list .tab-item')].filter(
    (e) => e.textContent.trim() === '已发布'
  )
  if (tabs.length !== 1) return
  if (!tabs[0].classList.contains('tab-item--active')) {
    tabs[0].click()
    return
  }
  if (advance) {
    const area = document.querySelector('.content')
    if (area) {
      area.scrollTop = area.scrollHeight
      area.dispatchEvent(new Event('scroll'))
    }
  }
}
async function readPublished(win, account, pageWanted, itemId, validate) {
  if (!/^\d{1,8}$/.test(String(pageWanted))) throw Error('笔记页码无效')
  const wc = win.webContents,
    dbg = wc.debugger
  await win.loadURL('about:blank')
  dbg.attach('1.3')
  const pending = new Map(),
    pages = new Map()
  let self,
    fail,
    done,
    timer,
    tick,
    busy = false
  const result = new Promise((resolve, reject) => {
    done = resolve
    fail = reject
  })
  const onMessage = async (_, method, p) => {
    try {
      if (method === 'Network.responseReceived') {
        const u = new URL(p.response.url)
        if (u.origin !== origin || (p.type !== 'XHR' && p.type !== 'Fetch')) return
        const isSelf = u.pathname === selfPath,
          isList = u.pathname === postedPath && u.searchParams.get('tab') === '1'
        if (!isSelf && !isList) return
        if (p.response.status !== 200)
          throw Error('小红书创作服务平台返回 HTTP ' + p.response.status)
        pending.set(p.requestId, isSelf ? 'self' : u.searchParams.get('page'))
      } else if (method === 'Network.loadingFinished' && pending.has(p.requestId)) {
        const op = pending.get(p.requestId)
        pending.delete(p.requestId)
        if (p.encodedDataLength > 4e6) throw Error('小红书单页数据过大')
        const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', {
          requestId: p.requestId
        })
        if (body.length > 6e6) throw Error('小红书单页数据过大')
        const raw = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body)
        if (op === 'self') {
          const current = profile(raw)
          if (self && self.uid !== current.uid) throw Error('读取期间账号已切换')
          validate(current)
          self = current
        } else pages.set(String(op), raw)
        if (!self) return
        let cursor = '0'
        for (let i = 0; i < pages.size && pages.has(cursor); i++) {
          const parsed = notes(pages.get(cursor), self.uid, cursor)
          if (
            itemId ? parsed.items.some((w) => w.itemId === itemId) : String(pageWanted) === cursor
          ) {
            done({ user: self, page: parsed })
            return
          }
          if (!parsed.next) throw Error('已发布列表未返回指定笔记或页码，本次未写入')
          cursor = parsed.next
        }
      }
    } catch (e) {
      fail(e)
    }
  }
  try {
    dbg.on('message', onMessage)
    await dbg.sendCommand('Network.enable', { maxTotalBufferSize: 16000000 })
    await dbg.sendCommand('Network.setCacheDisabled', { cacheDisabled: true })
    timer = setTimeout(
      () => fail(Error('小红书笔记管理未返回已发布列表，请在账号后台核对登录状态')),
      27000
    )
    tick = setInterval(async () => {
      if (busy || wc.isDestroyed() || wc.getURL() !== manager) return
      busy = true
      try {
        await wc.executeJavaScript(
          '(' + selectPublished.toString() + ')(' + Boolean(pages.size) + ')'
        )
      } catch {
      } finally {
        busy = false
      }
    }, 350)
    void win.loadURL(manager).catch(fail)
    const value = await result
    if (wc.getURL() !== manager || (await client(wc).self()).uid !== value.user.uid)
      throw Error('读取笔记期间账号或页面已改变')
    validate(value.user)
    return value
  } finally {
    clearTimeout(timer)
    clearInterval(tick)
    dbg.removeListener('message', onMessage)
    if (dbg.isAttached()) dbg.detach()
  }
}
// The official home page signs its analytics request. Read that response in the bound session.
async function readAudience(win, uid) {
  const wc = win.webContents, dbg = wc.debugger
  const personal = '/api/galaxy/creator/home/personal_info'
  const report = '/api/galaxy/v2/creator/datacenter/account/base'
  const pending = new Map(), received = new Map()
  let finish, timeout
  const ready = new Promise(resolve => { finish = resolve })
  const listen = async (_, method, p) => {
    try {
      if (method === 'Network.responseReceived') {
        const url = new URL(p.response.url)
        if (url.origin === origin && [personal, report].includes(url.pathname) && p.response.status === 200)
          pending.set(p.requestId, url.pathname)
      } else if (method === 'Network.loadingFinished' && pending.has(p.requestId)) {
        if (p.encodedDataLength > 2e6) return
        const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', { requestId: p.requestId })
        if (body.length > 3e6) return
        received.set(pending.get(p.requestId), payload(JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString() : body)))
        if (received.size === 2) finish()
      }
    } catch { /* Missing analytics must not discard the published list. */ }
  }
  try {
    dbg.attach('1.3')
    dbg.on('message', listen)
    await dbg.sendCommand('Network.enable')
    timeout = setTimeout(finish, 8500)
    void win.loadURL(origin + '/new/home').catch(finish)
    await ready
    if (!received.size || (await client(wc).self()).uid !== uid) return null
    const daily = []
    for (const row of received.get(report)?.thirty?.net_rise_fans_count_list || []) {
      if (!Number.isSafeInteger(row.count) || !Number.isSafeInteger(row.date) || row.date < 1e12 || row.date > Date.now()) continue
      // The report timestamps designate midnight in the platform's UTC+8 calendar.
      daily.push({ day: new Date(row.date + 8 * 3600000).toISOString().slice(0, 10), change: row.count })
    }
    return { followers: count(received.get(personal)?.fans_count), daily }
  } finally {
    clearTimeout(timeout)
    dbg.removeListener('message', listen)
    if (dbg.isAttached()) dbg.detach()
  }
}
module.exports = { origin, manager, selfPath, postedPath, profile, notes, client, readPublished, readAudience }
