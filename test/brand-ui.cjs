const { _electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const root = path.resolve(__dirname, '..')
const { dataDirectory } = require('../src/brand.cjs')
const output = path.join(root, '.runtime/rebrand-validation')
const fixture = path.join(output, 'legacy-profile')
const metadataFile = path.join(output, 'legacy-fixture.json')
const installed = process.env.FATIO_INSTALLED_EXE

async function launch(executablePath, profile, legacy = false) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.JASTUDIO_TEST_DATA
  delete env.FATIO_TEST_DATA
  env[legacy ? 'JASTUDIO_TEST_DATA' : 'FATIO_TEST_DATA'] = profile
  return _electron.launch(executablePath ? { executablePath, args: [], cwd: profile, env } : { args: [root], env })
}

async function run() {
  await fs.mkdir(output, { recursive: true })
  if (!(await fs.stat(metadataFile).catch(() => null))) {
    const legacy = process.env.JASTUDIO_LEGACY_EXE
    assert.ok(legacy, 'Set JASTUDIO_LEGACY_EXE to seed this test with the actual previous release')
    await fs.mkdir(fixture, { recursive: true })
    const app = await launch(legacy, fixture, true)
    try {
      const page = await app.firstWindow()
      await page.waitForSelector('nav [data-nav=home]')
      const sample = await page.evaluate(async () => {
        const a = await studio['add-account']({ platform: 'xiaobot', mode: 'web', name: '品牌升级验收账号', identity: 'fatio_fixture' })
        const d = await studio.save({ title: '升级前草稿', body: '保留这段正文', xText: '', targets: [a.id], kind: 'article' })
        await studio.queue(d.id, d.revision, Date.now() + 86400000, false)
        return { account: a.id, draft: d.id }
      })
      const sealed = await app.evaluate(async ({ session, safeStorage, app }, id) => {
        const profile = session.fromPartition('persist:ja-' + id)
        await profile.cookies.set({ url: 'https://brand-fixture.invalid', name: 'fixture-login', value: 'preserve-login', expirationDate: Date.now() / 1000 + 86400 })
        await profile.cookies.flushStore()
        return { version: app.getVersion(), secret: (await safeStorage.encryptStringAsync('brand-fixture-secret')).toString('base64') }
      }, sample.account)
      await fs.writeFile(metadataFile, JSON.stringify({ ...sample, ...sealed }, null, 2))
    } finally { await closeTestApp(app) }
  }
  const sample = JSON.parse(await fs.readFile(metadataFile, 'utf8'))
  const prior = new DatabaseSync(path.join(fixture, 'studio.sqlite'), { readOnly: true })
  const expectedJobs = prior.prepare('SELECT id,status FROM jobs WHERE draftId=? ORDER BY id').all(sample.draft).map(row => ({ ...row }))
  prior.close()
  const profile = await fs.mkdtemp(path.join(output, installed ? 'installed-' : 'source-'))
  await fs.cp(fixture, profile, { recursive: true })
  const app = await launch(installed, profile)
  const report = { seedVersion: sample.version, packaged: !!installed, checks: [] }
  try {
    const page = await app.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForSelector('nav [data-nav=home]')
    const identity = await app.evaluate(({ app, BrowserWindow }) => ({
      name: app.getName(), version: app.getVersion(), userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'), title: BrowserWindow.getAllWindows()[0].getTitle()
    }))
    assert.equal(identity.name, '发条 Fatio')
    assert.equal(identity.title, '发条 Fatio')
    assert.equal(identity.userData, profile)
    assert.equal(identity.sessionData, profile)
    assert.equal(await page.title(), '发条 Fatio')
    assert.equal(await page.locator('.brand').getAttribute('aria-label'), '发条 Fatio')
    assert.equal(await page.locator('.brand img').evaluate(img => img.complete && img.naturalWidth > 0), true)
    const state = await page.evaluate(() => studio.snapshot())
    assert.equal(state.accounts.find(a => a.id === sample.account)?.name, '品牌升级验收账号')
    assert.equal(state.drafts.find(d => d.id === sample.draft)?.title, '升级前草稿')
    assert.deepEqual(state.jobs.filter(j => j.draftId === sample.draft).map(({ id, status }) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id)), expectedJobs)
    report.checks.push('Old account, draft and pending job survive upgrade')
    const retained = await app.evaluate(async ({ session, safeStorage }, sample) => ({
      cookies: await session.fromPartition('persist:ja-' + sample.account).cookies.get({ url: 'https://brand-fixture.invalid' }),
      secret: (await safeStorage.decryptStringAsync(Buffer.from(sample.secret, 'base64'))).result
    }), sample)
    assert.equal(retained.cookies.find(c => c.name === 'fixture-login')?.value, 'preserve-login')
    assert.equal(retained.secret, 'brand-fixture-secret')
    report.checks.push('Legacy partition cookie and encrypted credential survive rename')
    const storage = dataDirectory('C:\\Fixture\\Roaming', {})
    assert.equal(storage, 'C:\\Fixture\\Roaming\\JAStudio')
    assert.equal(dataDirectory('C:\\Fixture', { JASTUDIO_TEST_DATA: profile }), profile)
    report.checks.push('Default data identity and legacy test override remain compatible')
    const evidence = path.join(root, 'docs/brand/fatiao-v01/acceptance')
    await fs.mkdir(evidence, { recursive: true })
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      assert.equal(await page.locator('.mark').evaluate(img => getComputedStyle(img).backgroundColor), 'rgba(0, 0, 0, 0)')
      await page.screenshot({ path: path.join(evidence, (installed ? 'installed-' : 'source-') + theme + '.png') })
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(500, 720))
    await page.waitForFunction(() => innerWidth < 600)
    assert.equal(await page.locator('.brand img').isVisible(), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    report.checks.push('Name and icon render in dark/light themes and narrow window')
    assert.deepEqual(errors, [])
    report.identity = identity
  } finally { await closeTestApp(app) }
  await fs.writeFile(path.join(output, (installed ? 'installed' : 'source') + '-result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
async function closeTestApp(app) {
  // All writes are awaited above; explicitly close the isolated fixture window.
  // Electron app.quit() alone can wait on the editor's normal save-before-close UI.
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.destroy()
  }).catch(() => {})
  await app.close().catch(() => {})
}
run().catch(error => { console.error(error); process.exitCode = 1 })
