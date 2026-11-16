const ORIGIN = 'https://creator.douyin.com'
const creator = { aid: '2906', app_name: 'aweme_creator_platform', device_platform: 'web' }
const endpoints = {
  pc: ['/aweme/v1/creator/pc/user/info/', creator],
  identity: ['/aweme/v1/creator/user/info/', creator],
  list: [
    '/janus/douyin/creator/pc/work_list',
    { aid: '1128', scene: 'star_atlas', device_platform: 'android' }
  ],
  detail: ['/web/api/creator/item/mget', creator]
}
function urlFor(op, args = {}) {
  const [route, base] = endpoints[op]
  return ORIGIN + route + '?' + new URLSearchParams({ ...base, ...args })
}
function result(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw Error('抖音返回的内容无法识别')
  for (const obj of [json, json.data]) {
    for (const code of [obj?.status_code, obj?.code, obj?.BaseResp?.StatusCode])
      if (code != null && Number(code) !== 0)
        throw Error('抖音请求未成功，请检查登录状态和数据权限（' + String(code) + '）')
  }
  return json.data && typeof json.data === 'object' ? json.data : json
}
const id = (value) =>
  (typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9]\d*$/.test(String(value))
    ? String(value)
    : ''
function identity(json) {
  const d = result(json),
    profiles = [d.user_profile, d.douyin_user_verify_info, d.user, d].filter(
      (p) => p && typeof p === 'object'
    )
  const uids = new Set(profiles.map((p) => id(p.uid ?? p.user_id ?? p.aweme_uid)).filter(Boolean))
  if (uids.size !== 1) throw Error('尚未识别到唯一的抖音登录账号，请在本窗口扫码或重新登录')
  const field = (key) =>
    profiles
      .map((p) => p[key])
      .find((v) => typeof v === 'string' && v.trim())
      ?.trim() || ''
  return {
    uid: [...uids][0],
    handle: field('unique_id') || field('douyin_id') || field('short_id'),
    name: field('nickname') || field('nick_name'),
    avatarUrl:
      field('avatar_url') ||
      profiles.find((p) => p.avatar_thumb?.url_list)?.avatar_thumb.url_list[0] ||
      '',
    followers: metric(...profiles.map((p) => p.follower_count)),
    secUid: field('sec_uid')
  }
}
function metric(...values) {
  for (const v of values) {
    if (
      v !== null &&
      v !== undefined &&
      String(v).trim() !== '' &&
      Number.isSafeInteger(Number(v)) &&
      Number(v) >= 0
    )
      return Number(v)
  }
  return null
}
function normalized(raw, owner) {
  const itemId = id(raw.id ?? raw.item_id ?? raw.aweme_id)
  if (!itemId) return null
  for (const value of [raw.user_id, raw.author_user_id, raw.author?.uid]) {
    if (value != null && value !== '' && id(value) !== owner)
      throw Error('抖音作品作者与当前登录账号不符')
  }
  const m = raw.metrics ?? raw.statistics ?? {}
  const code = raw.review?.status
  const state =
    Number(raw.status?.private_status) === 1
      ? '仅自己可见'
      : { 1: '审核中', 2: '已发布', 5: '需优化', 6: '仅好友可见' }[code] ||
        String(raw.status?.desc || raw.status?.status_desc || raw.status?.text || '平台已有记录')
  return {
    itemId,
    url: 'https://www.douyin.com/' +
      (raw.images?.length || Number(raw.aweme_type) === 68 ? 'note/' : 'video/') + itemId,
    title: String(raw.description || raw.desc || raw.title || ''),
    coverUrl: raw.video?.cover?.url_list?.[0] || raw.video?.origin_cover?.url_list?.[0] || '',
    publishedAt: metric(raw.create_time),
    status: state,
    views: metric(m.view_count, m.play_count, m.vv),
    likes: metric(m.like_count, m.digg_count),
    comments: metric(m.comment_count),
    shares: metric(m.share_count),
    collects: metric(m.collect_count, m.favorite_count)
  }
}
function listPayload(json, owner) {
  const d = result(json),
    rows = d.aweme_list ?? d.items ?? d.item_list
  if (!Array.isArray(rows)) throw Error('抖音作品列表格式已改变')
  const extras = new Map((Array.isArray(d.items) ? d.items : []).map((i) => [id(i.id), i]))
  return {
    items: rows
      .map((raw) => {
        normalized(raw, owner)
        const extra = extras.get(id(raw.aweme_id ?? raw.id))
        if (extra) normalized(extra, owner)
        return normalized({ ...extra, ...raw, metrics: extra?.metrics ?? raw.metrics }, owner)
      })
      .filter(Boolean),
    more: d.has_more === true || Number(d.has_more) === 1,
    cursor: String(d.max_cursor ?? '')
  }
}
function sessionClient(read) {
  const who = async () => {
    const pc = result(await read(urlFor('pc')))
    const uid = id(pc.uid ?? pc.user_id)
    if (!uid) throw Error('请在抖音创作者中心扫码登录')
    const profile = result(await read(urlFor('identity')))
    if (id(profile.uid) && id(profile.uid) !== uid) throw Error('抖音账号已切换，请重新核对身份')
    return identity({
      ...profile,
      uid,
      user_profile: { ...pc.user_profile, ...profile.user_profile }
    })
  }
  async function checked(uid, op) {
    const before = await who()
    if (!uid || before.uid !== uid) throw Error('当前抖音身份与绑定账号不同，请切回目标账号')
    const value = await op()
    if ((await who()).uid !== uid) throw Error('读取期间登录账号已改变，本次数据未写入')
    return value
  }
  async function recent(uid, cursor = '0') {
    if (!/^\d{1,25}$/.test(cursor)) throw Error('作品分页游标无效')
    return checked(uid, async () =>
      listPayload(await read(urlFor('list', { status: 0, count: 20, max_cursor: cursor })), uid)
    )
  }
  async function detail(uid, itemId) {
    if (!id(itemId)) throw Error('作品 ID 无效')
    return checked(uid, async () => {
      const d = result(await read(urlFor('detail', { ids: itemId, fields: 'default,metrics' })))
      const matches = (Array.isArray(d.items) ? d.items : []).filter(
        (i) => id(i.id ?? i.item_id ?? i.aweme_id) === itemId
      )
      if (matches.length !== 1) throw Error('当前会话未返回该作品，可能尚在处理或没有查看权限')
      return normalized(matches[0], uid)
    })
  }
  return { who, recent, detail }
}
// Runs on the signed-in creator origin. Raw account payloads never enter renderer IPC.
async function readInPage(url) {
  if (location.origin !== 'https://creator.douyin.com' || new URL(url).origin !== location.origin)
    throw Error('请在抖音创作者中心登录')
  const response = await fetch(url, {
    credentials: 'include',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw Error('抖音创作者中心返回 HTTP ' + response.status)
  const raw = await response.text()
  if (raw.length > 8 * 1024 * 1024) throw Error('平台返回数据过大')
  try {
    return JSON.parse(raw, (key, value, ctx) =>
      typeof value === 'number' &&
      !Number.isSafeInteger(value) &&
      /^\d{16,}$/.test(ctx?.source || '')
        ? ctx.source
        : value
    )
  } catch {
    throw Error('登录已过期或平台返回的内容无法识别')
  }
}
function clientFor(wc) {
  return sessionClient((url) =>
    wc.executeJavaScript('(' + readInPage.toString() + ')(' + JSON.stringify(url) + ')')
  )
}
module.exports = { ORIGIN, identity, sessionClient, clientFor, urlFor }
