const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { Store } = require('../src/store.cjs')
const { accountInput, receiptUrl, allowedPage, xPostTextError } = require('../src/platforms.cjs')
const { runDue, identityOk } = require('../src/publisher.cjs')
const { mimeOf } = require('../src/media.cjs')
const make = () => new Store(':memory:')
const web = (s, platform = 'xiaobot', identity = 'column') =>
  s.addAccount({ platform, identity, name: '个人账号', mode: 'web' })
const direct = (s) =>
  s.addAccount(
    { platform: 'x', identity: 'example', name: '个人 X', mode: 'api' },
    'encrypted',
    '17'
  )
const values = (...ids) => ({ title: '文章', body: '内容', xText: '', targets: ids })
const addJob = (s, a, body = '内容', due = null) => {
  const d = s.save({ ...values(a.id), body })
  return s.queue(d.id, d.revision, due)[0]
}
const client = (overrides = {}) => ({
  me: async () => ({ id: '17', username: 'Example' }),
  post: async () => ({ id: '100' }),
  ...overrides
})
test('accounts normalize the expected handle and creator column', () => {
  assert.equal(
    accountInput({ platform: 'x', mode: 'web', name: 'A', identity: '@AbC' }).identity,
    'abc'
  )
  assert.equal(
    accountInput({
      platform: 'xiaobot',
      mode: 'web',
      name: 'A',
      identity: 'https://xiaobot.net/p/MyBook'
    }).identity,
    'MyBook'
  )
  assert.throws(() =>
    accountInput({ platform: 'xiaobot', mode: 'web', name: 'A', identity: '../edit' })
  )
})
test('invalid platform, duplicate identity and unverified API credentials fail', () => {
  const s = make()
  web(s)
  assert.throws(() => web(s))
  assert.throws(() => web(s, 'constructor'))
  assert.throws(() => s.addAccount({ platform: 'x', identity: 'ab', name: 'ab', mode: 'api' }))
})
test('snapshots do not disclose the stored secret', () => {
  const s = make()
  direct(s)
  assert.doesNotMatch(JSON.stringify(s.snapshot()), /encrypted|secret/)
})
test('stale draft revision is rejected', () => {
  const s = make(),
    d = s.save(values())
  s.save({ ...d, body: '新版' })
  assert.throws(() => s.save({ ...d, body: '覆盖' }), /版本/)
  assert.equal(s.draft(d.id).body, '新版')
})
test('all accounts preflight atomically and X uses weighted length', () => {
  const s = make(),
    x = direct(s),
    b = web(s),
    d = s.save({ ...values(b.id, x.id), body: '中'.repeat(141) })
  assert.throws(() => s.queue(d.id, d.revision, null))
  assert.equal(s.snapshot().jobs.length, 0)
  assert.equal(xPostTextError('中'.repeat(140)), null)
  const fixed = s.save({ ...d, xText: '短文' })
  const jobs = s.queue(d.id, fixed.revision, null)
  assert.equal(s.job(jobs[1]).body, '短文')
  assert.equal(s.job(jobs[0]).body, d.body)
})
test('double submission reuses the job, draft changes do not change its snapshot', () => {
  const s = make(),
    a = web(s),
    d = s.save(values(a.id)),
    one = s.queue(d.id, 1, null)
  assert.deepEqual(s.queue(d.id, 1, null), one)
  s.save({ ...d, body: '改稿' })
  assert.equal(s.job(one[0]).body, '内容')
})
test('future jobs wait until due. Manual handoff never marks publication', async () => {
  const s = make(),
    t = Date.now() + 120000,
    id = addJob(s, web(s), '排期', t)
  const deny = () => assert.fail('unexpected API')
  await runDue(s, deny, t - 1)
  assert.equal(s.job(id).status, 'queued')
  await runDue(s, deny, t)
  assert.equal(s.job(id).status, 'waiting')
  s.record(id, 'https://xiaobot.net/post/1234?shareFrom=x')
  assert.equal(s.job(id).status, 'recorded')
  assert.equal(s.job(id).url, 'https://xiaobot.net/post/1234')
})
test('cancellation and re-queue create just one active job', () => {
  const s = make(),
    a = web(s),
    d = s.save(values(a.id)),
    [id] = s.queue(d.id, 1, null)
  assert.throws(() => s.archive(a.id))
  s.cancel(id)
  const [newId] = s.queue(d.id, 1, null)
  assert.notEqual(newId, id)
  assert.throws(() => s.cancel(id))
})
test('archive blocks stale drafts, retains history and clears API secret', async () => {
  const s = make(),
    a = direct(s),
    d = s.save(values(a.id)),
    [id] = s.queue(d.id, 1, null)
  await runDue(s, () => client())
  s.archive(a.id)
  assert.equal(s.secret(a.id), undefined)
  assert.throws(() => s.queue(d.id, 1, null))
  assert.equal(s.job(id).status, 'published')
})
test('identity ID and handle are both required. Wrong identity makes zero posts', async () => {
  const s = make(),
    a = direct(s),
    id = addJob(s, a)
  let calls = 0
  assert.equal(identityOk({ id: '17', username: 'other' }, a), false)
  await runDue(s, () =>
    client({
      me: async () => ({ id: '18', username: a.identity }),
      post: async () => {
        calls++
      }
    })
  )
  assert.equal(calls, 0)
  assert.equal(s.job(id).status, 'failed')
})
test('simultaneous workers submit once and only retain a real response ID', async () => {
  const s = make(),
    id = addJob(s, direct(s))
  let calls = 0
  const send = () =>
    client({
      post: async () => {
        calls++
        return { id: '567' }
      }
    })
  await Promise.all([runDue(s, send), runDue(s, send)])
  assert.equal(calls, 1)
  assert.equal(s.job(id).status, 'published')
  assert.match(s.job(id).url, /example\/status\/567$/)
})
test('unknown POST outcome does not automatically retry', async () => {
  const s = make(),
    id = addJob(s, direct(s))
  await runDue(s, () =>
    client({
      post: async () => {
        throw Error('socket reset')
      }
    })
  )
  await runDue(s, () => assert.fail('retried'))
  assert.equal(s.job(id).status, 'uncertain')
  assert.throws(() => s.cancel(id))
})
test('invalid success response is unknown; deterministic API rejection can be retried', async () => {
  const s = make(),
    a = direct(s),
    id = addJob(s, a)
  await runDue(s, () =>
    client({
      post: async () => {
        throw Object.assign(Error(), { code: 429 })
      }
    })
  )
  assert.equal(s.job(id).status, 'failed')
  s.transition(id, ['failed'], 'queued')
  await runDue(s, () => client({ post: async () => ({}) }))
  assert.equal(s.job(id).status, 'uncertain')
})
test('restart keeps drafts, snapshots and converts interrupted sends to uncertain', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ja-db-')),
    file = path.join(dir, 'studio.sqlite')
  try {
    let s = new Store(file)
    const id = addJob(s, direct(s))
    s.transition(id, ['queued'], 'sending')
    s.db.close()
    s = new Store(file)
    assert.equal(s.job(id).status, 'uncertain')
    assert.equal(s.snapshot().drafts.length, 1)
    s.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('receipts reject lookalike domains, credentials, wrong account and non-post paths', () => {
  const s = make(),
    x = direct(s),
    wb = web(s, 'weibo', '123')
  for (const url of [
    'http://x.com/example/status/2',
    'https://x.com.evil.com/example/status/2',
    'https://x.com@evil.com/example/status/2',
    'https://x.com/other/status/2',
    'https://x.com/example'
  ])
    assert.throws(() => receiptUrl(x, url))
  assert.equal(receiptUrl(wb, 'https://weibo.com/123/ABc9'), 'https://weibo.com/123/ABc9')
  assert.equal(allowedPage('weibo', 'https://login.sina.com.cn/'), true)
  assert.equal(allowedPage('xiaobot', 'file:///a'), false)
})
test('image snapshot is immutable; X uploads in order before posting', async () => {
  const s = make(),
    a = direct(s)
  const ids = ['a'.repeat(64), 'b'.repeat(64)]
  ids.forEach((id) =>
    s.db
      .prepare('INSERT INTO assets VALUES(?,?,?,?,?,?)')
      .run(id, id + '.png', 'image/png', 2, 'thumb', Buffer.from('ok'))
  )
  const d = s.save({ ...values(a.id), assets: ids })
  const [job] = s.queue(d.id, 1, null)
  s.save({ ...d, assets: [] })
  let sent
  await runDue(s, () =>
    client({
      upload: async (asset) => asset.id,
      post: async (_, media) => {
        sent = media
        return { id: '5678' }
      }
    })
  )
  assert.deepEqual(sent, ids)
  assert.equal(s.job(job).status, 'published')
  assert.throws(() => s.save({ ...values(), assets: ['c'.repeat(64)] }))
})
test('image-only file extensions cannot pass the PNG/JPEG/WebP header test', () => {
  assert.throws(() => mimeOf(Buffer.from('GIF89a')))
  assert.equal(mimeOf(Buffer.from([255, 216, 255])), 'image/jpeg')
})
