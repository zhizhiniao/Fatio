const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Store } = require('../src/store.cjs')
const { Library } = require('../src/library.cjs')
const nas = require('../src/nas-export.cjs')

function setup(t) {
  const store = new Store(':memory:')
  new Library(store)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fatio-nas-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = store.db
  db.prepare("INSERT INTO accounts(id,platform,name,identity,mode,secret) VALUES('a1','kuaishou','快手号','ks1','web','TOP-SECRET-TOKEN')").run()
  db.prepare("INSERT INTO accounts(id,platform,name,identity,mode) VALUES('a2','douyin','抖音号','dy1','web')").run()
  const now = Date.UTC(2026, 10, 15)
  const work = (id, acc, platform, item, postedDaysAgo) =>
    db
      .prepare('INSERT INTO native_works(id,accountId,platform,itemId,title,url,status,posted,seen) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, acc, platform, item, '作品' + item, 'https://example.com/' + item, '已发布', Math.floor((now - postedDaysAgo * 86400000) / 1000), now)
  const sample = (id, t, m) => db.prepare('INSERT INTO native_samples VALUES(?,?,?)').run(id, t, JSON.stringify({ _source: '平台回读', ...m }))
  for (const [i, v] of [[1, 3001], [2, 3118], [3, 3269]]) {
    work('k' + i, 'a1', 'kuaishou', 'k' + i, 20)
    sample('k' + i, now - 3600000, { views: v, likes: 10, comments: 1, shares: null, collects: null })
  }
  work('k4', 'a1', 'kuaishou', 'k4', 1)
  sample('k4', now - 7200000, { views: 0, likes: 0, comments: 0 })
  sample('k4', now - 7200000 + 1000, { views: 3101, likes: 3, comments: 3 })
  work('d1', 'a2', 'douyin', 'd1', 5)
  sample('d1', now - 4 * 86400000, { views: 1059, likes: 4, comments: 0, shares: 0, collects: 7 })
  return { db, dir, now }
}

test('导出不含密钥，缺失字段保持 null', (t) => {
  const { db, dir, now } = setup(t)
  nas.setSetting(db, 'dir', dir)
  const r = nas.maybeExport(db, { now })
  assert.equal(r.exported.counts.works, 5)
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
  assert.doesNotMatch(all, /TOP-SECRET-TOKEN|"secret"/)
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [])
  const metrics = JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json')))
  const ks = metrics.find((m) => m.work_id === 'wrk_kuaishou_k1')
  assert.equal(ks.shares, null)
  assert.equal(ks.collects, null)
})

test('质量标记：读数异常接近、先 0 后大数、采样过期', (t) => {
  const { db, dir, now } = setup(t)
  nas.exportSnapshot(db, dir, { now })
  const works = JSON.parse(fs.readFileSync(path.join(dir, 'works.json')))
  const flags = Object.fromEntries(works.map((w) => [w.item_id, w.quality]))
  assert.ok(flags.k1.includes('suspect_floor'))
  assert.ok(flags.k4.includes('suspect_floor'))
  assert.ok(flags.d1.includes('stale'))
  const metrics = JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json')))
  assert.equal(metrics.filter((m) => m.work_id === 'wrk_kuaishou_k4' && m.quality.includes('zero_then_jump')).length, 2)
  assert.equal(works.find((w) => w.item_id === 'd1').views_meaning, '播放')
})

test('数据不变不重复导出；没有目录时跳过', (t) => {
  const { db, dir, now } = setup(t)
  assert.equal(nas.maybeExport(db, { now }).skipped, 'no-dir')
  nas.setSetting(db, 'dir', dir)
  assert.ok(nas.maybeExport(db, { now }).exported)
  assert.equal(nas.maybeExport(db, { now }).skipped, 'unchanged')
  db.prepare('INSERT INTO native_samples VALUES(?,?,?)').run('d1', now, JSON.stringify({ views: 1100 }))
  assert.ok(nas.maybeExport(db, { now }).exported)
  assert.ok(nas.maybeExport(db, { now, force: true }).exported)
  assert.equal(nas.status(db).dir, dir)
})
