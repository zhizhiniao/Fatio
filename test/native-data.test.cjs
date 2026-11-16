const test = require('node:test'),
  assert = require('node:assert/strict')
const { Store } = require('../src/store.cjs'),
  { Library } = require('../src/library.cjs')
const { bilibili, reportItems } = require('../src/platform-data.cjs'),
  { checkPage } = require('../src/public-work.cjs')
const { sessionClient } = require('../src/douyin.cjs')
const base = { title: '标题', body: '稿件', xText: '', assets: [], targets: [] }
function setup() {
  const s = new Store(':memory:'),
    l = new Library(s),
    a = s.addAccount({ platform: 'douyin', identity: 'myname', name: '甲', mode: 'web' })
  l.identify(a.id, { uid: '100', handle: 'myname' })
  return { s, l, a }
}
test('native identities dedupe past posts across rename, weak lists preserve strong details', () => {
  const { s, l, a } = setup(),
    d = s.save({ ...base, targets: [a.id] }),
    [j] = s.queue(d.id, 1, null)
  s.transition(j, ['queued'], 'waiting')
  let [w] = l.writeItems(a.id, [{ itemId: '456', status: '已发布', views: 35, likes: 2 }], '100')
  l.link(j, w.id)
  ;[w] = l.writeItems(a.id, [{ itemId: '456', status: '平台已有记录', likes: null }], '100')
  assert.equal(s.job(j).status, 'published')
  assert.equal(w.views, 35)
  assert.equal(w.likes, 2)
  assert.ok(w._times.views < w.seen)
  s.archive(a.id)
  s.finishArchive(a.id)
  const b = s.addAccount({ platform: 'douyin', identity: 'renamed', name: '乙', mode: 'web' })
  l.identify(b.id, { uid: '100', handle: 'renamed' })
  const next = s.save({ ...base, targets: [b.id] })
  assert.deepEqual(s.queue(next.id, 1, null), [j])
})
test('committed native submission locks retry, receipt mismatch never binds wrong work', () => {
  const { s, l, a } = setup(),
    d = s.save({ ...base, targets: [a.id] }),
    [j] = s.queue(d.id, 1, null)
  s.transition(j, ['queued'], 'waiting')
  assert.ok(l.submitting(j, '100'))
  assert.throws(() => s.cancel(j))
  l.candidate(j, '100', '777')
  const [wrong] = l.writeItems(a.id, [{ itemId: '888', status: '已发布' }], '100')
  assert.throws(() => l.link(j, wrong.id), /冲突/)
  assert.equal(s.job(j).status, 'uncertain')
  assert.deepEqual(s.queue(d.id, 1, null), [j])
})
test('mixed author fields, mismatched parallel lists and nonzero nested business codes fail closed', async () => {
  for (const bad of [
    { BaseResp: { StatusCode: 8 }, items: [] },
    {
      aweme_list: [{ aweme_id: '222', author: { uid: '999' } }],
      items: [{ id: '222', user_id: '111' }]
    },
    { items: [{ id: '222', user_id: '111', author: { uid: '999' } }] }
  ]) {
    const client = sessionClient(async (url) => (url.includes('work_list') ? bad : { uid: '111' }))
    await assert.rejects(client.recent('111'))
  }
})
test('creative formats share one project, explicit versions restore without losing the previous state', () => {
  const { s, l } = setup(),
    a = s.save(base)
  l.saveNotes(a.id, '选题', '参考资料')
  const v = l.variant(a.id, 'video')
  assert.equal(l.variant(v.id, 'article').id, a.id)
  assert.deepEqual({ ...l.notes(v.id) }, { idea: '选题', refs: '参考资料' })
  l.version(a.id)
  const newer = s.save({ ...a, body: '修订稿' })
  assert.throws(() => l.restore(a.id, 1, 1), /更新/)
  const restored = l.restore(a.id, 1, newer.revision)
  assert.equal(restored.body, '稿件')
  assert.equal(restored.projectId, v.projectId)
  assert.equal(l.versions(a.id).length, 2)
})
test('Bilibili checks returned video ID, author UID, business error and missing metrics', async () => {
  const a = { identity: '22', platform: 'bilibili' },
    url = 'https://www.bilibili.com/video/BV17x411w7KC'
  const send = (code, mid, id) => async () => ({
    ok: true,
    json: async () => ({
      code,
      data: { owner: { mid }, aid: 5, bvid: id, stat: { view: 35, like: 0, favorite: '--' } }
    })
  })
  const w = await bilibili(a, url, send(0, 22, 'BV17x411w7KC'))
  assert.equal(w.views, 35)
  assert.equal(w.likes, 0)
  assert.equal(w.collects, null)
  await assert.rejects(bilibili(a, url, send(0, 23, 'BV17x411w7KC')), /UID/)
  await assert.rejects(bilibili(a, url, send(-400, 22, 'BV17x411w7KC')))
})
test('other platforms require exact author and work in both public-page and CSV paths', () => {
  const a = { platform: 'tiktok', identity: 'artist' },
    url = 'https://www.tiktok.com/@artist/video/987654321'
  const item = { itemId: '987654321', owner: ['ARTIST'], views: 3 }
  assert.equal(checkPage(a, url, item).views, 3)
  assert.throws(() => checkPage(a, url, { ...item, owner: ['other'] }))
  assert.throws(() => checkPage(a, url, { ...item, itemId: '22' }))
  const csv = (who) =>
    Buffer.from(
      'Username,Video URL,Snapshot time,Video views,Likes\n' + who + ',' + url + ',2026-08-01,12,0'
    )
  assert.equal(reportItems(a, csv('artist'))[0].likes, 0)
  assert.throws(() => reportItems(a, csv('other')))
})
test('a prior release receipt is backfilled by exact URL and returns to its original draft', () => {
  const s = new Store(':memory:'),
    a = s.addAccount({ platform: 'xiaobot', mode: 'web', identity: 'book', name: '书' })
  const d = s.save({ ...base, targets: [a.id] }),
    [id] = s.queue(d.id, 1, null)
  s.transition(id, ['queued'], 'waiting')
  s.record(id, 'https://xiaobot.net/post/owned')
  const l = new Library(s)
  assert.equal(l.works()[0].draftId, d.id)
  l.backfill()
  assert.equal(l.works().length, 1)
})
