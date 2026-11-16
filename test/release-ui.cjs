const { _electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

async function run() {
  const runtime = path.join(root, '.runtime/release-validation')
  await fs.mkdir(runtime, { recursive: true })
  const profile = await fs.mkdtemp(path.join(runtime, 'profile-'))
  const env = { ...process.env, FATIO_TEST_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.JASTUDIO_TEST_DATA
  const executablePath = process.env.FATIO_INSTALLED_EXE
  const app = await _electron.launch(executablePath ? { executablePath, args: [], env } : { args: [root], env })
  const errors = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', e => errors.push(e.message))
    await page.waitForSelector('nav [data-nav=home]')
    const identity = await app.evaluate(({ app, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1400, 960)
      return { name: app.getName(), version: app.getVersion(), userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }
    })
    assert.equal(identity.name, '发条 Fatio')
    assert.equal(identity.version, require('../package.json').version)
    assert.equal(identity.userData, profile)
    assert.equal(identity.sessionData, profile)
    const demo = await page.evaluate(async () => {
      const account = await studio['add-account']({ platform: 'xiaobot', mode: 'web', name: '创作手记（演示）', identity: 'fatio_demo' })
      const draft = await studio.save({ title: '一篇稿件，从准备到复盘', body: '这是发条的隔离演示草稿。\n\n写好内容，按平台准备不同版本，在官方后台核对后发表，再把作品与原稿关联。\n\n演示资料不包含真实账号与日常草稿。', targets: [account.id], kind: 'article', xText: '' })
      const due = new Date()
      due.setDate(due.getDate() + 1)
      due.setHours(20, 0, 0, 0)
      await studio.queue(draft.id, draft.revision, due.getTime(), false)
      return { account: account.id, draft: draft.id }
    })
    await page.reload()
    await page.waitForSelector('nav [data-nav=home]')
    const state = await page.evaluate(() => studio.snapshot())
    assert.ok(state.accounts.some(a => a.id === demo.account))
    assert.ok(state.drafts.some(d => d.id === demo.draft))
    assert.ok(state.jobs.some(j => j.draftId === demo.draft))
    const images = path.join(root, 'docs/images')
    await fs.mkdir(images, { recursive: true })
    await page.screenshot({ path: path.join(images, 'workspace.png') })
    await page.locator('nav [data-nav=write]').click()
    await page.locator(`[data-action=draft][data-id="${demo.draft}"]`).click()
    await page.waitForFunction(() => document.querySelector('#title')?.value === '一篇稿件，从准备到复盘')
    await page.screenshot({ path: path.join(images, 'editor.png') })
    await page.locator('nav [data-nav=queue]').click()
    await page.locator('#queue-view button').filter({ hasText: '日历' }).click()
    await page.screenshot({ path: path.join(images, 'calendar.png') })
    assert.deepEqual(errors, [])
    const report = { ...identity, packaged: !!executablePath, checks: ['Isolated account, draft and pending job', 'Brand, version and independent data paths', 'Workspace, editor and calendar render without page errors'] }
    await fs.writeFile(path.join(runtime, 'result.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy() }).catch(() => {})
    await app.close().catch(() => {})
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
