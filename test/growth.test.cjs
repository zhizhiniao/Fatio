const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { readGrowth } = require('../src/growth.cjs')
const { notes } = require('../src/xhs.cjs')

test('growth compares like-for-like readings, skips carried fields, and respects calendar windows', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE native_works(id,accountId); CREATE TABLE native_samples(workId,time,metrics);
    CREATE TABLE follower_samples(accountId,time,followers); CREATE TABLE follower_daily(accountId,day,change);
    INSERT INTO native_works VALUES ('old','A'),('new','A'),('other','B')`)
  const day = d => new Date(2026,10,d,12).getTime()
  const add = (id, d, readings) => db.prepare('INSERT INTO native_samples VALUES(?,?,?)').run(id,day(d),JSON.stringify(readings))
  add('old',2,{likes:2})
  add('old',6,{likes:5, comments:1})
  add('old',9,{likes:4, comments:1, _times:{comments:day(6)}})
  add('old',10,{likes:4})
  add('new',10,{likes:80})
  add('other',9,{likes:0})
  add('other',10,{likes:0})
  for (const a of ['A','B']) for (const [d,v] of [[6,10],[10,12]]) db.prepare('INSERT INTO follower_samples VALUES(?,?,?)').run(a,day(d),v)
  db.exec("INSERT INTO follower_daily VALUES('A','2026-11-10',-1),('A','2026-11-09',0)")
  const windows = readGrowth(db,day(11))
  const a = windows[7].accounts.A, b = windows[7].accounts.B
  assert.deepEqual(a.likes,{comparable:1,change:-1,daily:{'2026-11-09':-1,'2026-11-10':0}})
  assert.equal(a.comments,undefined)
  assert.equal(windows[30].accounts.A.likes.change,2)
  assert.equal(b.likes.change,0)
  assert.equal(a.followers.change,-1)
  assert.equal(b.followers.change,2)
  assert.equal(windows[7].days[0],'2026-11-05')
  db.close()
})
test('XHS manager covers use the secure CDN URL and preserve its query', () => {
  const id='611111111111111111111111'
  const image='http://sns-na-i6.xhscdn.com/cover?size=480'
  const page=notes({data:{notes:[{id,images_list:[{url:image}]}]}},id,'0')
  assert.equal(page.items[0].coverUrl,'https://sns-na-i6.xhscdn.com/cover?size=480')
})
