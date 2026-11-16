const { DatabaseSync } = require('node:sqlite')
const { randomUUID, createHash } = require('node:crypto')
const { accountInput, bodyFor, receiptUrl } = require('./platforms.cjs')
const { platforms, publicCatalog } = require('./catalog.cjs')
const { sizes, submissionCovers } = require('./cover-profiles.cjs')

const accountFields = 'id,platform,name,identity,mode,remoteId,archived,groupName'
const terminal = ['published', 'recorded', 'cancelled']
const required = (row, message) => {
  if (!row) throw Error(message)
  return row
}
function contentFingerprint(title, body, assets, videoId, coverId, formats, tags, preferredCover) {
  const content = videoId ? [title,body,assets,videoId] : [title,body,assets]
  if (coverId) content.push(coverId)
  if (formats.wide || formats.portrait) content.push([formats.wide || null,formats.portrait || null])
  if (tags.length) content.push(tags)
  if (preferredCover) content.push(preferredCover)
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}
function cleanDraft(raw) {
  const text = (value, max) => {
    if (typeof value !== 'string' || value.length > max) throw Error('稿件字段无效或过长')
    return value
  }
  if (!Array.isArray(raw.targets) || raw.targets.some((id) => typeof id !== 'string'))
    throw Error('目标账号无效')
  const assets = raw.assets ?? []
  if (
    !Array.isArray(assets) ||
    assets.length > 64 ||
    assets.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
  )
    throw Error('配图无效或超过 64 张')
  const kind = raw.kind ?? 'article'
  const variants = {}
  for (const [key, value] of Object.entries(raw.variants ?? {})) {
    if (!Object.hasOwn(platforms, key) || key === 'x' || !value || typeof value !== 'object')
      throw Error('平台专用文案无效')
    variants[key] = { title: text(value.title, 300), body: text(value.body, 150000) }
    if (kind === 'video' && value.tags) variants[key].tags = text(value.tags, 1000)
    if (kind === 'video' && ['wide','portrait'].includes(value.cover)) variants[key].cover = value.cover
  }
  const videos = raw.videos ?? []
  if (
    !['article', 'video'].includes(kind) ||
    !Array.isArray(videos) ||
    videos.length > 32 ||
    videos.some((v) => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))
  )
    throw Error('视频批次无效')
  if ((kind === 'article' && videos.length) || (kind === 'video' && assets.length))
    throw Error('图文和视频素材不能混用')
  const checkCover = (videoId, imageId) => {
    if (!videos.includes(videoId) || typeof imageId !== 'string' || !/^[a-f0-9]{64}$/.test(imageId)) throw Error('视频封面无效')
    return imageId
  }
  const covers = {}, coverFormats = {}
  for (const [clip, image] of Object.entries(raw.covers || {})) covers[clip] = checkCover(clip, image)
  for (const [clip, formats] of Object.entries(raw.coverFormats || {})) {
    const images = {}
    for (const [key, image] of Object.entries(formats)) {
      if (!Object.hasOwn(sizes, key)) throw Error('封面比例无效')
      images[key] = checkCover(clip, image)
    }
    if (Object.keys(images).length) coverFormats[clip] = images
  }
  return {
    kind,
    covers,
    coverFormats,
    videoTags: kind === 'video' ? text(raw.videoTags ?? '', 1000) : '',
    artNote: text(raw.artNote ?? '', 8000),
    videos: [...new Set(videos)],
    variants,
    title: text(raw.title, 300),
    body: text(raw.body, 150000),
    xText: text(raw.xText, 10000),
    targets: [...new Set(raw.targets)],
    assets: [...new Set(assets)]
  }
}
class Store {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL, identity TEXT NOT NULL, mode TEXT NOT NULL, remoteId TEXT, secret TEXT, archived INTEGER NOT NULL DEFAULT 0);' +
        'CREATE UNIQUE INDEX IF NOT EXISTS active_identity ON accounts(platform, identity) WHERE archived=0;' +
        'CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, content TEXT NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,thumb TEXT NOT NULL,bytes BLOB NOT NULL);' +
        "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, draftId TEXT NOT NULL REFERENCES drafts(id), accountId TEXT NOT NULL REFERENCES accounts(id), title TEXT NOT NULL, body TEXT NOT NULL, assets TEXT NOT NULL DEFAULT '[]',fingerprint TEXT NOT NULL, due INTEGER NOT NULL, created INTEGER NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '');" +
        "CREATE UNIQUE INDEX IF NOT EXISTS active_content ON jobs(accountId,fingerprint) WHERE status <> 'cancelled';" +
        "UPDATE jobs SET status='uncertain',note='上次发送未取得回执，请到平台核对。' WHERE status='sending'"
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY,name TEXT NOT NULL,filename TEXT NOT NULL,size INTEGER NOT NULL)'
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL)'
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS video_handoffs(jobId TEXT PRIMARY KEY REFERENCES jobs(id),message TEXT NOT NULL)'
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS hub_attempts(jobId TEXT PRIMARY KEY REFERENCES jobs(id), payload TEXT NOT NULL, started INTEGER NOT NULL)'
    )
    if (
      !this.db
        .prepare('PRAGMA table_info(jobs)')
        .all()
        .some((col) => col.name === 'videoId')
    )
      this.db.exec('ALTER TABLE jobs ADD COLUMN videoId TEXT REFERENCES videos(id)')
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(c => c.name === 'coverId'))
      this.db.exec('ALTER TABLE jobs ADD COLUMN coverId TEXT REFERENCES assets(id)')
    for (const [column, initial] of [['coverFormats', '{}'], ['videoTags', '[]'], ['preferredCover', '']]) {
      if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(c => c.name === column))
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${initial}'`)
    }
    if (
      !this.db
        .prepare('PRAGMA table_info(jobs)')
        .all()
        .some((col) => col.name === 'hubId')
    )
      this.db.exec('ALTER TABLE jobs ADD COLUMN hubId INTEGER')
    if (
      !this.db
        .prepare('PRAGMA table_info(accounts)')
        .all()
        .some((col) => col.name === 'groupName')
    )
      this.db.exec("ALTER TABLE accounts ADD COLUMN groupName TEXT NOT NULL DEFAULT ''")
  }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  account(id) {
    return required(
      this.db.prepare('SELECT ' + accountFields + ' FROM accounts WHERE id=?').get(id),
      '账号不存在'
    )
  }
  addAccount(raw, secret = null, remoteId = null, id = randomUUID()) {
    const a = accountInput(raw)
    if (a.mode === 'api' && (!secret || !remoteId)) throw Error('X 身份尚未验证')
    if (a.mode === 'creatorhub' && !/^hub:\d+:[0-9a-f]{24}$/.test(remoteId || ''))
      throw Error('未验证 CreatorHub 账号')
    if (
      this.db
        .prepare('SELECT id FROM accounts WHERE platform=? AND identity=? AND archived<>1')
        .get(a.platform, a.identity)
    )
      throw Error('该账号已添加或正在清理')
    this.db
      .prepare(
        'INSERT INTO accounts (id,platform,name,identity,mode,remoteId,secret) VALUES (?,?,?,?,?,?,?)'
      )
      .run(id, a.platform, a.name, a.identity, a.mode, remoteId, secret)
    return this.account(id)
  }
  archive(id) {
    this.atomic(() => {
      this.account(id)
      if (
        this.db
          .prepare(
            "SELECT id FROM jobs WHERE accountId=? AND status NOT IN ('cancelled','published','recorded')"
          )
          .get(id)
      )
        throw Error('请先处理或取消该账号的队列任务')
      this.db
        .prepare('UPDATE accounts SET archived=2,secret=NULL WHERE id=? AND archived<>1')
        .run(id)
    })
  }
  bindHub(binding) {
    const input = accountInput({
      platform: binding.platform,
      identity: binding.identity,
      name: binding.name,
      mode: 'creatorhub'
    })
    return this.atomic(() => {
      const existing = this.db
        .prepare(
          'SELECT ' +
            accountFields +
            ' FROM accounts WHERE platform=? AND identity=? AND archived<>1'
        )
        .get(input.platform, input.identity)
      if (!existing) return this.addAccount(input, null, binding.binding)
      if (existing.archived) throw Error('账号仍在清理中')
      if (existing.remoteId === binding.binding && existing.mode === 'creatorhub') return existing
      if (existing.mode !== 'web') throw Error('已有不同的发布身份，请核对账号')
      if (
        this.db
          .prepare(
            "SELECT id FROM jobs WHERE accountId=? AND status NOT IN ('cancelled','published','recorded')"
          )
          .get(existing.id)
      )
        throw Error('请先完成或取消该网页账号的待处理任务，再切换到 CreatorHub')
      this.db
        .prepare("UPDATE accounts SET mode='creatorhub',remoteId=? WHERE id=?")
        .run(binding.binding, existing.id)
      return this.account(existing.id)
    })
  }
  secret(id) {
    return this.db.prepare('SELECT secret FROM accounts WHERE id=? AND archived=0').get(id)?.secret
  }
  finishArchive(id) {
    this.db.prepare('UPDATE accounts SET archived=1 WHERE id=? AND archived=2').run(id)
  }
  describe(id, name, group) {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 64 ||
      typeof group !== 'string' ||
      group.trim().length > 40
    )
      throw Error('账号名称或分组无效')
    if (
      !this.db
        .prepare('UPDATE accounts SET name=?,groupName=? WHERE id=? AND archived=0')
        .run(name.trim(), group.trim(), id).changes
    )
      throw Error('账号不可修改')
  }
  draft(id) {
    const row = required(this.db.prepare('SELECT * FROM drafts WHERE id=?').get(id), '草稿不存在')
    return {
      id: row.id,
      projectId: row.projectId || row.id,
      revision: row.revision,
      updated: row.updated,
      ...JSON.parse(row.content)
    }
  }
  save(raw) {
    const draft = cleanDraft(raw)
    for (const id of draft.videos)
      required(this.db.prepare('SELECT id FROM videos WHERE id=?').get(id), '视频未导入')
    for (const id of [...draft.assets, ...Object.values(draft.covers), ...Object.values(draft.coverFormats).flatMap(Object.values)])
      required(this.asset(id), '配图不存在，请重新导入')
    if (!raw.id) {
      const id = randomUUID()
      this.db
        .prepare('INSERT INTO drafts(id,content,revision,updated) VALUES (?,?,1,?)')
        .run(id, JSON.stringify(draft), Date.now())
      return this.draft(id)
    }
    const changed = this.db
      .prepare(
        'UPDATE drafts SET content=?,revision=revision+1,updated=? WHERE id=? AND revision=?'
      )
      .run(JSON.stringify(draft), Date.now(), raw.id, raw.revision)
    if (!changed.changes) throw Error('草稿版本已改变，请重新打开')
    return this.draft(raw.id)
  }
  job(id) {
    return required(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id), '任务不存在')
  }
  asset(id, withBytes = false) {
    return this.db
      .prepare(
        'SELECT ' + (withBytes ? '*' : 'id,name,mime,size,thumb') + ' FROM assets WHERE id=?'
      )
      .get(id)
  }
  queue(id, revision, due, now = Date.now()) {
    if (due !== null && (!Number.isSafeInteger(due) || due < now - 60000))
      throw Error('排期时间无效或已过')
    return this.atomic(() => {
      const draft = this.draft(id)
      if (draft.revision !== revision) throw Error('草稿已更新，请重新打开')
      if (!draft.targets.length) throw Error('请选择目标账号')
      const ids = []
      const kind = draft.kind ?? 'article'
      if (kind === 'video' && !draft.videos?.length) throw Error('请选择视频')
      for (const accountId of draft.targets) {
        const a = this.account(accountId)
        if (a.archived) throw Error('目标账号已移除，请重新选择')
        if (!platforms[a.platform][kind])
          throw Error(platforms[a.platform].label + ' 未接入该投稿类型')
        const copy = bodyFor(draft, a)
        const assetIds = draft.assets ?? []
        if (
          a.platform === 'x' &&
          (assetIds.length > 4 || assetIds.some((id) => this.asset(id).size > 5 * 1024 * 1024))
        )
          throw Error('X 最多 4 张图，每张不超过 5 MB')
        for (const videoId of kind === 'video' ? draft.videos : [null]) {
          const title =
            copy.title ||
            (videoId
              ? require('node:path').parse(
                  this.db.prepare('SELECT name FROM videos WHERE id=?').get(videoId).name
                ).name
              : '')
          const body = copy.body
          if (
            a.mode === 'creatorhub' &&
            ((!videoId && !assetIds.length) || Array.from(title).length > 20)
          )
            throw Error('CreatorHub 投稿需要媒体文件，标题最多 20 字')
          const variant = draft.variants?.[a.platform]
          const artwork = draft.coverFormats?.[videoId] || {}
          const adapted = Object.keys(artwork).some(k => k !== 'wide' && k !== 'portrait')
          const formats = adapted ? submissionCovers(artwork, a.platform, variant?.cover) : artwork
          const coverId = adapted ? formats[variant?.cover] || formats.wide || formats.portrait || null :
            formats.wide || draft.covers?.[videoId] || formats.portrait || null
          const tags = videoId ? [...new Set((variant?.tags || draft.videoTags || '').split(/[\s,#，＃、]+/u).filter(Boolean))] : []
          const preferredCover = videoId ? variant?.cover || '' : ''
          const fingerprint = contentFingerprint(title,body,assetIds,videoId,coverId,formats,tags,preferredCover)
          const existing = this.db
            .prepare(
              "SELECT jobs.id FROM jobs JOIN accounts a ON a.id=jobs.accountId WHERE a.platform=? AND ((a.remoteId IS NOT NULL AND ? IS NOT NULL AND a.remoteId=?) OR ((a.remoteId IS NULL OR ? IS NULL) AND a.identity=?)) AND fingerprint=? AND status<>'cancelled' ORDER BY created DESC LIMIT 1"
            )
            .get(a.platform, a.remoteId, a.remoteId, a.remoteId, a.identity, fingerprint)
          if (existing) {
            ids.push(existing.id)
            continue
          }
          const jobId = randomUUID()
          this.db
            .prepare(
              'INSERT INTO jobs (id,draftId,accountId,title,body,assets,fingerprint,due,created,status,videoId,coverId,coverFormats,videoTags,preferredCover) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
            )
            .run(
              jobId,
              id,
              accountId,
              title,
              body,
              JSON.stringify(assetIds),
              fingerprint,
              due ?? now,
              now,
              'queued',
              videoId,
              coverId, JSON.stringify(formats), JSON.stringify(tags), preferredCover
            )
          ids.push(jobId)
        }
      }
      return ids
    })
  }
  applyPendingCovers(draftId, revision, clip, inUse) {
    return this.atomic(() => {
      const draft = this.draft(draftId), artwork = draft.coverFormats?.[clip]
      if (!artwork || draft.revision !== revision) throw Error('请先保存本条视频的各平台封面')
      const rows = this.db.prepare("SELECT * FROM jobs WHERE draftId=? AND videoId=? AND status IN ('queued','waiting')").all(draftId,clip)
      let updated = 0, skipped = 0
      for (const job of rows) {
        const platform = this.account(job.accountId).platform
        const formats = submissionCovers(artwork,platform,job.preferredCover)
        const coverId = formats[job.preferredCover] || formats.wide || formats.portrait
        if (!coverId) continue
        const fingerprint = contentFingerprint(job.title,job.body,JSON.parse(job.assets),clip,coverId,
          formats,JSON.parse(job.videoTags),job.preferredCover)
        if (job.fingerprint === fingerprint) continue
        if (inUse(job.id) || this.db.prepare("SELECT 1 FROM jobs WHERE id<>? AND accountId=? AND fingerprint=? AND status<>'cancelled'").get(job.id,job.accountId,fingerprint)) {
          skipped++
          continue
        }
        this.db.prepare('UPDATE jobs SET coverId=?,coverFormats=?,fingerprint=? WHERE id=?').run(coverId,JSON.stringify(formats),fingerprint,job.id)
        this.db.prepare('DELETE FROM video_handoffs WHERE jobId=?').run(job.id)
        updated++
      }
      return {updated,skipped}
    })
  }
  transition(id, from, to, note = '', url = '') {
    const sql =
      'UPDATE jobs SET status=?,note=?,url=? WHERE id=? AND status IN (' +
      from.map(() => '?').join(',') +
      ')'
    if (!this.db.prepare(sql).run(to, note, url, id, ...from).changes)
      throw Error('任务状态已改变，请刷新')
  }
  reschedule(id, due, now = Date.now()) {
    if (!Number.isSafeInteger(due) || due <= now + 60000) throw Error('请选择未来的排期时间')
    const changed = this.db
      .prepare("UPDATE jobs SET due=? WHERE id=? AND status='queued' AND due>?")
      .run(due, id, now)
    if (!changed.changes) throw Error('只有尚未到点的排期任务可以改期')
    return this.job(id)
  }
  cancel(id) {
    this.transition(id, ['queued', 'waiting', 'failed'], 'cancelled')
  }
  record(id, url) {
    const j = this.job(id)
    const a = this.account(j.accountId)
    this.transition(
      id,
      ['waiting', 'uncertain'],
      'recorded',
      '本人登记，未经平台接口核验',
      receiptUrl(a, url)
    )
  }
  snapshot() {
    return {
      catalog: publicCatalog(),
      coverSizes: sizes,
      videos: this.db.prepare('SELECT id,name,size FROM videos').all(),
      accounts: this.db.prepare('SELECT ' + accountFields + ' FROM accounts ORDER BY rowid').all(),
      assets: this.db.prepare('SELECT id,name,mime,size,thumb FROM assets').all(),
      drafts: this.db
        .prepare('SELECT id FROM drafts ORDER BY updated DESC,rowid DESC')
        .all()
        .map(({ id }) => this.draft(id)),
      jobs: this.db.prepare('SELECT * FROM jobs ORDER BY created DESC,rowid').all()
    }
  }
}
module.exports = { Store, terminal }
