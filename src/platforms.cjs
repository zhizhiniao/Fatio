const twitterText = require('twitter-text')
const { platforms } = require('./catalog.cjs')

// Adapted from 禾高子 / WeSight x-post-content.ts. See NOTICE.
function xPostTextError(text) {
  const parsed = twitterText.parseTweet(text)
  if (parsed.weightedLength > 280)
    return 'X 超过 280 加权字符，当前 ' + parsed.weightedLength + '。请编辑 X 专用文案。'
  return parsed.valid ? null : 'X 文案为空或含无效字符'
}
function accountInput(input) {
  const { platform, mode } = input
  if (!Object.hasOwn(platforms, platform)) throw Error('请选择平台')
  const name = String(input.name || '').trim()
  if (!name || name.length > 64) throw Error('账号名称需在 1 至 64 字之间')
  let identity = String(input.identity || '').trim()
  if (platform === 'x') {
    identity = identity.replace(/^@/, '').toLowerCase()
    if (!/^[a-z0-9_]{1,15}$/.test(identity)) throw Error('请输入 X 的 @用户名')
  } else if (platform === 'xiaobot') {
    if (identity.startsWith('https://')) {
      let url
      try {
        url = new URL(identity)
      } catch {
        throw Error('小报童专栏链接无效')
      }
      const match = url.pathname.match(/^\/(?:p|creator)\/([\w-]+)\/?$/)
      if (url.origin !== 'https://xiaobot.net' || url.username || url.password || !match)
        throw Error('请输入小报童专栏链接')
      identity = match[1]
    }
    if (!/^[\w-]{1,80}$/.test(identity) || /^(login|creator)$/i.test(identity))
      throw Error('请输入专栏链接或专栏 ID')
  } else if (platform === 'weibo' || platform === 'bilibili') {
    if (!/^\d{1,25}$/.test(identity)) throw Error('请输入个人主页中的数字 UID')
  } else if (platform === 'tiktok') {
    identity = identity.replace(/^@/, '').toLowerCase()
    if (!/^[a-z0-9._]{1,24}$/.test(identity)) throw Error('请输入 TikTok 用户名')
  } else if (platform === 'channels') {
    if (!/^[\p{L}\p{N}_.@-]{1,256}$/u.test(identity)) throw Error('请输入视频号账号或唯一标识')
  } else if (!/^[\p{L}\p{N}_.@-]{1,80}$/u.test(identity)) throw Error('请输入目标账号的唯一标识')
  if (
    mode !== 'web' &&
    !(platform === 'x' && mode === 'api') &&
    !(mode === 'creatorhub' && ['douyin', 'kuaishou', 'xhs', 'channels'].includes(platform))
  )
    throw Error('账号发布方式无效')
  return { platform, mode, name, identity }
}
function bodyFor(draft, account) {
  const override = draft.variants?.[account.platform]
  const value = (
    account.platform === 'x'
      ? draft.xText.trim() || draft.body.trim()
      : override?.body.trim() || draft.body.trim()
  ).normalize('NFC')
  if (!value && draft.kind !== 'video') throw Error('请填写正文')
  if (account.platform === 'x') {
    const issue = xPostTextError(value)
    if (issue) throw Error(issue)
  }
  return {
    title: account.platform === 'x' ? '' : override?.title.trim() || draft.title.trim(),
    body: value
  }
}
function allowedPage(platform, raw) {
  try {
    const u = new URL(raw)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      platforms[platform].domains.some(
        (domain) => u.hostname === domain || u.hostname.endsWith('.' + domain)
      )
    )
  } catch {
    return false
  }
}
function receiptUrl(account, raw) {
  const value = String(raw || '').trim()
  let u
  try {
    u = new URL(value)
  } catch {
    throw Error('请输入作品的完整 HTTPS 链接')
  }
  const allowed = allowedPage(account.platform, value)
  const path = u.pathname
  const ok = {
    x:
      /^(?:x\.com|www\.x\.com|twitter\.com|www\.twitter\.com)$/.test(u.hostname) &&
      new RegExp('^/' + account.identity + '/status/[1-9]\\d*/?$', 'i').test(path),
    xiaobot: u.hostname === 'xiaobot.net' && /^\/post\/(?:detail\/)?[a-zA-Z0-9_-]+\/?$/.test(path),
    douyin:
      ['www.douyin.com', 'douyin.com'].includes(u.hostname) &&
      /^\/(?:video|note)\/\d+\/?$/.test(path),
    kuaishou:
      ['www.kuaishou.com', 'kuaishou.com'].includes(u.hostname) &&
      /^\/(?:short-video|photo)\/[\w-]+\/?$/.test(path),
    bilibili:
      ['www.bilibili.com', 'bilibili.com'].includes(u.hostname) &&
      /^\/(?:video\/(?:BV[0-9A-Za-z]+|av\d+)|read\/cv\d+)\/?$/.test(path),
    tiktok:
      u.hostname === 'www.tiktok.com' &&
      path.toLowerCase().startsWith('/@' + account.identity + '/') &&
      /^\/@[\w.]+\/(?:video|photo)\/[1-9]\d*\/?$/.test(path),
    xhs:
      ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(u.hostname) &&
      /^\/(?:explore|discovery\/item)\/[0-9a-f]+\/?$/i.test(path),
    channels:
      (u.hostname === 'weixin.qq.com' && /^\/sph\/[\w-]+\/?$/.test(path)) ||
      (u.hostname === 'channels.weixin.qq.com' &&
        path === '/platform/post/list' &&
        /^[\w+/=-]{1,256}$/.test(u.searchParams.get('objectId') || '')),
    wechat:
      u.hostname === 'mp.weixin.qq.com' &&
      (/^\/s\/[\w-]+\/?$/.test(path) ||
        (path === '/s' && ['__biz', 'mid', 'idx', 'sn'].every((k) => u.searchParams.get(k)))),
    toutiao:
      ['www.toutiao.com', 'toutiao.com'].includes(u.hostname) && /^\/article\/\d+\/?$/.test(path),
    zhihu: u.hostname === 'zhuanlan.zhihu.com' && /^\/p\/\d+\/?$/.test(path),
    weibo:
      /^(?:www\.)?weibo\.com$/.test(u.hostname) &&
      path.startsWith('/' + account.identity + '/') &&
      /^\/\d+\/[a-zA-Z0-9]+\/?$/.test(path)
  }
  if (!allowed || !ok[account.platform]) throw Error('链接与目标平台、账号或作品格式不符')
  if (account.platform === 'channels' && u.hostname === 'channels.weixin.qq.com')
    return u.origin + path + '?objectId=' + encodeURIComponent(u.searchParams.get('objectId'))
  if (account.platform === 'wechat' && path === '/s')
    return (
      u.origin +
      path +
      '?' +
      new URLSearchParams(
        ['__biz', 'mid', 'idx', 'sn'].map((k) => [k, u.searchParams.get(k)])
      ).toString()
    )
  if (account.platform === 'xhs' && u.searchParams.get('xsec_token'))
    return (
      u.origin +
      path +
      '?' +
      new URLSearchParams(
        [...u.searchParams].filter(([k]) => ['xsec_token', 'xsec_source'].includes(k))
      ).toString()
    )
  return u.origin + path
}
function editorUrl(account, kind = 'article') {
  if (account.platform === 'xiaobot')
    return platforms.xiaobot.home + '/' + account.identity + '/edit'
  if (account.platform === 'x') return 'https://x.com/compose/post'
  return platforms[account.platform][kind]
}
module.exports = {
  platforms,
  accountInput,
  bodyFor,
  xPostTextError,
  receiptUrl,
  allowedPage,
  editorUrl
}
