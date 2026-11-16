const { test } = require('node:test')
const assert = require('node:assert/strict')
const { notes } = require('../src/xhs.cjs')
const { works: ks } = require('../src/kuaishou.cjs')
const { archives } = require('../src/bili-studio.cjs')
const { works: tiktok } = require('../src/tiktok-studio.cjs')
const channels = require('../src/channels-data.cjs')
const { receiptUrl } = require('../src/platforms.cjs')
const { canonicalId } = require('../src/platform-data.cjs')
test('published lists reject foreign authors and preserve unknown readings', () => {
  const id = '611111111111111111111111',
    raw = (d) => ({ code: 0, data: d })
  const x = { id, user_id: id, view_count: 0 }
  assert.equal(notes(raw({ notes: [x], page: -1 }), id, '0').items[0].likes, null)
  assert.equal(notes(raw({ notes: [], page: -1 }), id, '0').next, null)
  assert.throws(() => notes(raw({ notes: [x] }), 'another', '0'), /作者/)
  const k = {
    result: 1,
    list: [{ workId: 'ab', userId: '12', playCount: 0 }],
    nextCursor: 'no_more'
  }
  assert.equal(ks(k, '12').items[0].views, 0)
  assert.throws(() => ks(k, '13'), /作者/)
  const data = {
    arc_audits: [
      { Archive: { mid: 12, bvid: 'BV1234', state: 0 }, stat: { view: 0 } },
      { Archive: { mid: 12, state: -1 } }
    ],
    page: { pn: 1, ps: 2, count: 5 }
  }
  assert.equal(archives(data, { uid: '12' }).next, '2')
  assert.equal(archives(data, { uid: '12' }).items.length, 1)
  assert.throws(() => archives(data, { uid: '13' }), /作者/)
})
test('TikTok Studio keeps long IDs exact and excludes scheduled and unfinished posts', () => {
  const user = { uid: '9001', handle: 'example' }
  const row = { status: 102, item_id: '7333333333333333333', author_id: user.uid, play_count: 0 }
  const list = {
    status_code: 0,
    item_list: [
      row,
      { ...row, status: 100 },
      { ...row, async_post: {} },
      { ...row, post_time: Math.ceil(Date.now() / 1000) + 60 }
    ],
    cursor: 42,
    has_more: true
  }
  const page = tiktok(list, user, '0')
  assert.deepEqual(
    page.items.map((w) => w.itemId),
    [row.item_id]
  )
  assert.equal(page.items[0].views, 0)
  assert.equal(page.items[0].likes, null)
  assert.equal(page.next, '42')
  const photo = {
    ...row,
    status: 144,
    visibility: 2,
    photo_list: [{}],
    in_review: false,
    favorite_count: '0'
  }
  const personal = tiktok({ ...list, item_list: [photo] }, user, '0').items[0]
  assert.equal(personal.status, '仅自己可见')
  assert.equal(personal.url, 'https://www.tiktok.com/@example/photo/' + row.item_id)
  assert.equal(personal.collects, 0)
  assert.throws(() => tiktok(list, user, '42'), /游标/)
  assert.throws(
    () => tiktok({ ...list, item_list: [{ ...row, author_id: '2' }] }, user, '0'),
    /作者/
  )
  assert.throws(
    () => tiktok({ ...list, item_list: [{ ...row, item_id: Number(row.item_id) }] }, user, '0'),
    /编号/
  )
  assert.throws(() => tiktok({ status_code: 8, item_list: [] }, user, '0'), /账号/)
})
test('视频号作品的非公开编号逐字匹配，零值和未返回的指标分别保留', () => {
  const uid = 'studio@finder',
    id = 'abc/123+xyz='
  const raw = {
    errCode: 0,
    data: {
      list: [{ objectId: id, finderUsername: uid, readCount: 0, desc: { description: '已有作品' } }]
    }
  }
  const [work] = channels.items(raw, { uid })
  const link = receiptUrl({ platform: 'channels' }, work.url)
  assert.equal(canonicalId('channels', link), id)
  assert.equal(work.views, 0)
  assert.equal(work.likes, null)
  assert.throws(() => channels.items(raw, { uid: 'another' }), /作者/)
  assert.throws(() =>
    receiptUrl(
      { platform: 'channels' },
      'https://channels.weixin.qq.com.evil.example/platform/post/list?objectId=test'
    )
  )
})
