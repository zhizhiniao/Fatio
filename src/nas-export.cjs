'use strict'
/*
 * 指标快照导出（统一数据契约 v1.4 第 15 节，方案 A）。
 * 把账号、作品、指标、粉丝和发布任务导出为只读 JSON，写到用户指定的目录（通常是 NAS 共享）。
 * 永不导出：登录态、Cookie、密钥（accounts.secret）、稿件正文、素材二进制。
 */
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const SCHEMA = 1
const VIEW_MEANING = {
  douyin: '播放', kuaishou: '播放', channels: '播放', bilibili: '播放', tiktok: '播放',
  xhs: '观看', wechat: '阅读', toutiao: '阅读', zhihu: '阅读', weibo: '阅读', x: '展示', xiaobot: '阅读'
}
const DAY = 86400000

function settingsTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS nas_export(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
}
function getSetting(db, key) {
  settingsTable(db)
  return db.prepare('SELECT value FROM nas_export WHERE key=?').get(key)?.value ?? null
}
function setSetting(db, key, value) {
  settingsTable(db)
  if (value === null) db.prepare('DELETE FROM nas_export WHERE key=?').run(key)
  else db.prepare('INSERT OR REPLACE INTO nas_export VALUES(?,?)').run(key, String(value))
}
const hasTable = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

/** 数据是否变化的指纹；没变化就不重复导出。 */
function signature(db) {
  const part = (sql) => {
    try {
      return JSON.stringify(Object.values(db.prepare(sql).get() || {}))
    } catch {
      return '-'
    }
  }
  return [
    part('SELECT max(time), count(*) FROM native_samples'),
    part('SELECT count(*), max(seen) FROM native_works'),
    part('SELECT max(time), count(*) FROM follower_samples'),
    part('SELECT count(*), sum(change) FROM follower_daily'),
    part("SELECT count(*), group_concat(status,'') FROM jobs"),
    part('SELECT count(*), sum(archived) FROM accounts')
  ].join('|')
}

