const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { UpdateService, compare, latestRelease, FEED, REPOSITORY, CHECK_INTERVAL } = require('../src/updates.cjs')

function row(v = '1.12.4', overrides = {}) {
  const tag = 'v' + v + '-dev.1'
  const name = 'Fatio-Setup-' + v + '-x64.exe'
  return { tag_name: tag, html_url: REPOSITORY + '/releases/tag/' + tag, name: '发条 ' + v,
    body: '新增功能', draft: false, prerelease: true, published_at: '2026-11-15T12:00:00Z',
    assets: [{ name, state: 'uploaded', size: 100, browser_download_url: REPOSITORY + '/releases/download/' + tag + '/' + name }], ...overrides }
}
function service(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fatio-updates-'))
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return new UpdateService({ directory, currentVersion: '1.12.3', fetcher: async () => Response.json([row()]), ...overrides })
}

test('updates compare numeric versions and select complete releases rather than draft or newest timestamp', () => {
  assert.equal(compare('1.9.0', 'v1.12.3-dev.1'), -1)
  assert.equal(compare('1.12.3', 'v1.12.3-dev.2'), 0)
  assert.throws(() => compare('invalid', '1.0.0'))
  const result = latestRelease([row('1.12.4'), row('1.12.5', { assets: [] }), row('2.0.0', { draft: true }), row('1.9.0', { published_at: '2027-01-01' })])
  assert.equal(result.version, '1.12.4')
})
test('updates reject another repository, unsafe schemes, missing and mismatched installers', () => {
  const external = row()
  external.assets[0].browser_download_url = 'https://evil.invalid/payload.exe'
  assert.equal(latestRelease([external, row('2.0.0', { html_url: 'javascript:alert(1)' }), row('1.12.5', { assets: [] })]), null)
  assert.throws(() => latestRelease({ releases: [] }), /格式/)
})
test('automatic checks notify, persist across restart, throttle and allow manual rechecks', async t => {
  let requests = 0
  let clock = 1000000000000
  const s = service(t, { now: () => clock, fetcher: async (url, options) => {
    requests++
    assert.equal(url, FEED)
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    assert.ok(!('Authorization' in options.headers))
    return Response.json([row()])
  } })
  const result = await s.check()
  assert.equal(result.available, true)
  assert.equal(result.notify, true)
  const restarted = new UpdateService({ directory: path.dirname(s.file), currentVersion: '1.12.3', now: () => clock })
  assert.equal(restarted.info().notify, true)
  assert.equal(restarted.shouldCheck(), false)
  await s.check()
  assert.equal(requests, 1)
  await s.check(true)
  assert.equal(requests, 2)
  clock += CHECK_INTERVAL
  assert.equal(s.shouldCheck(), true)
})
test('skip only hides this version and disabled automatic checking still permits manual checking', async t => {
  let published = row()
  const s = service(t, { fetcher: async () => Response.json([published]) })
  s.automatic(false)
  assert.equal((await s.check()).status, 'unchecked')
  assert.equal((await s.check(true)).available, true)
  assert.equal(s.skip().notify, false)
  published = row('1.12.5')
  assert.equal((await s.check(true)).notify, true)
  assert.throws(() => s.automatic('yes'), /偏好/)
  assert.throws(() => s.target('https://evil.invalid'), /可打开/)
  assert.equal(s.target('download'), published.assets[0].browser_download_url)
})
test('network errors preserve cached notices, throttle retries and do not claim that current version is newest', async t => {
  const s = service(t)
  await s.check(true)
  s.fetcher = async () => new Response('', { status: 429 })
  const error = await s.check(true)
  assert.equal(error.status, 'error')
  assert.match(error.message, /限流/)
  assert.equal(error.notify, true)
  assert.equal(s.shouldCheck(), false)
})
test('equal, older and missing releases do not offer a downgrade or a broken download', async t => {
  const s = service(t, { fetcher: async () => Response.json([row('1.12.3'), row('1.11.0')]) })
  assert.equal((await s.check(true)).status, 'current')
  assert.throws(() => s.target('download'), /可打开/)
  s.fetcher = async () => Response.json([])
  assert.equal((await s.check(true)).status, 'empty')
})
test('concurrent update checks share one request and oversized responses fail safely', async t => {
  let requests = 0
  const s = service(t, { fetcher: async () => { requests++; await new Promise(resolve => setTimeout(resolve, 10)); return Response.json([row()]) } })
  await Promise.all([s.check(true), s.check(true)])
  assert.equal(requests, 1)
  s.fetcher = async () => new Response(' '.repeat(1024 * 1024 + 1))
  assert.match((await s.check(true)).message, /响应过大/)
})
test('cached download addresses are revalidated after restart', t => {
  const s = service(t)
  fs.writeFileSync(s.file, JSON.stringify({ latest: { tag: 'v2.0.0', version: '2.0.0', url: 'javascript:alert(1)', download: 'file:///C:/payload.exe' }, lastChecked: 1 }))
  const restarted = new UpdateService({ directory: path.dirname(s.file), currentVersion: '1.12.3' })
  assert.equal(restarted.info().available, false)
  assert.throws(() => restarted.target('download'), /可打开/)
})
