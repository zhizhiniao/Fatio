const origin = 'https://member.bilibili.com'
async function request(session, url) {
  const r = await session.fetch(url, {
    credentials: 'include',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(12000)
  })
  if (!r.ok) throw Error('B站创作中心返回 HTTP ' + r.status)
  const raw = await r.text()
  if (raw.length > 6 * 1024 * 1024) throw Error('B站单页数据过大')
  const result = JSON.parse(raw)
  if (result.code !== 0 || !result.data)
    throw Error('B站尚未登录或无权读取创作中心数据（' + result.code + '）')
  return result.data
}
function client(wc) {
  return {
    self: async () => {
      const d = await request(wc.session, 'https://api.bilibili.com/x/web-interface/nav')
      if (
        !d.isLogin ||
        !(typeof d.mid === 'string' || Number.isSafeInteger(d.mid)) ||
        !/^[1-9]\d*$/.test(String(d.mid)) ||
        !d.uname
      )
        throw Error('尚未核对到已登录的B站账号')
      return {
        uid: String(d.mid),
        name: d.uname,
        handle: String(d.mid),
        avatarUrl: String(d.face || '').replace(/^http:/, 'https:')
      }
    }
  }
}
const manager = origin + '/platform/upload-manager/article'
const count = (v) =>
  (typeof v === 'number' || typeof v === 'string') &&
  /^\d+$/.test(String(v)) &&
  Number.isSafeInteger(Number(v))
    ? Number(v)
    : null
function archives(data, user) {
  if (!Array.isArray(data.arc_audits)) throw Error('B站稿件管理未返回视频清单')
  const items = []
  for (const row of data.arc_audits) {
    const a = row.Archive || row.archive
    if (!a) throw Error('B站视频稿件结构未识别')
    if (a.mid != null && String(a.mid) !== user.uid) throw Error('B站稿件作者与当前账号不符')
    if (a.state !== 0) continue
    const id = a.bvid || row.bvid
    if (typeof id !== 'string' || !/^BV[0-9A-Za-z]+$/.test(id))
      throw Error('B站已发布稿件缺少 BV 号')
    const stat = row.stat || row.Stat || {}
    items.push({
      itemId: id,
      title: a.title,
      url: 'https://www.bilibili.com/video/' + id,
      coverUrl: String(a.cover || '').replace(/^http:/, 'https:'),
      status: '已发布',
      publishedAt: count(a.pubtime ?? a.ptime ?? a.ctime),
      views: count(stat.view),
      likes: count(stat.like),
      comments: count(stat.reply),
      shares: count(stat.share),
      collects: count(stat.favorite)
    })
  }
  const p = data.page
  if (!p || count(p.pn) === null || !count(p.ps) || count(p.count) === null)
    throw Error('B站稿件页码未能核对')
  return {
    items,
    next: Number(p.pn) * Number(p.ps) < Number(p.count) ? String(Number(p.pn) + 1) : null
  }
}
async function readPublished(win, account, cursor, itemId, validate) {
  if (!/^\d{1,8}$/.test(String(cursor))) throw Error('B站页码无效')
  const wc = win.webContents,
    accountClient = client(wc)
  const user = await accountClient.self()
  validate(user)
  if (/^cv[1-9]\d*$/.test(itemId || '')) {
    const data = await request(
      wc.session,
      'https://api.bilibili.com/x/article/viewinfo?id=' + itemId.slice(2)
    )
    if (String(data.mid) !== user.uid) throw Error('B站专栏作者与当前账号不符')
    const confirmed = await accountClient.self()
    if (confirmed.uid !== user.uid) throw Error('B站账号已切换')
    validate(confirmed)
    const stat = data.stats || {}
    return {
      user: confirmed,
      page: {
        next: null,
        items: [
          {
            itemId,
            title: data.title || '',
            url: 'https://www.bilibili.com/read/' + itemId,
            status: '已发布',
            views: count(stat.view),
            likes: count(stat.like),
            comments: count(stat.reply),
            shares: count(stat.share),
            collects: count(stat.favorite)
          }
        ]
      }
    }
  }
  let pageNo = Number(cursor) || 1
  do {
    const query = new URLSearchParams({ status: 'pubed', pn: String(pageNo), ps: '30' })
    const data = await request(wc.session, origin + '/x/web/archives?' + query)
    const page = archives(data, user)
    if (!itemId || page.items.some((w) => w.itemId === itemId)) {
      const confirmed = await accountClient.self()
      if (confirmed.uid !== user.uid) throw Error('B站账号已切换')
      validate(confirmed)
      return { user: confirmed, page }
    }
    if (!page.next || Number(page.next) <= pageNo)
      throw Error('没有在该账号的已发布视频中找到此作品')
    pageNo = Number(page.next)
  } while (pageNo <= 10000)
  throw Error('超出单次核对范围，请在稿件管理中查看此作品')
}
module.exports = { origin, manager, client, readPublished, archives }