const workKey = (w) => 'wrk_' + w.platform + '_' + w.itemId
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function collect(db, now = Date.now()) {
  const accounts = db
    .prepare(
      'SELECT a.id,a.platform,a.name,a.identity,a.mode,a.archived,a.groupName,' +
        (hasTable(db, 'official_profiles')
          ? 'o.uid,o.handle,o.name AS officialName,o.followers,o.checked '
          : 'NULL AS uid,NULL AS handle,NULL AS officialName,NULL AS followers,NULL AS checked ') +
        'FROM accounts a ' +
        (hasTable(db, 'official_profiles') ? 'LEFT JOIN official_profiles o ON o.accountId=a.id ' : '') +
        'ORDER BY a.rowid'
    )
    .all()
    .map((a) => ({
      id: 'acc_' + a.id,
      fatio_id: a.id,
      platform: a.platform,
      display_name: a.officialName || a.name,
      local_name: a.name,
      handle: a.handle || a.identity,
      platform_uid: a.uid || null,
      mode: a.mode,
      group: a.groupName || '',
      archived: !!a.archived,
      followers: num(a.followers),
      followers_checked_at: num(a.checked)
    }))
  const accountOf = Object.fromEntries(accounts.map((a) => [a.fatio_id, a]))

  const rawWorks = hasTable(db, 'native_works')
    ? db
        .prepare(
          'SELECT w.id,w.accountId,w.platform,w.itemId,w.title,w.url,w.status,w.posted,w.seen,w.jobId,w.linkSource,j.draftId ' +
            'FROM native_works w LEFT JOIN jobs j ON j.id=w.jobId ORDER BY w.posted DESC'
        )
        .all()
    : []
  const rawSamples = hasTable(db, 'native_samples')
    ? db.prepare('SELECT workId,time,metrics FROM native_samples ORDER BY workId,time').all()
    : []

  const samplesByWork = new Map()
  for (const s of rawSamples) {
    let m = {}
    try {
      m = JSON.parse(s.metrics) || {}
    } catch {}
    const row = {
      t: s.time,
      views: num(m.views),
      likes: num(m.likes),
      comments: num(m.comments),
      shares: num(m.shares),
      collects: num(m.collects),
      source: typeof m._source === 'string' ? m._source : null,
      quality: []
    }
    if (!samplesByWork.has(s.workId)) samplesByWork.set(s.workId, [])
    samplesByWork.get(s.workId).push(row)
  }

  // 质量标记：只标记，不改原值（契约 15.5）
  for (const list of samplesByWork.values()) {
    for (let i = 1; i < list.length; i++) {
      const p = list[i - 1], s = list[i]
      if (p.views === 0 && s.views >= 100 && s.t - p.t <= 10 * 60000) {
        if (!p.quality.includes('zero_then_jump')) p.quality.push('zero_then_jump')
        s.quality.push('zero_then_jump')
      }
    }
  }
  const works = rawWorks.map((w) => {
    const list = samplesByWork.get(w.id) || []
    const last = list[list.length - 1] || null
    const postedMs = w.posted ? (w.posted > 1e12 ? w.posted : w.posted * 1000) : null
    const quality = []
    if (postedMs && now - postedMs < 30 * DAY && (!last || now - last.t > 2 * DAY)) quality.push('stale')
    return {
      id: workKey(w),
      fatio_id: w.id,
      account_id: accountOf[w.accountId]?.id || 'acc_' + w.accountId,
      platform: w.platform,
      item_id: w.itemId,
      title: w.title,
      url: w.url,
      visibility: w.status,
      posted_at: postedMs,
      content_id: null,
      link_source: w.jobId ? 'job' : null,
      job_id: w.jobId || null,
      draft_id: w.draftId || null,
      views_meaning: VIEW_MEANING[w.platform] || '播放',
      sample_count: list.length,
      last_sample_at: last ? last.t : null,
      latest: last
        ? { views: last.views, likes: last.likes, comments: last.comments, shares: last.shares, collects: last.collects }
        : null,
      quality
    }
  })
  // suspect_floor：同账号 ≥3 条作品的最新读数都 ≥1000 且彼此相差不到 15%
  const byAccount = new Map()
  for (const w of works) {
    if ((w.latest?.views ?? 0) < 1000) continue
    if (!byAccount.has(w.account_id)) byAccount.set(w.account_id, [])
    byAccount.get(w.account_id).push(w)
  }
  for (const list of byAccount.values()) {
    if (list.length < 3) continue
    const vs = list.map((w) => w.latest.views)
    if (Math.max(...vs) / Math.min(...vs) < 1.15) for (const w of list) w.quality.push('suspect_floor')
  }

  const workKeyOf = Object.fromEntries(rawWorks.map((w) => [w.id, workKey(w)]))
  const metrics = []
  for (const [id, list] of samplesByWork)
    for (const s of list) metrics.push({ work_id: workKeyOf[id] || 'wrk_unknown_' + id, ...s })

  const followers = {
    samples: hasTable(db, 'follower_samples')
      ? db
          .prepare('SELECT accountId,time,followers FROM follower_samples ORDER BY accountId,time')
          .all()
          .map((r) => ({ account_id: 'acc_' + r.accountId, t: r.time, followers: r.followers }))
      : [],
    daily: hasTable(db, 'follower_daily')
      ? db
          .prepare('SELECT accountId,day,change FROM follower_daily ORDER BY accountId,day')
          .all()
          .map((r) => ({ account_id: 'acc_' + r.accountId, day: r.day, change: r.change }))
      : []
  }

  const jobs = db
    .prepare('SELECT id,draftId,accountId,title,status,due,created,url,videoId FROM jobs ORDER BY created DESC')
    .all()
    .map((j) => ({
      id: j.id,
      draft_id: j.draftId,
      account_id: 'acc_' + j.accountId,
      title: j.title,
      kind: j.videoId ? 'video' : 'article',
      status: j.status,
      due: j.due,
      created: j.created,
      url: j.url || null
    }))

  return { accounts, works, metrics, followers, jobs }
}

