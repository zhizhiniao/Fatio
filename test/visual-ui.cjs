const { _electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path')
async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ja-visual-'))
  const root = path.resolve(__dirname, '..'),
    exe = process.env.JASTUDIO_INSTALLED_EXE
  const env = { ...process.env, JASTUDIO_TEST_DATA: dir }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch(
    exe ? { executablePath: exe, args: [], cwd: dir, env } : { args: [root], env }
  )
  try {
    const p = await app.firstWindow()
    await p.waitForSelector('#overview .kpis')
    async function checkRail() {
      const box = await p.locator('.sidebar').boundingBox()
      const first = await p.locator('nav [data-nav=home]').boundingBox()
      const last = await p.locator('nav [data-nav=queue]').boundingBox()
      assert.ok(box.x === 0 && box.y === 0 && box.width <= 85)
      assert.equal(first.x, last.x)
      assert.ok(last.y > first.y + first.height)
    }
    await checkRail()
    const accounts = []
    for (const [platform, identity] of [
      ['douyin', 'owner'],
      ['bilibili', '12345']
    ]) {
      const a = await p.evaluate(
        ([platform, identity]) =>
          studio['add-account']({ name: '同名创作者', mode: 'web', platform, identity }),
        [platform, identity]
      )
      accounts.push(a)
      await app.evaluate(({ session }, a) => {
        const s = session.fromPartition('persist:ja-' + a.id)
        s.protocol.handle('https', (req) => {
          const pathname = new URL(req.url).pathname
          let data = null
          if (pathname.includes('/user/info/'))
            data = {
              status_code: 0,
              uid: globalThis.foreignAccount ? '321' : '123',
              user_profile: { unique_id: 'owner', nick_name: '已登录作者', follower_count: 42 }
            }
          if (pathname === '/x/web-interface/nav')
            data = { code: 0, data: { isLogin: true, mid: 12345, uname: '同名创作者' } }
          if (pathname.endsWith('/work_list'))
            data = {
              items: [
                {
                  id: '7000000000000000001',
                  user_id: '123',
                  description: '春季摄影笔记',
                  review: { status: 2 },
                  metrics: { play_count: 34, like_count: 3, comment_count: 0 }
                }
              ]
            }
          return data
            ? new Response(JSON.stringify(data), {
                headers: { 'Content-Type': 'application/json' }
              })
            : new Response('<h1>官方账号后台</h1>', {
                headers: { 'Content-Type': 'text/html;charset=utf-8' }
              })
        })
      }, a)
    }
    await p.evaluate((id) => studio['sync-works'](id, '0'), accounts[0].id)
    await p.locator('nav [data-nav=home]').click()
    await p.locator('[data-desk=home-platform][data-key=bilibili]').click()
    assert.equal(await p.locator('#overview .work-card').count(), 0)
    assert.match(await p.locator('.growth-kpis [data-key=views]').innerText(), /暂无累计读数/)
    await p.locator('[data-desk=home-platform][data-key=douyin]').click()
    assert.match(await p.locator('.growth-kpis [data-key=views]').innerText(), /累计 34/)
    assert.match(await p.locator('.growth-kpis [data-key=followers]').innerText(), /累计 42/)
    await p.selectOption('#home-days','30')
    await p.locator('#overview .rank').click()
    await p.waitForSelector('#chart-metric')
    await p.selectOption('#chart-metric', 'comments')
    await p.waitForFunction(() => document.querySelector('dialog .trend [aria-label*="最新 0"]'))
    await p.selectOption('#chart-metric', 'shares')
    await p.waitForSelector('dialog .trend .empty')
    await p.locator('dialog [data-action=close]').click()
    await p.locator('nav [data-nav=accounts]').click()
    const activeHost = () =>
      app.evaluate(({ BrowserWindow }) => {
        const m = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith('file:')
        )
        return m.contentView.children.map((v) => ({
          host: new URL(v.webContents.getURL() || 'about:blank').host,
          bounds: v.getBounds(),
          partition: v.webContents.session.storagePath
        }))
      })
    for (const a of accounts) {
      await p.locator('.account-pick[data-id="' + a.id + '"]').click()
      await p.waitForSelector('#official-pane')
      await p.waitForTimeout(200)
      const children = await activeHost()
      assert.equal(children.length, 1)
      assert.ok(children[0].partition.includes(a.id))
      assert.ok(children[0].host.endsWith(a.platform === 'douyin' ? 'douyin.com' : 'bilibili.com'))
      const pane = await p.evaluate(() => document.querySelector('#official-pane').getBoundingClientRect().toJSON())
      const viewport = await p.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      assert.equal(pane.y, 0, 'the official site starts at the top of the client area')
      assert.equal(pane.height, viewport.height)
      assert.ok(Math.abs(pane.x + pane.width - viewport.width) <= 1)
      assert.ok(Math.abs(children[0].bounds.x - pane.x) <= 1)
      assert.equal(children[0].bounds.y, 0)
      assert.equal(children[0].bounds.height, viewport.height)
      assert.ok(Math.abs(children[0].bounds.width - pane.width) <= 1)
      if (a.platform === 'douyin') {
        await p.waitForFunction(() =>
          document.querySelector('#tab-identity')?.textContent.startsWith('已核对')
        )
        await app.evaluate(async ({ BrowserWindow }) => {
          globalThis.foreignAccount = true
          const m = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith('file:')
          )
          await m.contentView.children[0].webContents.executeJavaScript(
            "history.pushState({},'','#other')"
          )
        })
        await p.waitForFunction(() =>
          document.querySelector('#tab-identity')?.textContent.includes('账号不符')
        )
        await app.evaluate(() => {
          globalThis.foreignAccount = false
        })
      }
    }
    assert.equal(await p.locator('.account-tabs').count(), 0)
    const split = p.locator('#account-split')
    const bounds = await split.boundingBox()
    await p.mouse.move(bounds.x - 2, bounds.y + bounds.height / 2)
    await p.mouse.down()
    await p.mouse.move(bounds.x + 58, bounds.y + bounds.height / 2, {steps:8})
    await p.mouse.up()
    assert.ok(Number(await split.getAttribute('aria-valuenow')) > 275)
    const adjusted = await p.locator('#official-pane').boundingBox()
    await p.waitForTimeout(100)
    assert.ok(Math.abs((await activeHost())[0].bounds.x - adjusted.x) <= 1)
    await split.focus()
    await p.keyboard.press('Home')
    assert.equal(await split.getAttribute('aria-valuenow'), '242')
    await p.locator('.pick-tools').click()
    await p.waitForTimeout(120)
    assert.deepEqual(await activeHost(), [])
    await p.locator('dialog [data-action=account-meta]').click()
    await p.locator('dialog [data-action=close]').click()
    await p.locator('.account-pick[data-id="' + accounts[0].id + '"]').click()
    await p.waitForTimeout(120)
    assert.ok((await activeHost())[0].partition.includes(accounts[0].id))
    await p.locator('.filter-toggle').click()
    await p.selectOption('#account-platform', 'douyin')
    await p.locator('nav [data-nav=data]').click()
    await p.waitForSelector('#analytics .data-content')
    await p.waitForTimeout(100)
    assert.deepEqual(await activeHost(), [])
    await p.locator('[data-action=data-tab][data-id=platforms]').click()
    await p.locator('.compare-link[data-action=platform-works][data-id=douyin]').click()
    assert.equal(await p.inputValue('#work-platform'), 'douyin')
    await p.fill('#work-term', '无匹配')
    assert.equal(await p.locator('#analytics .work-card').count(), 0)
    await p.locator('nav [data-nav=video]').click()
    assert.equal(await p.locator('#video-drop').isVisible(), true)
    await p.locator('nav [data-nav=accounts]').click()
    await p.selectOption('#account-platform', 'douyin')
    assert.equal(await p.locator('.account-pick').count(), 1)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().startsWith('file:'))
        .setSize(390, 844)
    )
    for (const nav of ['home', 'accounts', 'video', 'write', 'data', 'queue']) {
      await p.locator('nav [data-nav=' + nav + ']').click()
      await checkRail()
      assert.ok(
        await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'overflow ' + nav
      )
    }
    await p.locator('nav [data-nav=accounts]').click()
    if (await p.locator('#official-pane').isVisible()) {
      await p.locator('#account-session [data-action=profile-mode]').click()
    }
    await p.locator('.account-pick').first().click()
    await p.waitForSelector('#official-pane')
    const narrow = await p.locator('#official-pane').boundingBox()
    assert.ok(narrow.y < 90 && narrow.height > 600)
    await p.locator('[data-action=profile-mode]').click()
    assert.ok(await p.locator('.account-pick').first().isVisible())
    console.log(
      'PASS account tab isolation, modal occlusion, platform drilldown, trend metric/zero/missing and six narrow layouts'
    )
  } finally {
    await app.close()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
}
run().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
