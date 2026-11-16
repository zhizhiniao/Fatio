const { randomUUID } = require('node:crypto')
const { receiptUrl } = require('./platforms.cjs')
const { platforms } = require('./catalog.cjs')
const fields = ['views', 'likes', 'comments', 'shares', 'collects']
class Library {
  constructor(store) {
    this.store = store
    this.db = store.db
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS native_sessions(accountId TEXT PRIMARY KEY REFERENCES accounts(id),uid TEXT NOT NULL,handle TEXT NOT NULL,name TEXT NOT NULL,checked INTEGER NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS native_works(id TEXT PRIMARY KEY,accountId TEXT NOT NULL REFERENCES accounts(id),platform TEXT NOT NULL,itemId TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL,posted INTEGER,jobId TEXT UNIQUE REFERENCES jobs(id),seen INTEGER NOT NULL,UNIQUE(accountId,platform,itemId));' +
        'CREATE TABLE IF NOT EXISTS native_samples(workId TEXT NOT NULL REFERENCES native_works(id),time INTEGER NOT NULL,metrics TEXT NOT NULL,PRIMARY KEY(workId,time));' +
        'CREATE TABLE IF NOT EXISTS receipt_candidates(jobId TEXT PRIMARY KEY REFERENCES jobs(id),uid TEXT NOT NULL,itemId TEXT NOT NULL,time INTEGER NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS native_submits(jobId TEXT PRIMARY KEY REFERENCES jobs(id),uid TEXT NOT NULL,started INTEGER NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS legacy_imports(source TEXT PRIMARY KEY,data TEXT NOT NULL);'
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS pictures(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,image TEXT NOT NULL,checked INTEGER NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS profile_stats(accountId TEXT PRIMARY KEY REFERENCES accounts(id),followers INTEGER);' +
        'CREATE TABLE IF NOT EXISTS follower_samples(accountId TEXT NOT NULL REFERENCES accounts(id),time INTEGER NOT NULL,followers INTEGER NOT NULL,PRIMARY KEY(accountId,time));' +
        'CREATE TABLE IF NOT EXISTS follower_daily(accountId TEXT NOT NULL REFERENCES accounts(id), day TEXT NOT NULL, change INTEGER NOT NULL,PRIMARY KEY(accountId,day));' +
        'CREATE TABLE IF NOT EXISTS avatar_attempts(accountId TEXT PRIMARY KEY REFERENCES accounts(id),time INTEGER NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS official_profiles(accountId TEXT PRIMARY KEY REFERENCES accounts(id),uid TEXT NOT NULL,handle TEXT NOT NULL,name TEXT NOT NULL,followers INTEGER,checked INTEGER NOT NULL);'
    )
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS creative_projects(id TEXT PRIMARY KEY,idea TEXT NOT NULL DEFAULT '',refs TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS creative_versions(draftId TEXT NOT NULL REFERENCES drafts(id),revision INTEGER NOT NULL,content TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(draftId,revision));"
    )
    if (
      !this.db
        .prepare('PRAGMA table_info(native_works)')
        .all()
        .some((c) => c.name === 'linkSource')
    )
      this.db.exec('ALTER TABLE native_works ADD COLUMN linkSource TEXT')
    if (
      !this.db
        .prepare('PRAGMA table_info(drafts)')
        .all()
        .some((c) => c.name === 'projectId')
    )
      this.db.exec('ALTER TABLE drafts ADD COLUMN projectId TEXT')
    // Earlier external jobs may still exist at the old service. Never release their fingerprints on upgrade.
    store.atomic(() => {
      this.db.exec(
        "UPDATE jobs SET status='uncertain',note='旧版外部队列任务，请核对原发布记录。' WHERE status='hub_pending' OR (status='queued' AND accountId IN (SELECT id FROM accounts WHERE mode='creatorhub')); UPDATE accounts SET mode='web',remoteId=NULL WHERE mode='creatorhub'"
      )
      this.db.exec(
        "UPDATE accounts SET remoteId='dy:'||(SELECT uid FROM native_sessions WHERE accountId=accounts.id) WHERE platform='douyin' AND id IN (SELECT accountId FROM native_sessions)"
      )
    })
    this.backfill()
  }
  notes(id) {
    const d = this.store.draft(id)
    return (
      this.db.prepare('SELECT idea,refs FROM creative_projects WHERE id=?').get(d.projectId) || {
        idea: '',
        refs: ''
      }
    )
  }
  saveNotes(id, idea, refs) {
    if (
      typeof idea !== 'string' ||
      typeof refs !== 'string' ||
      idea.length > 12000 ||
      refs.length > 20000
    )
      throw Error('想法或参考资料过长')
    const d = this.store.draft(id)
    this.db
      .prepare('INSERT OR REPLACE INTO creative_projects VALUES(?,?,?)')
      .run(d.projectId, idea, refs)
  }
  variant(id, kind) {
    if (!['article', 'video'].includes(kind)) throw Error('创作形式无效')
    return this.store.atomic(() => {
      const d = this.store.draft(id)
      const match = this.db
        .prepare('SELECT id FROM drafts WHERE COALESCE(projectId,id)=?')
        .all(d.projectId)
        .map((row) => this.store.draft(row.id))
        .find((w) => (w.kind || 'article') === kind)
      if (match) return match
      const v = this.store.save({
        title: d.title,
        body: d.body,
        xText: '',
        targets: [],
        assets: [],
        videos: [],
        kind,
        variants: {}
      })
      this.db.prepare('UPDATE drafts SET projectId=? WHERE id=?').run(d.projectId, v.id)
      return this.store.draft(v.id)
    })
  }
  version(id) {
    const d = this.store.draft(id)
    this.db
      .prepare('INSERT OR IGNORE INTO creative_versions VALUES(?,?,?,?)')
      .run(id, d.revision, JSON.stringify(d), Date.now())
    return this.versions(id)
  }
  versions(id) {
    return this.db
      .prepare('SELECT revision,time FROM creative_versions WHERE draftId=? ORDER BY revision DESC')
      .all(id)
  }
  restore(id, revision, expected) {
    return this.store.atomic(() => {
      const d = this.store.draft(id)
      if (d.revision !== expected) throw Error('草稿已经更新，请重新打开版本记录')
      const row = this.db
        .prepare('SELECT content FROM creative_versions WHERE draftId=? AND revision=?')
        .get(id, revision)
      if (!row) throw Error('版本不存在')
      this.version(id)
      return this.store.save({ ...JSON.parse(row.content), id, revision: expected })
    })
  }
  backfill() {
    const jobs = this.db
      .prepare(
        "SELECT j.* FROM jobs j LEFT JOIN native_works w ON w.jobId=j.id WHERE w.id IS NULL AND j.url<>'' AND j.status IN ('published','recorded')"
      )
      .all()
    this.store.atomic(() => {
      for (const j of jobs) {
        const a = this.store.account(j.accountId)
        let url
        try {
          url = receiptUrl(a, j.url)
        } catch {
          continue
        }
        const itemId = require('./platform-data.cjs').canonicalId(a.platform, url)
        const known = this.db
          .prepare('SELECT id,jobId FROM native_works WHERE accountId=? AND itemId=?')
          .get(a.id, itemId)
        if (known?.jobId) continue
        const id =
          known?.id ||
          this.upsert(a, {
            itemId,
            url,
            title: j.title || j.body,
            status: j.status === 'published' ? '已有平台回执' : '本人登记'
          })
        this.db
          .prepare('UPDATE native_works SET jobId=?,linkSource=? WHERE id=?')
          .run(j.id, j.status === 'published' ? '既有平台回执' : '本人登记', id)
      }
    })
  }
  binding(id) {
    return this.db.prepare('SELECT * FROM native_sessions WHERE accountId=?').get(id)
  }
  recordFollowers(id, value, time) {
    if (!Number.isSafeInteger(value) || value < 0) return
    const last = this.db.prepare('SELECT time,followers FROM follower_samples WHERE accountId=? ORDER BY time DESC LIMIT 1').get(id)
    if (last?.followers === value && time - last.time < 60000) return
    this.db.prepare('INSERT OR REPLACE INTO follower_samples VALUES(?,?,?)').run(id, time, value)
  }
  saveProfile(id, profile) {
    const a = this.store.account(id)
    if (
      a.archived ||
      !profile.uid ||
      !profile.name ||
      (![profile.uid, profile.handle].includes(a.identity) &&
        !(a.platform === 'x' && String(a.remoteId) === profile.uid))
    )
      return false
    const old = this.db.prepare('SELECT uid FROM official_profiles WHERE accountId=?').get(id)
    if (old && old.uid !== profile.uid) return false
    this.db
      .prepare(
        'INSERT INTO official_profiles VALUES(?,?,?,?,?,?) ON CONFLICT(accountId) DO UPDATE SET handle=excluded.handle,name=excluded.name,followers=COALESCE(excluded.followers,official_profiles.followers),checked=excluded.checked'
      )
      .run(
        id,
        profile.uid,
        profile.handle || '',
        profile.name,
        Number.isSafeInteger(profile.followers) ? profile.followers : null,
        Date.now()
      )
    this.recordFollowers(id, profile.followers, Date.now())
    return true
  }
  profiles() {
    return this.db
      .prepare(
        "SELECT s.*,t.followers,p.image AS avatar FROM native_sessions s LEFT JOIN profile_stats t ON t.accountId=s.accountId LEFT JOIN pictures p ON p.id='avatar:'||s.accountId UNION ALL SELECT s.accountId,s.uid,s.handle,s.name,s.checked,s.followers,p.image AS avatar FROM official_profiles s LEFT JOIN pictures p ON p.id='avatar:'||s.accountId"
      )
      .all()
  }
  identify(id, user, { firstLogin = false } = {}) {
    const a = this.store.account(id)
    if (a.archived || a.platform !== 'douyin' || !user.uid) throw Error('账号不可用')
    const old = this.binding(id)
    if (old && old.uid !== user.uid) throw Error('登录身份与已绑定的抖音 UID 不符，请切回原账号')
    if (
      !old &&
      !firstLogin &&
      ![user.uid, user.secUid, user.handle].filter(Boolean).includes(a.identity)
    )
      throw Error('当前登录身份与填写的抖音号不符；可以从「扫码添加抖音」自动识别。')
    const duplicate = this.db
      .prepare(
        'SELECT a.id FROM native_sessions n JOIN accounts a ON a.id=n.accountId WHERE n.uid=? AND a.archived<>1 AND a.id<>?'
      )
      .get(user.uid, id)
    if (duplicate) throw Error('同一抖音 UID 已在账号列表中，请打开原账号')
    this.db
      .prepare(
        'INSERT INTO native_sessions VALUES(?,?,?,?,?) ON CONFLICT(accountId) DO UPDATE SET handle=excluded.handle,name=excluded.name,checked=excluded.checked'
      )
      .run(id, user.uid, user.handle || '', user.name || '', Date.now())
    this.db.prepare('UPDATE accounts SET remoteId=? WHERE id=?').run('dy:' + user.uid, id)
    if (Number.isSafeInteger(user.followers) && user.followers >= 0)
      this.db
        .prepare(
          'INSERT INTO profile_stats VALUES(?,?) ON CONFLICT(accountId) DO UPDATE SET followers=excluded.followers'
        )
        .run(id, user.followers)
    this.recordFollowers(id, user.followers, Date.now())
    return this.binding(id)
  }
  writeItems(accountId, rows, uid) {
    const a = this.store.account(accountId)
    if (a.archived || (a.platform === 'douyin' && (!uid || this.binding(a.id)?.uid !== uid)))
      throw Error('账号已变化，请重新登录')
    return this.store.atomic(() => {
      for (const item of rows) this.upsert(a, item)
      return this.works(accountId)
    })
  }
  upsert(a, item) {
    const url = item.url || 'https://www.douyin.com/video/' + item.itemId
    const existing = this.db
      .prepare('SELECT * FROM native_works WHERE accountId=? AND platform=? AND itemId=?')
      .get(a.id, a.platform, item.itemId)
    if (existing?.jobId && existing.status !== '本人登记' && item.status === '本人登记')
      return existing.id
    const id = existing?.id || randomUUID(),
      now = item.sampledAt ?? Math.max(Date.now(), (existing?.seen || 0) + 1)
    if (existing && now < existing.seen) {
      const metrics = {
        ...Object.fromEntries(fields.map((k) => [k, item[k] ?? null])),
        _source: '平台报表'
      }
      this.db
        .prepare('INSERT OR IGNORE INTO native_samples VALUES(?,?,?)')
        .run(id, now, JSON.stringify(metrics))
      return id
    }
    const status =
      ['平台已有记录', '报表导入'].includes(item.status) && existing?.status
        ? existing.status
        : item.status
    this.db
      .prepare(
        'INSERT INTO native_works(id,accountId,platform,itemId,title,url,status,posted,seen) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,status=excluded.status,posted=COALESCE(excluded.posted,native_works.posted),seen=excluded.seen'
      )
      .run(
        id,
        a.id,
        a.platform,
        item.itemId,
        item.title || existing?.title || '',
        url,
        status,
        item.publishedAt ?? null,
        now
      )
    const previous = this.db
      .prepare('SELECT metrics FROM native_samples WHERE workId=? ORDER BY time DESC LIMIT 1')
      .get(id)
    const last = JSON.parse(previous?.metrics || '{}'),
      metrics = {
        _times: { ...last._times },
        _source:
          item.status === '报表导入'
            ? '平台报表'
            : item.status === '本人登记'
              ? '本人登记'
              : '平台回读'
      }
    for (const k of fields) {
      metrics[k] = item[k] ?? last[k] ?? null
      if (item[k] != null) metrics._times[k] = now
    }
    this.db
      .prepare('INSERT OR REPLACE INTO native_samples VALUES(?,?,?)')
      .run(id, now, JSON.stringify(metrics))
    if (existing?.jobId) this.updateJob(existing.jobId, status, url)
    return id
  }
  updateJob(id, status, url) {
    const previous = this.store.job(id).status
    const state =
      ['已发布', '已发表', '已有平台回执', '仅自己可见', '仅好友可见'].includes(status) ||
      (previous === 'published' && ['平台已有记录', '报表导入', '本人登记'].includes(status))
        ? 'published'
        : 'recorded'
    this.db
      .prepare(
        "UPDATE jobs SET status=?,note=?,url=? WHERE id=? AND status IN ('waiting','uncertain','recorded','published')"
      )
      .run(state, '官方作品状态：' + status, url, id)
  }
  link(jobId, workId, source = '本人指定作品关联') {
    return this.store.atomic(() => {
      const job = this.store.job(jobId),
        work = this.db.prepare('SELECT * FROM native_works WHERE id=?').get(workId)
      if (
        !work ||
        work.accountId !== job.accountId ||
        !['waiting', 'uncertain', 'recorded', 'published'].includes(job.status)
      )
        throw Error('任务与作品不属于同一账号或任务已结束')
      if (work.jobId && work.jobId !== jobId) throw Error('该作品已关联其他发布任务')
      const prior = this.db.prepare('SELECT id FROM native_works WHERE jobId=?').get(jobId)
      if (prior && prior.id !== workId) throw Error('任务已绑定另一作品')
      const candidate = this.db
        .prepare('SELECT itemId FROM receipt_candidates WHERE jobId=?')
        .get(jobId)
      if (candidate && candidate.itemId !== work.itemId)
        throw Error('作品 ID 与本任务官方窗口回执冲突，请核对原作。')
      if (
        job.url &&
        receiptUrl(this.store.account(job.accountId), job.url) !==
          receiptUrl(this.store.account(job.accountId), work.url)
      )
        throw Error('作品与已登记的回执不符')
      this.db
        .prepare('UPDATE native_works SET jobId=?,linkSource=? WHERE id=?')
        .run(jobId, candidate ? '投稿窗口回执已核对' : source, workId)
      this.updateJob(jobId, work.status, work.url)
      const evidence = candidate ? '窗口投稿回执与本人作品匹配' :
        source === '官方后台自动核对' ? '已从本账号后台核对作品、发布时间和任务文案' : '本人指定关联，作者与指标已核对'
      this.db
        .prepare('UPDATE jobs SET note=? WHERE id=?')
        .run(evidence + ' · ' + work.status, jobId)
    })
  }
  manualMarks() {
    return this.db.prepare(
      "SELECT j.id FROM jobs j JOIN accounts a ON a.id=j.accountId WHERE j.status='uncertain' AND j.note=? " +
      "AND a.mode='web' AND a.archived=0 AND j.url='' AND j.hubId IS NULL " +
      "AND NOT EXISTS (SELECT 1 FROM receipt_candidates WHERE jobId=j.id) " +
      "AND NOT EXISTS (SELECT 1 FROM native_submits WHERE jobId=j.id) " +
      "AND NOT EXISTS (SELECT 1 FROM hub_attempts WHERE jobId=j.id) " +
      "AND NOT EXISTS (SELECT 1 FROM native_works WHERE jobId=j.id)"
    ).all('本人已在平台手动发表，等待官方回执').map(row => row.id)
  }
  undoManualMark(id) {
    this.store.atomic(() => {
      if (!this.manualMarks().includes(id)) throw Error('任务状态已改变或已有提交记录，请核对平台回执')
      this.store.transition(id, ['uncertain'], 'waiting')
    })
  }
  submitting(jobId, uid) {
    const j = this.store.job(jobId)
    if (j.status !== 'waiting' || this.binding(j.accountId)?.uid !== uid) return false
    this.store.atomic(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO native_submits VALUES(?,?,?)')
        .run(jobId, uid, Date.now())
      this.store.transition(
        jobId,
        ['waiting'],
        'uncertain',
        '官方投稿请求已发起，正在核对作品回执。'
      )
    })
    return true
  }
  candidate(jobId, uid, itemId) {
    const j = this.store.job(jobId)
    if (
      !['waiting', 'uncertain'].includes(j.status) ||
      this.binding(j.accountId)?.uid !== uid ||
      !/^[1-9]\d*$/.test(itemId)
    )
      return
    this.db
      .prepare('INSERT OR IGNORE INTO receipt_candidates VALUES(?,?,?,?)')
      .run(jobId, uid, itemId, Date.now())
  }
  works(accountId) {
    const rows = this.db
      .prepare(
        "SELECT w.*,j.draftId,j.videoId,COALESCE(d.projectId,d.id) AS projectId,COALESCE(NULLIF(n.name,''),NULLIF(o.name,''),a.name) AS account,s.metrics,p.image AS cover FROM native_works w JOIN accounts a ON a.id=w.accountId LEFT JOIN native_sessions n ON n.accountId=a.id LEFT JOIN official_profiles o ON o.accountId=a.id LEFT JOIN pictures p ON p.id='cover:'||w.accountId||':'||w.itemId LEFT JOIN jobs j ON j.id=w.jobId LEFT JOIN drafts d ON d.id=j.draftId LEFT JOIN native_samples s ON s.workId=w.id AND s.time=(SELECT MAX(z.time) FROM native_samples z WHERE z.workId=w.id) " +
          (accountId ? 'WHERE w.accountId=? ' : '') +
          'ORDER BY w.seen DESC,w.itemId'
      )
      .all(...(accountId ? [accountId] : []))
    return rows.map((r) => ({
      ...r,
      ...JSON.parse(r.metrics || '{}'),
      platformLabel: platforms[r.platform]?.label || r.platform
    }))
  }
  samples(workId) {
    return this.db
      .prepare('SELECT time,metrics FROM native_samples WHERE workId=? ORDER BY time DESC LIMIT 30')
      .all(workId)
      .map((r) => ({ time: r.time, ...JSON.parse(r.metrics) }))
  }
  candidates() {
    return this.db.prepare('SELECT jobId,itemId FROM receipt_candidates').all()
  }
}
module.exports = { Library }
