const { TwitterApi } = require('twitter-api-v2')

function credentials(raw) {
  const result = {}
  for (const key of ['appKey', 'appSecret', 'accessToken', 'accessSecret']) {
    const value = String(raw?.[key] ?? '').trim()
    if (!value || value.length > 2048) throw Error('请填全四项 X API 凭据')
    result[key] = value
  }
  return result
}
function xClient(keys) {
  const client = new TwitterApi(credentials(keys))
  return {
    me: async (withProfile = false) =>
      (
        await client.v2.get(
          'users/me',
          withProfile ? { 'user.fields': 'profile_image_url,public_metrics' } : {},
          { timeout: 20000 }
        )
      ).data,
    upload: async (asset) =>
      client.v2.uploadMedia(Buffer.from(asset.bytes), {
        media_type: asset.mime,
        media_category: 'tweet_image'
      }),
    post: async (text, mediaIds) =>
      (
        await client.v2.post(
          'tweets',
          mediaIds.length ? { text, media: { media_ids: mediaIds } } : { text },
          { timeout: 30000 }
        )
      ).data
  }
}
function identityOk(user, account) {
  return (
    user?.id &&
    user.username?.toLowerCase() === account.identity &&
    (!account.remoteId || user.id === account.remoteId)
  )
}
async function withDeadline(operation, ms) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('请求超时')), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function runDue(store, getClient, now = Date.now(), hubDispatch) {
  const due = store.db
    .prepare("SELECT id FROM jobs WHERE status='queued' AND due<=? ORDER BY due,created")
    .all(now)
  await Promise.all(
    due.map(async ({ id }) => {
      const job = store.job(id)
      if (job.status !== 'queued') return
      const account = store.account(job.accountId)
      if (account.mode === 'web') {
        store.transition(id, ['queued'], 'waiting')
        return
      }
      if (
        store.db
          .prepare("SELECT id FROM jobs WHERE accountId=? AND status IN ('sending','hub_pending')")
          .get(account.id)
      )
        return
      if (account.mode === 'creatorhub') {
        if (!hubDispatch) throw Error('CreatorHub 连接器不可用')
        return hubDispatch(job)
      }
      store.transition(id, ['queued'], 'sending')
      let submitted = false
      try {
        const client = await getClient(account)
        const me = await client.me()
        if (!identityOk(me, account)) throw Error('X 身份与绑定账号不符')
        const mediaIds = []
        for (const id of JSON.parse(job.assets))
          mediaIds.push(await withDeadline(client.upload(store.asset(id, true)), 120000))
        submitted = true
        const result = await client.post(job.body, mediaIds)
        if (!/^[1-9]\d*$/.test(result?.id ?? '')) throw Error('X 未返回作品 ID')
        store.transition(
          id,
          ['sending'],
          'published',
          'X API 已返回作品 ID',
          'https://x.com/' + account.identity + '/status/' + result.id
        )
      } catch (err) {
        const code = Number(err.code)
        const rejected = [400, 401, 402, 403, 404, 422, 429].includes(code)
        const status = submitted && !rejected ? 'uncertain' : 'failed'
        const note =
          status === 'uncertain'
            ? '发送结果未知，请先到 X 核对。'
            : rejected
              ? 'X 拒绝请求（HTTP ' + code + '），请检查权限、额度或频率限制。'
              : '发送前校验或媒体上传失败，请检查凭据、网络及账号。'
        store.transition(id, ['sending'], status, note)
      }
    })
  )
}
module.exports = { credentials, xClient, identityOk, runDue }
