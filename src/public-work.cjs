const { receiptUrl } = require('./platforms.cjs')
// Reads only the exact work rendered by the platform, without third-party servers or search by title.
function fromPage(platform, expectedId) {
  const n = (obj, ...keys) => {
    for (const k of keys) {
      let v = obj?.[k]
      if (typeof v === 'string') v = v.replace(/,/g, '')
      if (
        (typeof v === 'number' || typeof v === 'string') &&
        /^\d+$/.test(String(v)) &&
        Number.isSafeInteger(Number(v))
      )
        return Number(v)
    }
    return null
  }
  if (platform === 'tiktok') {
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')
    const d =
      el &&
      JSON.parse(el.textContent).__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct
    if (!d || String(d.id) !== expectedId) return null
    const m = d.statsV2 || d.stats || {}
    return {
      owner: [d.author?.uniqueId],
      profile: {
        uid: String(d.author?.id || d.author?.uniqueId || ''),
        handle: d.author?.uniqueId,
        name: d.author?.nickname,
        avatarUrl: d.author?.avatarThumb
      },
      coverUrl: d.video?.cover,
      itemId: d.id,
      title: d.desc,
      publishedAt: n(d, 'createTime'),
      views: n(m, 'playCount'),
      likes: n(m, 'diggCount'),
      comments: n(m, 'commentCount'),
      collects: n(m, 'collectCount'),
      shares: n(m, 'shareCount')
    }
  }
  if (platform === 'xhs') {
    const entry = window.__INITIAL_STATE__?.note?.noteDetailMap?.[expectedId]?.note
    if (!entry || String(entry.noteId || entry.id) !== expectedId) return null
    const m = entry.interactInfo || {},
      u = entry.user || {}
    return {
      owner: [u.userId, u.redId],
      profile: {
        uid: u.userId,
        handle: u.redId,
        name: u.nickname || u.nickName,
        avatarUrl: u.avatar || u.images
      },
      coverUrl: entry.imageList?.[0]?.urlDefault,
      itemId: expectedId,
      title: entry.title || entry.desc,
      publishedAt: n(entry, 'time') ? Math.floor(Number(entry.time) / 1000) : null,
      views: n(m, 'viewCount'),
      likes: n(m, 'likedCount'),
      comments: n(m, 'commentCount'),
      collects: n(m, 'collectedCount'),
      shares: n(m, 'shareCount')
    }
  }
  if (platform === 'kuaishou') {
    const cache = window.__APOLLO_STATE__?.defaultClient || window.__APOLLO_STATE__ || {}
    const deref = (v) => (v?.__ref ? cache[v.__ref] : v)
    for (const [key, value] of Object.entries(cache.ROOT_QUERY || {})) {
      if (!/^visionVideoDetail(?:\(|$)/.test(key)) continue
      const d = deref(value),
        p = deref(d?.photo),
        author = deref(d?.author || p?.author)
      if (String(p?.id || p?.photoId) !== expectedId) continue
      return {
        owner: [author?.id, author?.userEid, author?.kwaiId],
        profile: {
          uid: String(author?.id || author?.userEid || ''),
          handle: author?.kwaiId || author?.userEid,
          name: author?.name,
          avatarUrl: author?.headerUrl
        },
        coverUrl: p.coverUrl,
        itemId: expectedId,
        title: p.caption,
        publishedAt: n(p, 'timestamp') ? Math.floor(p.timestamp / 1000) : null,
        views: n(p, 'viewCount'),
        likes: n(p, 'likeCount', 'realLikeCount'),
        comments: n(p, 'commentCount'),
        collects: n(p, 'collectCount'),
        shares: n(p, 'shareCount')
      }
    }
  }
  return null
}
function checkPage(account, raw, item) {
  const url = receiptUrl(account, raw),
    itemId = new URL(url).pathname.split('/').filter(Boolean).pop()
  if (!item || String(item.itemId) !== itemId)
    throw Error('平台暂未在该作品页提供可核对的数据。可在数据页导入平台报表。')
  const normalize = (v) => (account.platform === 'tiktok' ? String(v).toLowerCase() : String(v))
  if (
    !item.owner
      .filter((v) => v != null && v !== '')
      .map(normalize)
      .includes(normalize(account.identity))
  )
    throw Error('作品作者标识与当前账号不符；请核对平台唯一标识')
  const { owner, ...data } = item
  return { ...data, url, itemId, status: '已发布' }
}
module.exports = { fromPage, checkPage }
