const test = require('node:test')
const assert = require('node:assert/strict')
const { Store } = require('../src/store.cjs')
const { Library } = require('../src/library.cjs')
const auto = require('../src/auto-sample.cjs')

const H = 3600000
const D = 24 * H
const NOW = Date.UTC(2026, 10, 15, 12)

function setup() {
  const store = new Store(':memory:')
  new Library(store)
  const db = store.db
  db.exec('CREATE TABLE IF NOT EXISTS creator_logins(accountId TEXT PRIMARY KEY)')
  const acc = (id, platform, login = true) => {
    db.prepare('INSERT INTO accounts(id,platform,name,identity,mode) VALUES(?,?,?,?,?)').run(id, platform, id, id, 'web')
    if (login) db.prepare('INSERT INTO creator_logins VALUES(?)').run(id)
  }
  const work = (id, acc, agoMs) =>
    db
      .prepare('INSERT INTO native_works(id,accountId,platform,itemId,title,url,status,posted,seen) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, acc, 'xhs', id, id, 'https://x/' + id, '已发布', Math.floor((NOW - agoMs) / 1000), NOW)
  const sample = (id, t) => db.prepare('INSERT INTO native_samples VALUES(?,?,?)').run(id, t, '{"views":1}')
  return { db, acc, work, sample }
}

test('到了 24 小时时点且之后没有采样，排进队列', () => {
  const { db, acc, work, sample } = setup()
  acc('a', 'xhs')
  work('w', 'a', 25 * H)
  sample('w', NOW - 23 * H) // 发布后 2 小时采过一次
  const p = auto.plan(db, NOW)
  assert.equal(p.length, 1)
  assert.ok(p[0].reasons.includes('checkpoint'))
})

test('时点之后已采过样就不再读；失败后等待、成功后间隔 30 分钟', () => {
  const { db, acc, work, sample } = setup()
  acc('a', 'xhs')
  work('w', 'a', 25 * H)
  sample('w', NOW - 30 * 60000)
  assert.equal(auto.plan(db, NOW).length, 0)
  const { db: db2, acc: acc2, work: work2 } = setup()
  acc2('b', 'xhs')
  work2('w', 'b', 25 * H)
  auto.record(db2, 'b', false, '超时', NOW - H)
  assert.equal(auto.plan(db2, NOW).length, 0, '失败 1 小时内不重试')
  assert.equal(auto.plan(db2, NOW + 1.5 * H).length, 1, '失败 2 小时后重试')
  auto.record(db2, 'b', true, 'ok', NOW)
  assert.equal(auto.plan(db2, NOW + 10 * 60000).length, 0)
})

test('读过一次后，首页以外读不到的老作品不会让账号反复被读', () => {
  const { db, acc, work } = setup()
  acc('a', 'xhs')
  work('old', 'a', 10 * D) // 从未采样
  assert.ok(auto.plan(db, NOW)[0].reasons.includes('daily'))
  auto.record(db, 'a', true, 'ok', NOW)
  assert.equal(auto.plan(db, NOW + 2 * H).length, 0)
  assert.equal(auto.plan(db, NOW + 25 * H).length, 1, '一天后再读')
})

test('没登录、已归档、正在被用户操作、超过 31 天的账号或作品跳过；可以关闭', () => {
  const { db, acc, work } = setup()
  acc('nologin', 'xhs', false)
  work('w1', 'nologin', 25 * H)
  acc('busy', 'xhs')
  work('w2', 'busy', 25 * H)
  acc('old', 'xhs')
  work('w3', 'old', 40 * D)
  acc('gone', 'xhs')
  work('w4', 'gone', 25 * H)
  db.prepare("UPDATE accounts SET archived=1 WHERE id='gone'").run()
  assert.deepEqual(auto.plan(db, NOW, new Set(['busy'])), [])
  assert.equal(auto.enabled(db), true)
  auto.setEnabled(db, false)
  assert.equal(auto.enabled(db), false)
})

test('近 48 小时有发布任务的账号每小时读一次，优先于普通每日采样', () => {
  const { db, acc, work } = setup()
  acc('daily', 'xhs')
  work('w', 'daily', 10 * D)
  acc('fresh', 'xhs')
  const d = db.prepare("INSERT INTO drafts(id,content,revision,updated) VALUES('d','{}',1,0)").run()
  db.prepare(
    "INSERT INTO jobs(id,draftId,accountId,title,body,fingerprint,due,created,status) VALUES('j','d','fresh','t','b','f',?,?,'published')"
  ).run(NOW - 3 * H, NOW - 3 * H)
  const p = auto.plan(db, NOW)
  assert.equal(p[0].id, 'fresh')
  assert.ok(p[0].reasons.includes('new-post'))
  auto.record(db, 'fresh', true, 'ok', NOW)
  assert.ok(!auto.plan(db, NOW + 40 * 60000).some((x) => x.id === 'fresh'))
  assert.ok(auto.plan(db, NOW + 61 * 60000).some((x) => x.id === 'fresh'))
})
