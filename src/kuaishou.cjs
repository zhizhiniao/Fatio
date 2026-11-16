const origin = 'https://cp.kuaishou.com'
const selfPath = '/rest/cp/creator/pc/home/userInfo'
function payload(raw) {
  if (raw?.result !== 1) throw Error('快手创作者后台尚未登录，或当前账号无权读取数据')
  return raw.data && typeof raw.data === 'object' ? raw.data : raw
}
function profile(raw) {
  const d = payload(raw).coreUserInfo || payload(raw)
  const uid = typeof d.userId === 'string' || Number.isSafeInteger(d.userId) ? String(d.userId) : ''
  if (!/^[1-9]\d*$/.test(uid) || !d.userName) throw Error('快手未返回可核对的账号 UID')
  return {
    uid,
    handle: String(d.userKwaiId || ''),
    name: d.userName,
    avatarUrl: d.headUrl || d.userAvatar || d.avatarUrl || '',
    followers: metric(d.fansNum ?? d.fansCnt)
  }
}
async function readCreator(path, body) {
  if (location.origin !== 'https://cp.kuaishou.com') throw Error('请在快手创作者服务平台完成登录')
  const r = await fetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(12000)
  })
  if (!r.ok) throw Error('快手创作服务平台返回 HTTP ' + r.status)
  const text = await r.text()
  if (text.length > 4 * 1024 * 1024) throw Error('快手单页数据过大')
  return JSON.parse(text, (_, v, c) =>
    typeof v === 'number' && !Number.isSafeInteger(v) && /^\d+$/.test(c?.source || '')
      ? c.source
      : v
  )
}
const listPath = '/rest/cp/works/v2/video/pc/photo/list'
function metric(v) {
  if (
    (typeof v !== 'string' && typeof v !== 'number') ||
    !/^\d+$/.test(String(v)) ||
    !Number.isSafeInteger(Number(v))
  )
    return null
  return Number(v)
}
function works(raw, uid) {
  const data = payload(raw)
  if (!Array.isArray(data.list)) throw Error('快手未返回已发布作品清单')
  const items = data.list.map((row) => {
    const id = String(row.workId ?? '')
    if (!/^[a-z0-9_-]{1,80}$/i.test(id)) throw Error('快手作品 ID 无法核对')
    if ([row.authorId, row.userId].some((v) => v != null && String(v) !== uid))
      throw Error('快手作品作者与当前账号不符')
    const t = metric(row.uploadTime)
    return {
      itemId: id,
      title: row.title || '',
      url: 'https://www.kuaishou.com/short-video/' + id,
      coverUrl: row.publishCoverUrl || '',
      status: '已发布',
      publishedAt: t == null ? null : t > 1e11 ? Math.floor(t / 1000) : t,
      views: metric(row.playCount ?? row.viewCount),
      likes: metric(row.likeCount),
      comments: metric(row.commentCount),
      shares: metric(row.shareCount),
      collects: metric(row.collectCount)
    }
  })
  const token = data.nextCursor
  return {
    items,
    next:
      items.length && token != null && token !== '' && String(token) !== 'no_more'
        ? String(token)
        : null
  }
}
function client(wc) {
  const read = (path, body) =>
    wc.executeJavaScript(
      '(' + readCreator.toString() + ')(' + JSON.stringify(path) + ',' + JSON.stringify(body) + ')'
    )
  const self = async () => profile(await read(selfPath, {}))
  return { self }
}
const manager = origin + '/article/manage/video?status=1'
async function readPublished(win, account, pageWanted, itemId, validate) {
  const wc = win.webContents,
    dbg = wc.debugger
  if (typeof pageWanted !== 'string' || pageWanted.length > 180) throw Error('快手分页游标无效')
  await Promise.race([
    win.loadURL(origin + '/profile'),
    new Promise((_, fail) => {
      const t = setTimeout(() => fail(Error('快手账号页加载超时')), 18000)
      t.unref()
    })
  ])
  const initial = await client(wc).self()
  validate(initial)
  dbg.attach('1.3')
  const pending = new Map(),
    pages = new Map(),
    permitted = new Map()
  let resolve, reject, timer, scroll
  const done = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  const onMessage = async (_, method, p) => {
    try {
      if (method === 'Network.requestWillBeSent') {
        const req = p.request
        if (
          req.method !== 'POST' ||
          new URL(req.url).origin !== origin ||
          new URL(req.url).pathname !== listPath
        )
          return
        const body = JSON.parse(req.postData || '{}')
        if (String(body.queryType) === '1') permitted.set(p.requestId, String(body.cursor))
      } else if (method === 'Network.responseReceived' && permitted.has(p.requestId)) {
        if (p.response.status !== 200) throw Error('快手作品后台返回 HTTP ' + p.response.status)
        pending.set(p.requestId, permitted.get(p.requestId))
      } else if (method === 'Network.loadingFinished' && pending.has(p.requestId)) {
        const cursor = pending.get(p.requestId)
        pending.delete(p.requestId)
        if (p.encodedDataLength > 4e6) throw Error('快手单页响应过大')
        const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', {
          requestId: p.requestId
        })
        if (body.length > 6e6) throw Error('快手单页响应过大')
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body
        pages.set(
          cursor,
          JSON.parse(text, (_, v, c) =>
            typeof v === 'number' && !Number.isSafeInteger(v) && /^\d+$/.test(c?.source || '')
              ? c.source
              : v
          )
        )
        const user = await client(wc).self()
        if (user.uid !== initial.uid) throw Error('快手账号已切换')
        validate(user)
        const page = works(pages.get(cursor), user.uid)
        if (
          itemId
            ? page.items.some((w) => w.itemId === itemId)
            : (pageWanted === '0' && pages.size === 1) || cursor === pageWanted
        ) {
          resolve({ user, page })
          return
        }
        if (!page.next || pages.has(page.next))
          throw Error('在快手作品管理的日期范围内未找到此作品或页码')
        if (scroll) clearInterval(scroll)
        scroll = setInterval(() => {
          if (!wc.isDestroyed())
            void wc
              .executeJavaScript(
                "(()=>{if(location.pathname!='/article/manage/video')return;const xs=[...document.querySelectorAll('main,.el-main,.page-content,.infinite-list,.content,div')].filter(e=>e.clientHeight>90&&e.scrollHeight>e.clientHeight&&/auto|scroll/.test(getComputedStyle(e).overflowY));for(const e of xs){e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'))}})()"
              )
              .catch(() => {})
        }, 550)
      }
    } catch (e) {
      reject(e)
    }
  }
  try {
    dbg.on('message', onMessage)
    await dbg.sendCommand('Network.enable', { maxTotalBufferSize: 16000000 })
    await dbg.sendCommand('Network.setCacheDisabled', { cacheDisabled: true })
    timer = setTimeout(
      () => reject(Error('快手作品管理未返回已发布列表，请核对该账号的登录状态')),
      24000
    )
    // The creator page obtains the list using its normal authenticated request.
    void win.loadURL(manager).catch(reject)
    const result = await done,
      here = new URL(wc.getURL())
    if (
      here.origin !== origin ||
      here.pathname !== '/article/manage/video' ||
      (await client(wc).self()).uid !== result.user.uid
    )
      throw Error('读取快手作品期间账号或页面已改变')
    validate(result.user)
    return result
  } finally {
    clearTimeout(timer)
    clearInterval(scroll)
    dbg.removeListener('message', onMessage)
    if (dbg.isAttached()) dbg.detach()
  }
}
module.exports = {
  origin,
  manager,
  selfPath,
  listPath,
  profile,
  payload,
  works,
  client,
  readPublished
}
