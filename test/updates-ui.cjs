const { _electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { release, REPOSITORY } = require('../src/updates.cjs')
const root = path.resolve(__dirname, '..')
const parts = require('../package.json').version.split('.').map(Number)
const nextVersion = [parts[0], parts[1], parts[2] + 1].join('.')
const laterVersion = [parts[0], parts[1], parts[2] + 2].join('.')
function fixture(v) {
  const tag = 'v' + v + '-dev.1', name = 'Fatio-Setup-' + v + '-x64.exe'
  return { tag_name: tag, html_url: REPOSITORY + '/releases/tag/' + tag, name: '更新提示隔离演示',
    body: '隔离测试的模拟新版本。<script>不可执行</script>', prerelease: true,
    assets: [{ name, state: 'uploaded', size: 100, browser_download_url: REPOSITORY + '/releases/download/' + tag + '/' + name }] }
}
async function close(app) {
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy() }).catch(() => {})
  await app.close().catch(() => {})
}
async function run() {
  const output = path.join(root, '.runtime/updates-20261115')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'profile-'))
  await fs.writeFile(path.join(profile, 'updates.json'), JSON.stringify({ auto: true, latest: release(fixture(nextVersion)), lastChecked: Date.now(), lastAttempt: Date.now() }))
  const env = { ...process.env, FATIO_TEST_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.JASTUDIO_TEST_DATA
  const executablePath = process.env.FATIO_INSTALLED_EXE
  const launch = () => _electron.launch(executablePath ? { executablePath, args: [], env } : { args: [root], env })
  let app = await launch()
  const errors = []
  let saved
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForSelector('#update-check.has-update')
    assert.match(await page.locator('#update-check').innerText(), /发现新版/)
    await app.evaluate(({ net, shell }, rows) => {
      globalThis.__updateRows = rows
      globalThis.__openedUpdateLinks = []
      net.fetch = async () => Response.json(globalThis.__updateRows)
      shell.openExternal = async url => { globalThis.__openedUpdateLinks.push(url) }
    }, [fixture(nextVersion)])
    saved = await page.evaluate(async () => {
      const a = await studio['add-account']({ platform: 'xiaobot', mode: 'web', name: '更新保留演示', identity: 'update_fixture' })
      const d = await studio.save({ title: '更新验收草稿', body: '保留原稿', targets: [a.id], kind: 'article', xText: '' })
      return { account: a.id, draft: d.id }
    })
    await page.locator('#update-check').click()
    await page.waitForSelector('#updates-dialog[open]')
    assert.match(await page.locator('#updates-notes').innerText(), /<script>不可执行<\/script>/)
    assert.equal(await page.locator('#updates-notes script').count(), 0)
    await page.locator('#updates-download').click()
    assert.deepEqual(await app.evaluate(() => globalThis.__openedUpdateLinks), [release(fixture(nextVersion)).download])
    await page.locator('#updates-recheck').click()
    await page.waitForFunction(() => document.querySelector('#updates-status').textContent === '发现新版本')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(500, 720))
    await page.waitForFunction(() => innerWidth < 600)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#updates-dialog').scrollWidth <= document.querySelector('#updates-dialog').clientWidth), true)
    await page.screenshot({ path: path.join(output, 'available-narrow.png') })
    await page.locator('#updates-auto').uncheck()
    await page.waitForFunction(async () => (await studio['update-info']()).auto === false)
    await page.locator('#updates-skip').click()
    await page.waitForFunction(() => !document.querySelector('#update-check').classList.contains('has-update'))
  } finally { await close(app) }
  app = await launch()
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForFunction(() => document.querySelector('#update-current').textContent.length > 0)
    const state = await page.evaluate(async () => ({ updates: await studio['update-info'](), data: await studio.snapshot() }))
    assert.equal(state.updates.auto, false)
    assert.equal(state.updates.notify, false)
    assert.ok(state.data.accounts.some(a => a.id === saved.account))
    assert.ok(state.data.drafts.some(d => d.id === saved.draft && d.body === '保留原稿'))
    await app.evaluate(({ net }, rows) => { net.fetch = async () => Response.json(rows) }, [fixture(laterVersion)])
    await page.locator('#update-check').click()
    await page.locator('#updates-recheck').click()
    await page.waitForFunction(() => document.querySelector('#update-check').classList.contains('has-update'))
    assert.ok((await page.locator('#updates-versions').innerText()).includes(laterVersion))
    assert.deepEqual(errors, [])
  } finally { await close(app) }
  const report = { packaged: !!executablePath, checks: ['Cached startup notice', 'Manual check and trusted download link', 'Release notes rendered as text', 'Narrow window', 'Auto preference and skip survive restart', 'Later version notifies again', 'Account and draft survive restart'], pageErrors: errors }
  await fs.writeFile(path.join(output, 'ui-result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
run().catch(error => { console.error(error); process.exitCode = 1 })
