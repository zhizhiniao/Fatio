const origin = 'https://mp.weixin.qq.com'
function currentAccount() {
  if (location.origin !== 'https://mp.weixin.qq.com' || !location.pathname.startsWith('/cgi-bin/'))
    throw Error('请在微信公众平台完成登录')
  const common = window.wx?.commonData,
    data = common?.data || common
  const uid = String(data?.uin || common?.uin || ''),
    name = data?.nick_name_decode || data?.nick_name
  if (
    !/^[1-9]\d+$/.test(uid) ||
    !name ||
    !/^\d+$/.test(new URL(location.href).searchParams.get('token') || '')
  )
    throw Error('尚未取得已登录公众号的账号标识与昵称')
  const followers = window.wx?.cgiData?.total_friend_cnt
  const avatar = String(data.head_img || data.head_url || '').replace(/^(?:http:)?\/\//, 'https://')
  return {
    uid,
    name,
    handle: data.user_name || uid,
    avatarUrl: avatar,
    followers: /^\d+$/.test(String(followers)) ? Number(followers) : null
  }
}
function client(wc) {
  return { self: () => wc.executeJavaScript('(' + currentAccount.toString() + ')()') }
}
function managerUrl(begin) {
  const nav = [...document.querySelectorAll('a[href]')].find(
    (a) => a.textContent.trim() === '发表记录'
  )
  if (!nav) throw Error('未找到微信公众平台的发表记录入口')
  const url = new URL(nav.href)
  if (
    url.origin !== location.origin ||
    url.pathname !== '/cgi-bin/appmsgpublish' ||
    url.searchParams.get('sub') !== 'list'
  )
    throw Error('公众号发表记录入口不符')
  url.searchParams.set('begin', String(begin))
  return url.href
}
function publishedPage(begin) {
  if (
    location.origin !== 'https://mp.weixin.qq.com' ||
    location.pathname !== '/cgi-bin/appmsgpublish' ||
    Number(new URL(location.href).searchParams.get('begin')) !== begin
  )
    throw Error('公众号发表记录页已改变')
  const data = window.wx?.cgiData
  if (!Array.isArray(data?.publish_list) || !/^\d+$/.test(String(data.total_count))) return null
  const titles = [...document.querySelectorAll('a.weui-desktop-mass-appmsg__title[href]')]
  const items = []
  const number = (v) =>
    /^(?:0|[1-9]\d*)$/.test(String(v ?? '').trim()) && Number.isSafeInteger(Number(v))
      ? Number(v)
      : null
  const metric = (el, q) => {
    const n = el.querySelector(q)
    return n ? number(n.innerText.trim().replace(/,/g, '')) : null
  }
  const groups = [...document.querySelectorAll('.publish_hover_content')]
  if (groups.length !== data.publish_list.length) return null
  for (const title of titles) {
    const card = title.closest('.weui-desktop-mass-media'),
      group = title.closest('.publish_hover_content')
    if (!card || !group) return null
    const g = data.publish_list[groups.indexOf(group)]
    const status = group.querySelector('.weui-desktop-mass__status_text')?.innerText.trim()
    if (!status) return null
    if (status !== '已发表' || g?.sent_result?.msg_status !== 2) continue
    const url = new URL(title.href)
    if (
      url.origin !== location.origin ||
      !(url.pathname === '/s' || /^\/s\/[\w-]+$/.test(url.pathname))
    )
      continue
    const thumb = card.querySelector('.weui-desktop-mass-appmsg__thumb')
    const background = thumb ? getComputedStyle(thumb).backgroundImage : ''
    const cover =
      card.querySelector(
        '.weui-desktop-mass-appmsg__thumb img,img.weui-desktop-mass-appmsg__thumb,.weui-desktop-mass-appmsg__cover img'
      )?.src ||
      /^url\(["']?(.*?)["']?\)$/.exec(background)?.[1] ||
      ''
    items.push({
      url: url.href,
      title: title.querySelector(':scope > span')?.textContent.trim() || title.innerText.trim(),
      status,
      coverUrl: cover.replace(/^(?:http:)?\/\//, 'https://'),
      publishedAt: number(g.sent_info?.time),
      views: metric(card, '.appmsg-view .weui-desktop-mass-media__data__inner'),
      likes: metric(card, '.appmsg-like .weui-desktop-mass-media__data__inner'),
      comments: metric(card, '.js_comment_info'),
      shares: metric(card, '.appmsg-share .weui-desktop-mass-media__data__inner'),
      collects: null
    })
  }
  const offset = begin + data.publish_list.length
  if (!data.publish_list.length && offset < Number(data.total_count))
    throw Error('公众号发表记录分页未推进')
  return { items, next: offset < Number(data.total_count) ? String(offset) : null }
}
async function readPublished(win, account, cursor, itemId, validate) {
  if (!/^\d{1,8}$/.test(String(cursor))) throw Error('公众号分页位置无效')
  const wc = win.webContents
  let timeout
  const read = async () => {
    await win.loadURL(origin + '/')
    const user = await client(wc).self()
    validate(user)
    let begin = Number(cursor)
    const template = await wc.executeJavaScript('(' + managerUrl.toString() + ')(' + begin + ')')
    do {
      const url = new URL(template)
      url.searchParams.set('begin', String(begin))
      await win.loadURL(url.href)
      let page
      for (let i = 0; i < 30 && !page; i++) {
        page = await wc.executeJavaScript('(' + publishedPage.toString() + ')(' + begin + ')')
        if (!page) await new Promise((r) => setTimeout(r, 160))
      }
      if (!page) throw Error('公众号没有返回可核对的发表记录，请检查后台登录')
      const confirmed = await client(wc).self()
      if (user.uid !== confirmed.uid) throw Error('读取期间公众号账号已切换')
      validate(confirmed)
      for (const item of page.items) {
        item.url = require('./platforms.cjs').receiptUrl(account, item.url)
        item.itemId = item.url
      }
      if (!itemId || page.items.some((w) => w.itemId === itemId)) return { user: confirmed, page }
      if (!page.next) break
      begin = Number(page.next)
    } while (!wc.isDestroyed())
    throw Error('公众号已发表文章中没有这条链接')
  }
  try {
    return await Promise.race([
      read(),
      new Promise((_, fail) => {
        timeout = setTimeout(() => fail(Error('读取微信公众号发表记录超时')), 60000)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}
function enterEditor(kind = '文章') {
  if (location.origin !== 'https://mp.weixin.qq.com' || location.pathname !== '/cgi-bin/home')
    return false
  const options = [...document.querySelectorAll('.new-creation__menu-item')].filter(
    (e) => e.querySelector('.new-creation__menu-title')?.textContent.trim() === kind
  )
  if (options.length !== 1) return false
  options[0].click()
  return true
}
module.exports = { origin, client, readPublished, enterEditor }
