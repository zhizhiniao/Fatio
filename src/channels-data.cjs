const origin = 'https://channels.weixin.qq.com'
const management = origin + '/platform/post/list'
function kind(raw) {
  try {
    const u = new URL(raw)
    if (u.origin !== origin) return null
    if (/\/mmfinderassistant-bin\/auth\/(?:auth_data|get_auth_info)\/?$/.test(u.pathname))
      return 'self'
    if (/\/mmfinderassistant-bin\/post\/post_list\/?$/.test(u.pathname)) return 'works'
  } catch {}
  return null
}
function payload(raw) {
  if (
    !raw ||
    ![raw.errCode, raw.errcode, raw.baseResp?.ret, raw.code].every(
      (code) => code == null || Number(code) === 0
    )
  )
    throw Error('视频号会话无效或无权读取作品，请在官方后台登录')
  return raw.data || raw
}
function identity(raw) {
  const data = payload(raw),
    f = data.finderUser || data.finder || data.finderInfo || data
  const uid = f.finderUsername || f.username || f.finderUserName || f.userName
  if (typeof uid !== 'string' || !uid.trim()) throw Error('官方后台没有提供稳定的视频号身份')
  return {
    uid,
    alias: f.alias || f.finderAlias || f.finderAliasName,
    name: f.nickname || f.nickName || '',
    avatarUrl: f.headImgUrl || f.headUrl || ''
  }
}
function items(raw, account) {
  const data = payload(raw),
    list =
      data.list ?? data.post_list ?? data.object_list ?? data.objectList ?? data.feeds ?? data.posts
  if (!Array.isArray(list)) throw Error('视频号作品列表格式未识别')
  const count = (v) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
      ? v
      : typeof v === 'string' && /^\d+$/.test(v) && Number.isSafeInteger(Number(v))
        ? Number(v)
        : null
  return list.map((row) => {
    const rawId = row.objectId || row.id || row.exportId
    if (typeof rawId !== 'string' && !Number.isSafeInteger(rawId))
      throw Error('视频号作品编号精度不足')
    const itemId = String(rawId)
    if (!/^[\w+/=-]{1,256}$/.test(itemId)) throw Error('未识别的视频号作品 ID')
    if ([row.finderUsername, row.finderUserName].some((v) => v && v !== account.uid))
      throw Error('视频号作品作者不匹配')
    const time = count(row.createtime ?? row.createTime)
    return {
      itemId,
      title: String(
        row.desc?.description || row.objectDesc?.description || row.description || row.title || ''
      ),
      coverUrl: row.desc?.media?.[0]?.thumbUrl || row.thumbUrl || '',
      url: management + '?objectId=' + encodeURIComponent(itemId),
      status: '官方作品列表',
      publishedAt: time > 1e12 ? Math.floor(time / 1000) : time,
      views: count(row.readCount ?? row.playCount),
      likes: count(row.likeCount),
      comments: count(row.commentCount),
      collects: count(row.favCount),
      shares: count(row.forwardCount ?? row.shareCount)
    }
  })
}
function parse(raw) {
  return JSON.parse(raw, (_, v, ctx) =>
    typeof v === 'number' && !Number.isSafeInteger(v) && /^\d{16,}$/.test(ctx?.source || '')
      ? ctx.source
      : v
  )
}
async function accountResponse() {
  if (location.origin !== 'https://channels.weixin.qq.com') throw Error('请先在视频号助手登录')
  if (
    location.pathname.startsWith('/platform') &&
    typeof window._store?.userStore?.getAuthData === 'function'
  ) {
    return window._store.userStore.getAuthData()
  }
  if (location.pathname === '/login.html') throw Error('请在官方窗口完成视频号登录')
  const r = await fetch('/cgi-bin/mmfinderassistant-bin/auth/auth_data', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(9000)
  })
  if (!r.ok) throw Error('视频号助手返回 HTTP ' + r.status)
  return r.json()
}
function client(wc) {
  return {
    self: async () => {
      const profile = identity(await wc.executeJavaScript('(' + accountResponse.toString() + ')()'))
      return { ...profile, handle: profile.alias || profile.uid }
    }
  }
}
async function originPage(page) {
  if (
    location.origin !== 'https://channels.weixin.qq.com' ||
    location.pathname !== '/platform/post/list'
  )
    throw Error('请在视频号助手中完成登录')
  const store = window._store?.postStore
  if (typeof store?.changePageAsync !== 'function') throw Error('视频号作品管理页尚未就绪')
  await store.changePageAsync(page)
  return store.pageSize
}
async function readPage(wc, requested) {
  const debug = wc.debugger,
    requests = new Map()
  let resolve, reject, timer
  const response = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  const listen = async (_, method, p) => {
    try {
      if (method === 'Network.requestWillBeSent' && kind(p.request.url) === 'works') {
        const body = JSON.parse(p.request.postData || '{}')
        if (body.currentPage == null || Number(body.currentPage) === requested)
          requests.set(p.requestId, false)
      } else if (method === 'Network.responseReceived' && requests.has(p.requestId)) {
        if (p.response.status < 200 || p.response.status >= 300)
          throw Error('视频号作品后台返回 HTTP ' + p.response.status)
        requests.set(p.requestId, true)
      } else if (method === 'Network.loadingFinished' && requests.get(p.requestId)) {
        if (p.encodedDataLength > 8e6) throw Error('视频号响应过大')
        const r = await debug.sendCommand('Network.getResponseBody', { requestId: p.requestId })
        if (r.body.length > 12e6) throw Error('视频号响应过大')
        resolve(parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body))
      }
    } catch (e) {
      reject(e)
    }
  }
  debug.on('message', listen)
  try {
    timer = setTimeout(() => reject(Error('视频号官方作品列表未返回，请检查登录状态')), 20000)
    const [raw, size] = await Promise.all([
      response,
      wc.executeJavaScript('(' + originPage.toString() + ')(' + requested + ')')
    ])
    const total = Number(payload(raw).totalCount)
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(size) || size < 1)
      throw Error('视频号作品页码未能核对')
    return { raw, next: requested * size < total ? String(requested + 1) : null }
  } finally {
    clearTimeout(timer)
    debug.removeListener('message', listen)
  }
}
async function readPublished(win, account, cursor, itemId, validate) {
  if (!/^\d{1,7}$/.test(String(cursor))) throw Error('视频号页码无效')
  const wc = win.webContents
  await win.loadURL(management)
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await wc
      .executeJavaScript(
        "!!window._store?.postStore?.changePageAsync && location.pathname==='/platform/post/list'"
      )
      .catch(() => false)
    if (!ready) await new Promise((r) => setTimeout(r, 150))
  }
  if (!ready) throw Error('请先在发条 Fatio 的视频号助手窗口登录')
  const signed = client(wc),
    user = await signed.self()
  validate(user)
  await wc.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 16000000 })
  let page = Number(cursor) || 1
  do {
    const result = await readPage(wc, page),
      rows = items(result.raw, user)
    const confirmed = await signed.self()
    if (confirmed.uid !== user.uid) throw Error('读取作品期间视频号账号已切换')
    validate(confirmed)
    if (!itemId || rows.some((w) => w.itemId === itemId))
      return { user: confirmed, page: { items: rows, next: result.next } }
    if (!result.next) break
    page = Number(result.next)
  } while (page < 10000)
  throw Error('本人视频号的作品列表中没有这条作品')
}
module.exports = { origin, management, client, readPublished, items, identity, kind }