const README = `# 发条 Fatio 指标快照

本目录由发条 Fatio 自动写入，只读。依据：Obsidian 仓库「09_系统/03_运维与交接/个人管理平台-统一数据契约-v1」第 15 节。

- manifest.json：导出时间、条数、口径说明。先读它；exported_at 是这份快照的时间点。
- accounts.json：账号。不含登录态和密钥。
- works.json：作品，含最新一次指标和质量标记。url 可与仓库主稿的 published_links 对应，得到 content_id。
- metrics.json：全部指标快照（不可变），按作品和采集时刻。
- followers.json：粉丝快照和按日净增（目前只有平台提供日报的账号有）。
- jobs.json：发布任务状态，不含正文。

时间一律为 UTC 毫秒。缺失的字段是 null，不是 0。
质量标记：stale（30 天内的作品超过 48 小时没有新采样）、zero_then_jump（同一时刻先读到 0 再读到大数）、suspect_floor（同账号多条作品读数异常接近）。带后两个标记的数据核实前不要用来下结论。
发条只在电脑开着时采集和导出；电脑关机期间，本目录停在最后一次导出。
`

function writeAll(dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  const tag = '.tmp-' + randomUUID().slice(0, 8)
  const written = []
  try {
    for (const [name, data] of Object.entries(files)) {
      const tmp = path.join(dir, name + tag)
      fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 1))
      written.push([tmp, path.join(dir, name)])
    }
    // manifest 最后替换：读者看到新 manifest 时，其他文件都已是新的
    written.sort((a, b) => (a[1].endsWith('manifest.json') ? 1 : 0) - (b[1].endsWith('manifest.json') ? 1 : 0))
    for (const [tmp, final] of written) fs.renameSync(tmp, final)
  } catch (e) {
    for (const [tmp] of written) fs.rmSync(tmp, { force: true })
    throw e
  }
}

function exportSnapshot(db, dir, { now = Date.now(), version = '' } = {}) {
  if (!dir) throw Error('还没有选择导出目录')
  const data = collect(db, now)
  const flagged = data.works.filter((w) => w.quality.length).length
  const manifest = {
    schema: SCHEMA,
    app: '发条 Fatio',
    app_version: version,
    exported_at: now,
    counts: {
      accounts: data.accounts.length,
      works: data.works.length,
      metrics: data.metrics.length,
      follower_samples: data.followers.samples.length,
      follower_daily: data.followers.daily.length,
      jobs: data.jobs.length,
      works_with_quality_flags: flagged
    },
    views_meaning: VIEW_MEANING,
    contract: '个人管理平台-统一数据契约 v1.4 §15'
  }
  writeAll(dir, {
    'accounts.json': data.accounts,
    'works.json': data.works,
    'metrics.json': data.metrics,
    'followers.json': data.followers,
    'jobs.json': data.jobs,
    'README.md': README,
    'manifest.json': manifest
  })
  return manifest
}

/** 有目录且数据变化（或 force）时导出；结果记入设置表。 */
function maybeExport(db, { force = false, now = Date.now(), version = '' } = {}) {
  const dir = getSetting(db, 'dir')
  if (!dir) return { skipped: 'no-dir' }
  const sig = signature(db)
  if (!force && sig === getSetting(db, 'signature')) return { skipped: 'unchanged' }
  try {
    const manifest = exportSnapshot(db, dir, { now, version })
    setSetting(db, 'signature', sig)
    setSetting(db, 'last_export', now)
    setSetting(db, 'last_counts', JSON.stringify(manifest.counts))
    setSetting(db, 'last_error', null)
    return { exported: manifest }
  } catch (e) {
    setSetting(db, 'last_error', now + ' ' + e.message)
    throw e
  }
}

function status(db) {
  let counts = null
  try {
    counts = JSON.parse(getSetting(db, 'last_counts') || 'null')
  } catch {}
  return {
    dir: getSetting(db, 'dir'),
    lastExport: Number(getSetting(db, 'last_export')) || null,
    lastError: getSetting(db, 'last_error'),
    counts
  }
}

module.exports = { exportSnapshot, maybeExport, collect, status, getSetting, setSetting, signature, SCHEMA }
