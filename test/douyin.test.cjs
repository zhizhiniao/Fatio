const test = require('node:test'),
  assert = require('node:assert/strict')
const { sessionClient } = require('../src/douyin.cjs'),
  { createdId } = require('../src/douyin-window.cjs')
const { Store } = require('../src/store.cjs'),
  { Library } = require('../src/library.cjs')
const uid = '7111111111111111111',
  ids = ['7222222222222222221', '7222222222222222222']
function response(url) {
  const u = new URL(url)
  if (u.pathname.includes('/pc/user/info'))
    return { uid, status_code: 0, user_profile: { nick_name: '测试' } }
  if (u.pathname.includes('/creator/user/info'))
    return { uid, user_profile: { unique_id: 'studio' } }
  if (u.pathname.includes('/pc/work_list'))
    return {
      status_code: 0,
      aweme_list: ids.map((id) => ({ aweme_id: id, author: { uid }, desc: id })),
      items: [
        { id: ids[1], metrics: { view_count: 15 } },
        { id: ids[0], metrics: { view_count: 0 } }
      ],
      has_more: 1,
      max_cursor: '55'
    }
  return {
    items: [
      { id: ids[1], metrics: { view_count: 1 } },
      {
        id: ids[0],
        user_id: uid,
        metrics: { view_count: 16, comment_count: 0 },
        review: { status: 2 }
      }
    ]
  }
}
test('Douyin authenticates the effective PC UID and joins metrics by exact 64-bit work ID', async () => {
  const c = sessionClient(async (url) => response(url))
  assert.equal((await c.who()).uid, uid)
  const list = await c.recent(uid)
  assert.deepEqual(
    list.items.map((w) => w.views),
    [0, 15]
  )
  assert.equal(list.cursor, '55')
  const detail = await c.detail(uid, ids[0])
  assert.equal(detail.views, 16)
  assert.equal(detail.likes, null)
  assert.equal(detail.comments, 0)
})
test('business login error and mid-read account switch never become empty analytics', async () => {
  await assert.rejects(sessionClient(async () => ({ status_code: 8, items: [] })).who(), /登录/)
  let n = 0
  const c = sessionClient(async (url) => {
    const v = response(url)
    if (url.includes('/pc/user/info') && ++n > 1) v.uid = '880'
    return v
  })
  await assert.rejects(c.recent(uid), /切换|改变/)
})
test('rejects wrong author and wrong returned work ID', async () => {
  const c = sessionClient(async (url) => {
    const r = response(url)
    if (url.includes('/item/mget')) r.items = [{ id: ids[0], user_id: '7' }]
    return r
  })
  await assert.rejects(c.detail(uid, ids[0]), /作者/)
  await assert.rejects(c.detail(uid, ids[1]), /未返回/)
})
test('only successful unambiguous native create receipts are accepted and no integer is rounded', () => {
  assert.equal(createdId('{"status_code":0,"item_id":7222222222222222221}'), ids[0])
  assert.equal(createdId(JSON.stringify({ status_code: 0, aweme: { aweme_id: ids[1] } })), ids[1])
  assert.equal(createdId('{"status_code":8,"item_id":7222222222222222221}'), '')
  assert.equal(
    createdId(JSON.stringify({ status_code: 0, item_id: ids[0], aweme: { aweme_id: ids[1] } })),
    ''
  )
})
test('one exact job/remote work link, revision snapshot history, and account isolation', () => {
  const store = new Store(':memory:'),
    lib = new Library(store),
    a = store.addAccount({ platform: 'douyin', mode: 'web', identity: 'studio', name: '账号' })
  lib.identify(a.id, { uid, handle: 'studio', name: '账号' })
  const b = store.addAccount({
    platform: 'douyin',
    mode: 'web',
    identity: 'other',
    name: '另一个账号'
  })
  assert.throws(() => lib.identify(b.id, { uid, handle: 'other' }), /同一/)
  lib.identify(b.id, { uid: '88', handle: 'other' })
  const d = store.save({ title: '相同标题', xText: '', body: '内容', targets: [a.id] })
  const [j] = store.queue(d.id, 1, null)
  store.transition(j, ['queued'], 'waiting')
  let [w] = lib.writeItems(
    a.id,
    [{ itemId: ids[0], title: '相同标题', status: '审核中', views: null }],
    uid
  )
  assert.equal(w.jobId, null)
  lib.link(j, w.id)
  assert.equal(store.job(j).status, 'recorded')
  lib.writeItems(a.id, [{ itemId: ids[0], title: '同一条', status: '已发布', views: 35 }], uid)
  assert.equal(store.job(j).status, 'published')
  assert.equal(lib.works(a.id)[0].draftId, d.id)
  assert.throws(() => lib.writeItems(a.id, [], '88'), /变化/)
  const [foreign] = lib.writeItems(
    b.id,
    [{ itemId: ids[1], title: '相同标题', status: '已发布' }],
    '88'
  )
  assert.throws(() => lib.link(j, foreign.id), /同一账号/)
})
