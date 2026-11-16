const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { Store } = require('../src/store.cjs')
const { platforms, publicCatalog } = require('../src/catalog.cjs')
const { importVideos, videoPath } = require('../src/videos.cjs')
const { bindings, dispatchHub, reconcileHub, resolveMissing } = require('../src/creatorhub.cjs')
const { importReport, performance, readCreator, readReview } = require('../src/insights.cjs')
const { reviewClient } = require('../src/review-live.cjs')
const easel = require('../src/easel.cjs')
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ja-bridge-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }))
  return root
}
const stock = (ids, extra = {}) => ({
  title: '测试',
  body: '双平台',
  xText: '',
  targets: ids,
  ...extra
})
test('linking an existing web account preserves history and never changes the mode of a pending task', () => {
  const s = new Store(':memory:')
  const a = s.addAccount({ platform: 'douyin', name: '我的账号', identity: 'owner', mode: 'web' })
  const d = s.save(stock([a.id])),
    [id] = s.queue(d.id, 1, null)
  const binding = {
    platform: 'douyin',
    name: '外部名称',
    identity: 'owner',
    binding: 'hub:5:' + 'a'.repeat(24)
  }
  assert.throws(() => s.bindHub(binding), /待处理/)
  s.cancel(id)
  assert.equal(s.bindHub(binding).id, a.id)
  assert.equal(s.bindHub(binding).mode, 'creatorhub')
  assert.equal(s.job(id).accountId, a.id)
  assert.equal(s.snapshot().accounts.length, 1)
})
const web = (s, platform) =>
  s.addAccount({
    platform,
    identity: platform === 'bilibili' ? '1234' : 'owner',
    name: platform,
    mode: 'web'
  })
