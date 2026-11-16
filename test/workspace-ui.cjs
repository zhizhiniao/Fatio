const { _electron } = require('playwright')
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
async function run() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ja-workspace-')),
    env = { ...process.env, JASTUDIO_TEST_DATA: temp }
  delete env.ELECTRON_RUN_AS_NODE
  const screenshot = (name) => path.join(root, 'docs', '验收', name + '.png')
  let app
  try {
    const first = path.join(temp, '镜头一.mp4'),
      second = path.join(temp, '镜头二.mp4'),
      clip = await fs.readFile(path.join(__dirname, 'fixtures', 'clip.mp4'))
    await fs.writeFile(first, clip)
    await fs.writeFile(second, Buffer.concat([clip, Buffer.from([0, 0, 0, 8, 102, 114, 101, 101])]))
    const project = path.join(temp, 'outputs', '联调项目')
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(
      path.join(project, '.easel.json'),
      JSON.stringify({ title: '从 Easel 导入', deliverables: ['稿.md'] })
    )
    await fs.writeFile(path.join(project, '稿.md'), '这是项目正文。')
    app = await _electron.launch({ args: [root], env })
    const page = await app.firstWindow()
    page.setDefaultTimeout(9000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForSelector('#overview .metrics')
    await page.locator('nav [data-nav=accounts]').click()
    assert.equal(await page.locator('.platform-grid button').count(), 12)
    await page.screenshot({ path: screenshot('平台目录') })
    for (const p of ['douyin', 'kuaishou', 'tiktok', 'bilibili']) {
      await page.locator('header [data-action=add]').click()
      await page.selectOption('#platform', p)
      await page.fill('#a-name', '账号 ' + p)
      await page.fill('#identity', p === 'bilibili' ? '12345' : 'studio_test')
      await page.locator('#account-form button[type=submit]').click()
      await page.waitForSelector('dialog:not([open])', { state: 'attached' })
    }
    await page.locator('.edit-name').first().click()
    await page.fill('#edit-group', '短视频')
    await page.locator('#meta-form button').click()
    await page.locator('.filter-toggle').click()
    await page.selectOption('#account-group', '短视频')
    assert.equal(await page.locator('#account-list .row').count(), 1)
    await page.selectOption('#account-group', '')
    await page.locator('nav [data-nav=write]').click()
    await page.locator('[data-action=format][data-id=video]').click()
    await app.evaluate(
      ({ dialog }, files) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files })
      },
      [first, second]
    )
    await page.locator('#video-drop').click()
    await page.waitForFunction(
      () => document.querySelectorAll('#video-list .source-line').length === 2
    )
    await page.fill('#body', '测试简介')
    for (const loc of await page.locator('#targets input').all()) await loc.check()
    await page.locator('#variants summary').click()
    await page.selectOption('#variant-platform', 'bilibili')
    await page.fill('#variant-title', 'B站专用标题')
    await page.waitForFunction(() => document.querySelector('#saved').textContent === '已保存')
    await page.waitForFunction(() => !document.querySelector('#toast').textContent)
    await page.screenshot({ path: screenshot('批量视频') })
    await page.locator('#enqueue').click()
    await page.waitForFunction(
      () => document.querySelectorAll('#jobs [data-action=open]').length === 8
    )
    const snapshot = await page.evaluate(() => studio.snapshot())
    assert.equal(snapshot.jobs.filter((j) => j.title === 'B站专用标题').length, 2)
    const j = snapshot.jobs.find(
      (j) => snapshot.accounts.find((a) => a.id === j.accountId).platform === 'douyin'
    )
    await app.evaluate(async ({ session, BrowserWindow, dialog }, id) => {
      const orig = BrowserWindow.prototype.setMenu
      BrowserWindow.prototype.setMenu = function (menu) {
        this.__fixtureMenu = menu
        return orig.call(this, menu)
      }
      globalThis.__uploadAllowed = false
      globalThis.__uploadNotice = ''
      dialog.showMessageBox = async (_win, opts) => {
        if (opts.type === 'question') {
          globalThis.__uploadAsked = true
          return { response: globalThis.__uploadAllowed ? 1 : 0 }
        }
        globalThis.__uploadNotice = opts.message
        return { response: 0 }
      }
      await session.fromPartition('persist:ja-' + id).protocol.handle('https', (req) =>
        req.url.includes('/user/info')
          ? new Response(
              JSON.stringify({ uid: '12345', user_profile: { unique_id: 'studio_test' } }),
              { headers: { 'Content-Type': 'application/json' } }
            )
          : new Response('<input type=file accept="video/mp4" id=upload>', {
              headers: { 'content-type': 'text/html;charset=utf-8' }
            })
      )
    }, j.accountId)
    await page.locator('#jobs [data-action=detail][data-id="' + j.id + '"]').click()
    const plainEditor = page.locator('dialog [data-action=open-only]')
    await plainEditor.waitFor()
    const wait = app.waitForEvent('window')
    await plainEditor.click()
    const remote = await wait
    await remote.waitForSelector('#upload')
    async function select(allowed) {
      return app.evaluate(async ({ BrowserWindow }, v) => {
        globalThis.__uploadAllowed = v
        globalThis.__uploadNotice = ''
        globalThis.__uploadAsked = false
        const w = BrowserWindow.getAllWindows().find((w) => w.__fixtureMenu)
        await w.__fixtureMenu.items.find(i => i.label === '投稿素材').submenu.items.find(i => i.label === '单独选入视频').click()
        const limit = Date.now() + 5000
        while (
          Date.now() < limit &&
          (!globalThis.__uploadAsked || (v && !globalThis.__uploadNotice))
        )
          await new Promise((r) => setTimeout(r, 25))
        if (!globalThis.__uploadAsked) throw Error('目标账号未确认')
        return globalThis.__uploadNotice
      }, allowed)
    }
    await select(false)
    assert.equal(await remote.locator('#upload').evaluate((n) => n.files.length), 0)
    assert.match(await select(true), /已向官方上传框/)
    assert.equal(
      await remote.locator('#upload').evaluate((n) => n.files[0].size),
      snapshot.videos.find((v) => v.id === j.videoId).size
    )
    await remote.close()
    console.log(
      'PASS four new platform accounts, group filtering, native batch 2 × 4, per-platform variant, declined and accepted file selection'
    )
    const csv = path.join(temp, '数据总览.csv')
    await fs.writeFile(
      csv,
      '账号,平台,总收益,昨日收益,昨日播放量,昨日评论,昨日点赞,昨日涨粉,更新时间\n测试账号,抖音,8.50,1.25,120,5,7,2,2026-11-07 10:00'
    )
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, csv)
    await page.locator('nav [data-nav=home]').click()
    await page.locator('#overview [data-action=report-import]').click()
    await page.waitForFunction(() => document.querySelector('#overview').innerText.includes('120'))
    await page.locator('nav [data-nav=data]').click()
    await page.locator('[data-action=data-tab][data-id=archive]').click()
    assert.match(await page.locator('#analytics').innerText(), /测试账号/)
    await app.evaluate(
      ({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
      },
      path.join(temp, 'outputs')
    )
    await page.locator('nav [data-nav=write]').click()
    await page.locator('[data-action=projects]').click()
    await page.locator('[data-action=easel-item]').click()
    assert.equal(await page.inputValue('#body'), '这是项目正文。')
    await page.fill('#body', '修改后的项目正文')
    await page.locator('[data-action=project-info]').click()
    await page.locator('[data-action=easel-export]').click()
    await page.waitForFunction(() =>
      document.querySelector('#toast').textContent.includes('已导出')
    )
    assert.equal(
      (await fs.readdir(path.join(temp, 'outputs'))).filter((n) => n.startsWith('Fatio-'))
        .length,
      1
    )
    assert.deepEqual(errors, [])
    console.log('PASS 易媒报表 → 首页/账号数据；Easel 清单 → 本地草稿 → 新版本项目')
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((w) => w.webContents.getURL().startsWith('https:'))
          .forEach((w) => w.destroy())
      )
      await app.close()
    }
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 })
  }
}
run().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
