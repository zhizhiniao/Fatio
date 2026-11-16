const { receiptUrl } = require('./platforms.cjs')
const { parse } = require('csv-parse/sync')
function count(v) {
  return (typeof v === 'number' || typeof v === 'string') &&
    /^\d+$/.test(String(v)) &&
    Number.isSafeInteger(Number(v))
    ? Number(v)
    : null
}
async function bilibili(a, raw, request = fetch) {
  const url = receiptUrl(a, raw),
    match = new URL(url).pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)\/?$/)
  if (!match) throw Error('请输入 B站视频的 BV 或 av 作品链接')
  const param = match[1].startsWith('BV') ? 'bvid=' + match[1] : 'aid=' + match[1].slice(2)
  const response = await request('https://api.bilibili.com/x/web-interface/view?' + param, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Referer: 'https://www.bilibili.com/' }
  })
  if (!response.ok) throw Error('B站作品查询返回 HTTP ' + response.status)
  const json = await response.json(),
    d = json.data
  if (json.code !== 0 || !d?.stat) throw Error('B站未返回该公开视频：' + String(json.code))
  if (String(d.owner?.mid) !== a.identity) throw Error('B站作品的 UP 主 UID 与目标账号不符')
  if (match[1] !== d.bvid && match[1] !== 'av' + d.aid) throw Error('B站回传的作品 ID 不匹配')
  if (!/^BV[a-zA-Z0-9]+$/.test(d.bvid)) throw Error('B站作品编号无效')
  return {
    itemId: d.bvid,
    profile: { uid: String(d.owner.mid), name: d.owner.name, avatarUrl: d.owner.face },
    coverUrl: d.pic,
    url: 'https://www.bilibili.com/video/' + d.bvid,
    title: d.title,
    status: '已发布',
    publishedAt: count(d.pubdate),
    views: count(d.stat.view),
    likes: count(d.stat.like),
    comments: count(d.stat.reply),
    shares: count(d.stat.share),
    collects: count(d.stat.favorite)
  }
}
// Non-Douyin platforms can also import a dated, account-scoped export. A file is never platform-verified evidence.
function reportItems(a, bytes) {
  if (bytes.length > 32 * 1024 * 1024) throw Error('作品报表超过 32 MB')
  let raw
  try {
    raw = new TextDecoder('utf8', { fatal: true }).decode(bytes)
  } catch {
    raw = new TextDecoder('gb18030').decode(bytes)
  }
  const rows = parse(raw, { bom: true, skip_empty_lines: true, trim: true })
  const head = rows.shift() || []
  const field = (names, mandatory = false) => {
    const index = names.map((n) => head.indexOf(n)).find((i) => i >= 0)
    if (index === undefined && mandatory) throw Error('作品报表缺列：' + names[0])
    return index
  }
  const link = field(['作品链接', '视频链接', '链接', 'Video link', 'Video URL'], true),
    account = field(['账号标识', '账号ID', 'UID', 'Username', 'Account ID'], true),
    title = field(['作品标题', '标题', 'Video title']),
    time = field(['采样时间', '统计时间', '更新时间', 'Snapshot time'], true)
  const columns = {
    views: field(['播放量', '播放', 'Video views', 'Views']),
    likes: field(['点赞', '点赞量', 'Likes']),
    comments: field(['评论', '评论数', 'Comments']),
    shares: field(['分享', '分享数', 'Shares']),
    collects: field(['收藏', '收藏数', 'Favorites'])
  }
  if (Object.values(columns).every((i) => i === undefined))
    throw Error('报表没有可识别的作品指标列')
  return rows.map((r) => {
    if (r[account]?.replace(/^@/, '') !== a.identity) throw Error('报表含有其他账号的数据')
    const url = receiptUrl(a, r[link])
    const t = Date.parse(r[time])
    if (!Number.isFinite(t) || t > Date.now() + 60000) throw Error('采样时间无效')
    const values = {}
    for (const [k, i] of Object.entries(columns)) {
      const s = (r[i] || '').replace(/,/g, '')
      values[k] = s === '' || ['—', '--', '-'].includes(s) ? null : count(s)
      if (s && values[k] == null && !['—', '--', '-'].includes(s))
        throw Error('作品指标不是非负整数')
    }
    return {
      itemId: canonicalId(a.platform, url),
      url,
      title: r[title] || '',
      status: '报表导入',
      sampledAt: t,
      ...values
    }
  })
}
function canonicalId(platform, url) {
  const u = new URL(url),
    part = u.pathname.split('/').filter(Boolean).pop()
  if (platform === 'channels' && u.hostname === 'channels.weixin.qq.com')
    return u.searchParams.get('objectId')
  if (
    [
      'douyin',
      'kuaishou',
      'tiktok',
      'bilibili',
      'xhs',
      'channels',
      'xiaobot',
      'x',
      'weibo',
      'zhihu',
      'toutiao'
    ].includes(platform)
  )
    return part
  return url
}
module.exports = { bilibili, reportItems, canonicalId }
