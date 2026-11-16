const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs'),
  path = require('node:path')
const { createHash } = require('node:crypto')
const { receiptUrl } = require('./platforms.cjs')
const supported = { douyin: 'douyin', kuaishou: 'kuaishou', xhs: 'xhs', shipinhao: 'channels' }
function readDB(file, fn) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500')
    return fn(db)
  } finally {
    db.close()
  }
}
function bindings(file) {
  return readDB(file, (db) =>
    db
      .prepare(
        'SELECT id,platform,nickname,uid,sec_uid,douyin_id,status,created_at FROM douyinaccount'
      )
      .all()
      .filter((a) => Object.hasOwn(supported, a.platform))
      .map((a) => {
        const key = createHash('sha256')
          .update(JSON.stringify([a.id, a.platform, a.created_at, a.uid, a.sec_uid]))
          .digest('hex')
          .slice(0, 24)
        return {
          id: a.id,
          platform: supported[a.platform],
          upstream: a.platform,
          name: a.nickname || '账号 ' + a.id,
          status: a.status,
          binding: 'hub:' + a.id + ':' + key,
          identity: a.douyin_id || a.uid || a.sec_uid || 'hub-' + a.id,
          secUid: a.sec_uid || '',
          created: a.created_at
        }
      })
  )
}
function hubOrigin(dbFile) {
  const config = path.join(path.dirname(path.dirname(dbFile)), 'config.yaml')
  let port = 8000
  if (fs.existsSync(config)) {
    const block = fs
      .readFileSync(config, 'utf8')
      .match(/^server:\s*(?:#[^\n]*)?\r?\n((?:[ \t]+[^\n]*\n?)*)/m)
    const p = block?.[1].match(/^\s*port:\s*['"]?(\d+)/m)
    if (p) port = Number(p[1])
  }
  if (port < 1 || port > 65535) throw Error('CreatorHub 端口无效')
  return 'http://127.0.0.1:' + port
}
async function request(origin, route, body) {
  const response = await fetch(origin + route, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!response.ok)
    throw Object.assign(Error('CreatorHub 未接受请求（HTTP ' + response.status + '）'), {
      http: response.status
    })
  return response.json()
}
function verifiedOrigin(schema) {
  return (
    schema?.info?.title === 'CreatorHub' &&
    schema.paths?.['/api/publish']?.post &&
    schema.paths?.['/api/accounts']?.get
  )
}
function utcStamp(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN
  const s = value.trim().replace(' ', 'T')
  return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z')
}
async function materializeImages(store, job, root) {
  const dir = path.join(root, job.id)
  await fs.promises.mkdir(dir, { recursive: true })
  const paths = []
  for (const [i, id] of JSON.parse(job.assets).entries()) {
    const a = store.asset(id, true)
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[a.mime]
    if (!ext) throw Error('不支持的图片')
    const file = path.join(dir, String(i + 1).padStart(3, '0') + '-' + id + '.' + ext)
    await fs.promises.writeFile(file, a.bytes)
    paths.push(file)
  }
  return paths
}
async function dispatchHub(store, job, options) {
  const account = store.account(job.accountId)
  store.transition(job.id, ['queued'], 'sending')
  let submitted = false
  try {
    const binding = bindings(options.file).find(
      (a) =>
        a.binding === account.remoteId && a.platform === account.platform && a.status === 'active'
    )
    if (!binding) throw Error('CreatorHub 账号已变化或未登录')
    const origin = hubOrigin(options.file),
      call = options.request || request
    if (!verifiedOrigin(await call(origin, '/openapi.json')))
      throw Error('本机服务与 CreatorHub 不匹配')
    const list = await call(origin, '/api/accounts?platform=' + binding.upstream)
    const user = list.find((a) => a.id === binding.id && a.platform === binding.upstream)
    if (
      !user ||
      user.status !== 'active' ||
      !(user.has_creator || (binding.upstream !== 'xhs' && user.has_storage)) ||
      String(user.sec_uid || '') !== binding.secUid ||
      utcStamp(user.created_at) !== utcStamp(binding.created)
    )
      throw Error('请在 CreatorHub 重新确认目标账号的创作者登录态')
    let media
    if (job.videoId) {
      const src = await options.videoFile(job.id),
        dir = path.join(options.imageRoot, job.id)
      await fs.promises.mkdir(dir, { recursive: true })
      const dest = path.join(dir, path.basename(src))
      try {
        await fs.promises.link(src, dest)
      } catch (e) {
        if (e.code !== 'EEXIST') await fs.promises.copyFile(src, dest)
      }
      if (!(await require('./videos.cjs').matches(dest, job.videoId)))
        throw Error('CreatorHub 暂存视频已改变，请核对文件')
      media = [dest]
    } else media = await materializeImages(store, job, options.imageRoot)
    const payload = {
      account_id: binding.id,
      media_type: job.videoId ? 'video' : 'images',
      title: job.title,
      desc: job.body,
      media_paths: media,
      visibility: 'public'
    }
    store.db
      .prepare('INSERT OR REPLACE INTO hub_attempts VALUES(?,?,?)')
      .run(job.id, JSON.stringify(payload), Date.now())
    submitted = true
    const response = await call(origin, '/api/publish', payload)
    if (
      !Number.isSafeInteger(response.id) ||
      response.id < 1 ||
      response.platform !== binding.upstream ||
      response.account_id !== binding.id
    )
      throw Error('无法确认远端任务')
    store.atomic(() => {
      store.db.prepare('UPDATE jobs SET hubId=? WHERE id=?').run(response.id, job.id)
      store.transition(job.id, ['sending'], 'hub_pending', 'CreatorHub 已接单，等待远端结果')
    })
  } catch (e) {
    const unknown = submitted && ![400, 401, 403, 404, 422].includes(e.http)
    store.transition(
      job.id,
      ['sending'],
      unknown ? 'uncertain' : 'failed',
      unknown
        ? 'CreatorHub 接单结果未知，请检查原工具，勿重复提交。'
        : e.message === 'fetch failed'
          ? '请先启动 CreatorHub 本机服务，再重试。'
          : e.message
    )
  }
}
function matchesRow(row, expected, started) {
  if (
    !row ||
    row.account_id !== expected.account_id ||
    row.title !== expected.title ||
    row.desc !== expected.desc ||
    row.media_type !== expected.media_type ||
    row.visibility !== expected.visibility
  )
    return false
  const t = utcStamp(row.created_at)
  if (!Number.isFinite(t) || t < started - 1000) return false
  try {
    return JSON.stringify(JSON.parse(row.media_json)) === JSON.stringify(expected.media_paths)
  } catch {
    return false
  }
}
const columns =
  'id,platform,account_id,status,result_url,title,desc,media_type,media_json,visibility,created_at'
function reconcileHub(store, file) {
  const pending = store.db
    .prepare(
      "SELECT jobs.*,h.started,h.payload FROM jobs JOIN hub_attempts h ON h.jobId=jobs.id WHERE status IN ('hub_pending','uncertain')"
    )
    .all()
  if (!pending.length) return false
  return readDB(file, (db) => {
    let updated = false
    for (const job of pending) {
      const a = store.account(job.accountId),
        bound = bindings(file).find((b) => b.binding === a.remoteId)
      const expected = JSON.parse(job.payload)
      let row
      if (job.hubId)
        row = db.prepare('SELECT ' + columns + ' FROM publishtask WHERE id=?').get(job.hubId)
      else {
        const candidates = db
          .prepare('SELECT ' + columns + ' FROM publishtask WHERE account_id=? AND title=?')
          .all(expected.account_id, expected.title)
          .filter((r) => matchesRow(r, expected, job.started) && r.platform === bound?.upstream)
        if (candidates.length !== 1) continue
        row = candidates[0]
        store.atomic(() => {
          store.db.prepare('UPDATE jobs SET hubId=? WHERE id=?').run(row.id, job.id)
          store.transition(job.id, ['uncertain'], 'hub_pending', '已找回 CreatorHub 原任务')
        })
        updated = true
      }
      if (!bound || row?.platform !== bound.upstream || !matchesRow(row, expected, job.started)) {
        if (store.job(job.id).status === 'uncertain') continue
        store.transition(
          job.id,
          ['hub_pending'],
          'uncertain',
          '远端身份、媒体或内容与提交快照不匹配，请核对。'
        )
      } else if (['pending', 'publishing'].includes(row.status)) {
        if (store.job(job.id).status === 'uncertain') {
          store.transition(job.id, ['uncertain'], 'hub_pending', 'CreatorHub 原任务执行中')
          updated = true
        }
        continue
      } else if (row.status === 'done') {
        let url
        try {
          url = receiptUrl(a, row.result_url)
        } catch {}
        const note = url
          ? 'CreatorHub 回传作品链接'
          : 'CreatorHub 报告完成，但缺少可核对的作品链接。'
        if (!url && job.status === 'uncertain' && job.note === note) continue
        store.transition(
          job.id,
          ['hub_pending', 'uncertain'],
          url ? 'published' : 'uncertain',
          note,
          url || ''
        )
      } else {
        const note = 'CreatorHub 任务状态：' + row.status + '。请在原工具核对。'
        if (job.status === 'uncertain' && job.note === note) continue
        store.transition(job.id, ['hub_pending', 'uncertain'], 'uncertain', note)
      }
      updated = true
    }
    return updated
  })
}
function resolveMissing(store, file, id) {
  const before = store.job(id),
    a = store.account(before.accountId)
  if (a.mode === 'creatorhub') {
    reconcileHub(store, file)
    const j = store.job(id),
      expected = store.db.prepare('SELECT * FROM hub_attempts WHERE jobId=?').get(id)
    if (expected) {
      const payload = JSON.parse(expected.payload),
        binding = bindings(file).find((b) => b.binding === a.remoteId)
      if (!binding) throw Error('CreatorHub 身份已变化，请先核对原账号')
      const resolved = readDB(file, (db) => {
        if (!j.hubId) {
          const possible = db
            .prepare('SELECT created_at FROM publishtask WHERE account_id=? AND title=? AND desc=?')
            .all(binding.id, payload.title, payload.desc)
          return !possible.some((r) => !(utcStamp(r.created_at) < expected.started - 1000))
        }
        const row = db.prepare('SELECT ' + columns + ' FROM publishtask WHERE id=?').get(j.hubId)
        return (
          matchesRow(row, payload, expected.started) &&
          row.platform === binding.upstream &&
          ['failed', 'canceled'].includes(row.status)
        )
      })
      if (!resolved) throw Error('无法确认原任务已停止。请在 CreatorHub 核对任务，避免重复发送。')
    }
  }
  store.transition(id, ['uncertain'], 'cancelled', '本人核对平台后关闭本次发送')
}
module.exports = {
  bindings,
  dispatchHub,
  reconcileHub,
  resolveMissing,
  materializeImages,
  hubOrigin
}
