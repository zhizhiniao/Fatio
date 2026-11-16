const test = require('node:test')
const assert = require('node:assert/strict')
const nock = require('nock').default
const { Store } = require('../src/store.cjs')
const { xClient, runDue } = require('../src/publisher.cjs')
const { accountInput } = require('../src/platforms.cjs')
const account = { platform: 'x', mode: 'api', identity: 'writer', name: '账号' }
const draft = (a, body = '同一帖') => ({ title: '', body, xText: '', targets: [a.id] })
function job(store, a, body) {
  const d = store.save(draft(a, body))
  return store.queue(d.id, d.revision, null)[0]
}
test('X SDK calls the signed identity, media and write endpoints with exact post payload', async () => {
  nock.disableNetConnect()
  const keys = {
    appKey: 'key',
    appSecret: 'secret',
    accessToken: 'token',
    accessSecret: 'tokenSecret'
  }
  try {
    const mock = nock('https://api.x.com')
      .matchHeader('authorization', /^OAuth /)
      .get('/2/users/me')
      .reply(200, { data: { id: '7', username: 'writer' } })
      .post('/2/media/upload/initialize', {
        media_type: 'image/png',
        total_bytes: 3,
        media_category: 'tweet_image'
      })
      .reply(200, { data: { id: '55' } })
      .post('/2/media/upload/55/append')
      .reply(200, { data: {} })
      .post('/2/media/upload/55/finalize')
      .reply(200, { data: { id: '55' } })
      .post('/2/tweets', { text: '测试输入', media: { media_ids: ['55'] } })
      .reply(201, { data: { id: '88' } })
    const client = xClient(keys)
    assert.equal((await client.me()).id, '7')
    const media = await client.upload({ mime: 'image/png', bytes: Buffer.from('abc') })
    assert.deepEqual(await client.post('测试输入', [media]), { id: '88' })
    assert.ok(mock.isDone(), JSON.stringify(mock.pendingMocks()))
  } finally {
    nock.cleanAll()
    nock.enableNetConnect()
  }
})
test('rebinding preserves dedupe across web/API and stable remote IDs across rename', async () => {
  const s = new Store(':memory:')
  let a = s.addAccount({ ...account, mode: 'web' })
  const original = job(s, a)
  await runDue(s, () => assert.fail())
  s.record(original, 'https://x.com/writer/status/65')
  s.archive(a.id)
  s.finishArchive(a.id)
  a = s.addAccount(account, 'test', '7')
  assert.equal(job(s, a), original)
  const second = job(s, a, '第二帖')
  await runDue(s, () => ({
    me: async () => ({ id: '7', username: 'writer' }),
    post: async () => ({ id: '66' })
  }))
  s.archive(a.id)
  s.finishArchive(a.id)
  a = s.addAccount({ ...account, identity: 'new_writer' }, 'test', '7')
  assert.equal(job(s, a, '第二帖'), second)
  assert.equal(s.snapshot().jobs.length, 2)
})
test('a slow X operation never blocks a newly scheduled manual channel; same account remains ordered', async () => {
  const s = new Store(':memory:'),
    a = s.addAccount(account, 'test', '7')
  const x1 = job(s, a),
    x2 = job(s, a, '第二帖')
  const web = s.addAccount({
    platform: 'xiaobot',
    mode: 'web',
    name: '手记',
    identity: 'fieldnotes'
  })
  let finish
  const blocked = new Promise((resolve) => {
    finish = resolve
  })
  const work = runDue(s, () => ({ me: () => blocked, post: async () => ({ id: '85' }) }))
  const manual = job(s, web)
  await runDue(s, () => assert.fail('same account running'))
  assert.equal(s.job(x1).status, 'sending')
  assert.equal(s.job(x2).status, 'queued')
  assert.equal(s.job(manual).status, 'waiting')
  finish({ id: '7', username: 'writer' })
  await work
  await runDue(s, () => ({
    me: async () => ({ id: '7', username: 'writer' }),
    post: async () => ({ id: '86' })
  }))
  assert.equal(s.job(x2).status, 'published')
})
test('late completion of a timed-out image upload cannot issue a post', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = new Store(':memory:'),
    a = s.addAccount(account, 'test', '7')
  const image = 'd'.repeat(64)
  s.db
    .prepare('INSERT INTO assets VALUES(?,?,?,?,?,?)')
    .run(image, 'test.png', 'image/png', 2, 'thumb', Buffer.from('ok'))
  const d = s.save({ ...draft(a), assets: [image] })
  const [id] = s.queue(d.id, d.revision, null)
  let uploaded,
    posts = 0
  const late = new Promise((resolve) => {
    uploaded = resolve
  })
  const work = runDue(s, () => ({
    me: async () => ({ id: '7', username: 'writer' }),
    upload: () => late,
    post: async () => {
      posts++
      return { id: '7' }
    }
  }))
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(120001)
  await work
  assert.equal(s.job(id).status, 'failed')
  uploaded('mock-media-id')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(posts, 0)
})
test('interrupted account removal remains visible and rejects sending until cleanup completes', () => {
  const s = new Store(':memory:'),
    a = s.addAccount(account, 'test', '7')
  s.archive(a.id)
  assert.equal(s.account(a.id).archived, 2)
  assert.throws(() => s.addAccount(account, 'new', '7'))
  assert.throws(() => job(s, a))
  s.archive(a.id)
  s.finishArchive(a.id)
  assert.equal(s.account(a.id).archived, 1)
})
test('creator share links keep only the column path, reject misleading origins', () => {
  const raw = {
    platform: 'xiaobot',
    mode: 'web',
    name: '手记',
    identity: 'https://xiaobot.net/p/field-notes/?refer=abc#subscribe'
  }
  assert.equal(accountInput(raw).identity, 'field-notes')
  assert.throws(() =>
    accountInput({ ...raw, identity: 'https://xiaobot.net.example/p/field-notes' })
  )
})
