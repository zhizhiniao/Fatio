const origin = 'https://www.tiktok.com'
const manager = origin + '/tiktokstudio/content'
// Read only the signed-in user, never an author discovered on a public profile page.
async function loggedIn() {
  if (location.origin !== 'https://www.tiktok.com') throw Error('请在 TikTok Studio 中完成登录')
  const ctx = window.__Creator_Center_Context__,
    current = ctx?.commonAppContext?.user
  const r = await fetch('/passport/web/account/info/?aid=1459', {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(9000)
  })
  if (!r.ok) throw Error('TikTok 登录身份返回 HTTP ' + r.status)
  const j = await r.json()
  if (j.message !== 'success' || !j.data) throw Error('TikTok 尚未返回已登录身份')
  const d = j.data,
    uid = String(
      d.user_id_str ||
        d.uid_str ||
        (typeof d.user_id === 'string' || Number.isSafeInteger(d.user_id) ? d.user_id : '')
    )
  if (current?.uid != null && String(current.uid) !== uid)
    throw Error('TikTok 当前身份与作品管理页不符')
  const handle = String(current?.uniqueId || d.username || d.unique_id || '')
    .replace(/^@/, '')
    .toLowerCase()
  if (!/^[1-9]\d*$/.test(uid) || !/^[\w.]{1,24}$/.test(handle))
    throw Error('TikTok 未返回可核对的用户标识与用户名')
  return {
    uid,
    handle,
    name: current?.nickName || d.screen_name || d.nickname || handle,
    avatarUrl: current?.avatarThumb || d.avatar_url || ''
  }
}
function client(wc) {
  return { self: () => wc.executeJavaScript('(' + loggedIn.toString() + ')()') }
}
async function listPage(cursor) {
  if (
    location.origin !== 'https://www.tiktok.com' ||
    location.pathname.replace(/\/$/, '') !== '/tiktokstudio/content'
  )
    throw Error('请先在 TikTok Studio 完成登录')
  if (cursor === '0') {
    const ctx = window.__Creator_Center_Context__
    if (ctx?.firstBatchQueryItems) return ctx.firstBatchQueryItems
    const text = document.getElementById('__Creator_Center_Context__')?.textContent
    if (text) {
      const decoder = document.createElement('textarea')
      decoder.innerHTML = text
      const initial = JSON.parse(decoder.value).firstBatchQueryItems
      if (initial) return initial
    }
  }
  const result = await fetch('/tiktok/creator/manage/item_list/v1/', {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cursor: Number(cursor),
      size: cursor === '0' ? 50 : 10,
      query: { conditions: [], sort_orders: [] }
    }),
    signal: AbortSignal.timeout(12000)
  })
  if (!result.ok) throw Error('TikTok Studio 作品管理返回 HTTP ' + result.status)
  return result.json()
}
const count = (v) =>
  (typeof v === 'number' || typeof v === 'string') &&
  /^\d+$/.test(String(v)) &&
  Number.isSafeInteger(Number(v))
    ? Number(v)
    : null
function works(raw, user, cursor) {
  if (raw?.status_code !== 0 || !Array.isArray(raw.item_list))
    throw Error('TikTok 未返回当前账号的作品列表，请检查 Studio 登录状态')
  const items = []
  for (const row of raw.item_list) {
    const privatePost = row.status === 144 && row.visibility === 2 && row.in_review === false
    if (
      (!privatePost && row.status !== 102) ||
      row.async_post ||
      row.in_review ||
      (count(row.post_time) || 0) > Date.now() / 1000
    )
      continue
    const id = row.item_id
    if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) throw Error('TikTok 作品编号未能核对')
    if (row.author_id != null && String(row.author_id) !== user.uid)
      throw Error('TikTok 作品作者与当前账号不符')
    const type = row.photo_list?.length ? 'photo' : 'video'
    items.push({
      itemId: id,
      title: row.desc || '',
      url: origin + '/@' + user.handle + '/' + type + '/' + id,
      coverUrl: row.cover_url?.[0] || '',
      status: row.visibility === 2 ? '仅自己可见' : row.visibility === 3 ? '仅好友可见' : '已发布',
      publishedAt: count(row.create_time),
      views: count(row.play_count),
      likes: count(row.like_count),
      comments: count(row.comment_count),
      shares: count(row.share_count),
      collects: count(row.favorite_count ?? row.collect_count)
    })
  }
  const next = raw.has_more ? String(raw.cursor) : null
  if (next && (count(next) === null || next === cursor)) throw Error('TikTok 返回的作品游标无效')
  return { items, next }
}
async function readPublished(win, account, cursor, itemId, validate) {
  if (count(cursor) === null) throw Error('TikTok 作品游标无效')
  const wc = win.webContents
  let timeout
  try {
    await Promise.race([
      win.loadURL(manager),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error('TikTok Studio 加载超时')), 20000)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
  const originUser = await client(wc).self()
  validate(originUser)
  const visited = new Set()
  do {
    visited.add(cursor)
    const raw = await wc.executeJavaScript(
      '(' + listPage.toString() + ')(' + JSON.stringify(cursor) + ')'
    )
    const page = works(raw, originUser, cursor)
    if (!itemId || page.items.some((w) => w.itemId === itemId)) {
      const user = await client(wc).self()
      if (user.uid !== originUser.uid) throw Error('TikTok 账号已切换')
      validate(user)
      return { user, page }
    }
    cursor = page.next
  } while (cursor && !visited.has(cursor) && visited.size < 100)
  throw Error('没有在该账号的已发布作品中找到此作品')
}
module.exports = { origin, manager, client, readPublished, works }