function asset(s) {
  const id = 'a'.repeat(64)
  s.db
    .prepare('INSERT INTO assets VALUES(?,?,?,?,?,?)')
    .run(id, 'pic.png', 'image/png', 3, 'thumb', Buffer.from('abc'))
  return id
}
function writeVideo(file, n = 1) {
  const bytes = Buffer.alloc(50, n)
  bytes.write('ftyp', 4)
  fs.writeFileSync(file, bytes)
}
test('catalog has separate post/video routes for twelve platforms', () => {
  assert.equal(Object.keys(publicCatalog()).length, 12)
  for (const p of ['douyin', 'kuaishou', 'tiktok', 'bilibili'])
    assert.match(platforms[p].video, /^https:/)
  assert.equal(platforms.tiktok.article, undefined)
})
test('v1 draft and job schema migration keeps earlier fingerprint and records', (t) => {
  const file = path.join(temp(t), 'v1.sqlite'),
    db = new DatabaseSync(file)
  db.exec(
    "CREATE TABLE jobs(id TEXT PRIMARY KEY,draftId TEXT,accountId TEXT,title TEXT,body TEXT,assets TEXT,fingerprint TEXT,due INTEGER,created INTEGER,status TEXT,note TEXT,url TEXT); INSERT INTO jobs VALUES('old','d','a','标题','正文','[]','original',0,0,'recorded','','https://xiaobot.net/post/old')"
  )
  db.close()
  const s = new Store(file)
  assert.equal(s.job('old').fingerprint, 'original')
  assert.equal(s.job('old').videoId, null)
  s.db.close()
})
test('batch yields one immutable job per distinct video and account; damaged cache can be repaired', async (t) => {
  const root = temp(t),
    s = new Store(':memory:'),
    dir = path.join(root, 'videos'),
    f1 = path.join(root, '一.mp4'),
    f2 = path.join(root, '二.mp4')
  writeVideo(f1, 1)
  writeVideo(f2, 2)
  const vids = await importVideos(s, dir, [f1, f2, f1])
  const a = web(s, 'douyin'),
    b = web(s, 'bilibili')
  const d = s.save(
    stock([a.id, b.id], {
      kind: 'video',
      videos: vids,
      variants: { bilibili: { title: 'B站标题', body: 'B站简介' } }
    })
  )
  const ids = s.queue(d.id, 1, null)
  assert.equal(ids.length, 4)
  assert.deepEqual(s.queue(d.id, 1, null), ids)
  assert.equal(s.job(ids[2]).title, 'B站标题')
  const copied = await videoPath(s, dir, ids[0])
  fs.writeFileSync(copied, Buffer.alloc(50))
  await assert.rejects(videoPath(s, dir, ids[0]), /改变/)
  await importVideos(s, dir, [f1])
  assert.equal(await videoPath(s, dir, ids[0]), copied)
  const bad = s.save({ ...d, targets: [a.id, web(s, 'wechat').id] })
  assert.throws(() => s.queue(d.id, bad.revision, null))
  assert.equal(s.snapshot().jobs.length, 4)
})
test('YiMei imports are atomic and idempotent, dashboard uses only latest snapshots on the same day', () => {
  const s = new Store(':memory:')
  const csv = Buffer.from(
    '账号,平台,总收益,昨日收益,总播放量,昨日播放量,粉丝数,昨日评论,昨日点赞,昨日涨粉,更新时间\n一,抖音,12.1,1,600,22,8,0,3,1,2026-11-02 10:00\n一,抖音,12.2,1.1,610,32,8,0,3,1,2026-11-02 12:00\n二,B站,2,0,200,5,7,1,2,--,2026-11-02 09:00\n三,快手,10,0,100,27,9,1,1,1,2026-10-30 09:00'
  )
  assert.equal(importReport(s, csv), 4)
  importReport(s, csv)
  assert.equal(s.db.prepare('SELECT count(*) n FROM reports').get().n, 4)
  const r = performance(s)
  assert.equal(r.count, 2)
  assert.equal(r.totals.yesterdayViews, 37)
  assert.equal(r.totals.yesterdayFollowers, null)
  assert.throws(() =>
    importReport(s, Buffer.from(csv.toString() + '\n四,抖音,错,1,1,2,3,4,5,6,2026-11-02'))
  )
  assert.equal(s.db.prepare('SELECT count(*) n FROM reports').get().n, 4)
})
test('Douyin reference history is separate and deduplicates across different actions', (t) => {
  const root = temp(t)
  fs.writeFileSync(
    path.join(root, 'accounts.json'),
    JSON.stringify({ accounts: [{ id: 'default', nickname: '样本' }] })
  )
  fs.writeFileSync(
    path.join(root, 'records.json'),
    JSON.stringify({
      schemaVersion: 2,
      records: {
        watch_history: [{ videoId: '1' }, { videoId: '1' }],
        liked_videos: [{ videoId: '1' }],
        favorite_videos: [{ videoId: '2' }]
      }
    })
  )
  const [r] = readReview(root)
  assert.deepEqual([r.watched, r.liked, r.favorites, r.unique], [2, 1, 1, 2])
})
test('live collector uses the paired read contract and rejects same-slot account switching', async () => {
  let calls = 0,
    changed = false
  const read = reviewClient(
    async () => 'http://127.0.0.1:42',
    async (o, route, token, input) => {
      if (route === '/v1/pairing-code') return { code: 'demo' }
      if (route === '/v1/pair') return { token: 'fixture', expiresInSeconds: 120 }
      assert.equal(token, 'fixture')
      if (route === '/v1/accounts') {
        calls++
        return {
          activeId: 'default',
          accounts: [
            {
              id: 'default',
              uid: changed && calls % 2 === 0 ? 'other' : 'abc',
              nickname: '测试账号'
            }
          ]
        }
      }
      assert.deepEqual(input.requests, [{ key: 'dashboard', params: { recent_days: 7 } }])
      return {
        results: [
          {
            ok: true,
            data: { data: { metrics: [{ english_metric_name: 'play_cnt', metric_value: 52 }] } }
          }
        ]
      }
    }
  )
  assert.deepEqual((await read()).metrics, [{ label: '播放量', value: 52 }])
  changed = true
  await assert.rejects(read(), /身份/)
})
test('Easel honors deliverable order, exports a new project, excludes system folders and escapes', async (t) => {
  const root = temp(t),
    s = new Store(':memory:'),
    p = path.join(root, '正式项目')
  for (const k of ['正式项目', '_login', 'analytics']) fs.mkdirSync(path.join(root, k))
  fs.writeFileSync(path.join(p, '稿.md'), '# 标题\n\n文字')
  fs.writeFileSync(
    path.join(p, '.easel.json'),
    JSON.stringify({ title: '标题', deliverables: ['不存在.md', '稿.md'] })
  )
  assert.equal(easel.projects(root).length, 1)
  assert.throws(() => easel.project(root, '_login'))
  const d = await easel.importProject(s, root, '正式项目', '稿.md', { images: () => [] })
  assert.equal(d.body, '文字')
  const key = await easel.exportProject(s, root, d.id, root)
  assert.ok(key.startsWith('Fatio-'))
  assert.equal(easel.project(root, key).items[0].name, '正文.md')
  fs.renameSync(path.join(root, key), path.join(root, key.replace(/^Fatio-/, 'JAStudio-')))
  await assert.rejects(easel.exportProject(s, root, d.id, root), /已存在/)
  fs.writeFileSync(path.join(p, '.easel.json'), JSON.stringify({ deliverables: ['../秘密.md'] }))
  assert.throws(() => easel.project(root, '正式项目'), /无效|越界/)
})
function hubFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ja-bridge-')),
    file = path.join(root, 'creatorhub.db'),
    db = new DatabaseSync(file),
    store = new Store(':memory:')
  db.exec(
    "CREATE TABLE douyinaccount(id INTEGER,platform TEXT,nickname TEXT,uid TEXT,sec_uid TEXT,douyin_id TEXT,status TEXT,created_at TEXT); INSERT INTO douyinaccount VALUES(5,'douyin','样本','uid','sec','name','active','2026-01-01 00:00:00'); CREATE TABLE publishtask(id INTEGER PRIMARY KEY,platform TEXT,account_id INTEGER,status TEXT,result_url TEXT,title TEXT,desc TEXT,media_type TEXT,media_json TEXT,visibility TEXT,created_at TEXT);"
  )
  t.after(() => {
    db.close()
    store.db.close()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 })
  })
  const [b] = bindings(file)
  const a = store.addAccount(
    { platform: b.platform, mode: 'creatorhub', name: b.name, identity: b.identity },
    null,
    b.binding
  )
  const d = store.save(stock([a.id], { assets: [asset(store)] }))
  const [id] = store.queue(d.id, 1, null)
  let failResponse = false,
    attempts = 0
  const options = {
    file,
    imageRoot: root,
    request: async (o, route, body) => {
      if (route === '/openapi.json')
        return {
          info: { title: 'CreatorHub' },
          paths: { '/api/accounts': { get: {} }, '/api/publish': { post: {} } }
        }
      if (route.startsWith('/api/accounts?'))
        return [
          {
            id: 5,
            platform: 'douyin',
            status: 'active',
            has_storage: true,
            sec_uid: 'sec',
            created_at: '2026-01-01T00:00:00'
          }
        ]
      attempts++
      db.prepare('INSERT INTO publishtask VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        7,
        'douyin',
        5,
        'pending',
        '',
        body.title,
        body.desc,
        body.media_type,
        JSON.stringify(body.media_paths),
        'public',
        new Date().toISOString().replace('T', ' ').replace('Z', '')
      )
      if (failResponse) throw Error('timeout')
      return { id: 7, account_id: 5, platform: 'douyin' }
    }
  }
  return {
    db,
    store,
    file,
    id,
    options,
    lose: () => {
      failResponse = true
    },
    attempts: () => attempts
  }
}
test('CreatorHub acceptance is distinct from publication; media mismatch never claims a receipt', async (t) => {
  const h = hubFixture(t)
  await dispatchHub(h.store, h.store.job(h.id), h.options)
  assert.equal(h.store.job(h.id).status, 'hub_pending')
  h.db.exec(
    "UPDATE publishtask SET status='done',result_url='https://www.douyin.com/video/234',media_json='[\"wrong.mp4\"]'"
  )
  reconcileHub(h.store, h.file)
  assert.equal(h.store.job(h.id).status, 'uncertain')
  const payload = JSON.parse(h.store.db.prepare('SELECT payload FROM hub_attempts').get().payload)
  h.db.prepare('UPDATE publishtask SET media_json=?').run(JSON.stringify(payload.media_paths))
  reconcileHub(h.store, h.file)
  assert.equal(h.store.job(h.id).status, 'published')
})
test('lost CreatorHub acceptance is recovered from matching materials; pending cannot release dedupe', async (t) => {
  const h = hubFixture(t)
  h.lose()
  await dispatchHub(h.store, h.store.job(h.id), h.options)
  assert.equal(h.store.job(h.id).status, 'uncertain')
  assert.throws(() => resolveMissing(h.store, h.file, h.id))
  assert.equal(h.store.job(h.id).status, 'hub_pending')
  h.db.exec("UPDATE publishtask SET status='done',result_url='https://www.douyin.com/video/345'")
  reconcileHub(h.store, h.file)
  assert.equal(h.store.job(h.id).status, 'published')
  assert.equal(h.attempts(), 1)
})
