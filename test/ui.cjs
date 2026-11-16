const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const screenshots = path.join(root, 'docs', '验收')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const launch = (data) =>
  electron.launch({ args: [root], env: { ...env, JASTUDIO_TEST_DATA: data }, timeout: 30000 })
const fixture =
  '<!doctype html><meta charset="utf-8"><textarea placeholder="标题（可选）"></textarea><div class="ProseMirror" contenteditable="true"><p><br></p></div>'
const xFixture =
  '<!doctype html><meta charset="utf-8"><div data-testid="SideNav_AccountSwitcher_Button"><span>@writer</span></div><div data-testid="tweetTextarea_0" contenteditable="true" id="background"></div><section role="dialog"><div data-testid="tweetTextarea_0" contenteditable="true" id="foreground"></div></section>'
async function createAccount(page, platform, name, identity) {
  await page.locator('header [data-action=add]').click()
  await page.selectOption('#platform', platform)
  await page.fill('#a-name', name)
  await page.fill('#identity', identity)
  await page.locator('#account-form button[type=submit]').click()
  await page.waitForSelector('dialog:not([open])', { state: 'attached' })
}
async function fit(page, width) {
  const actual = await page.evaluate(() => ({
    w: innerWidth,
    doc: document.documentElement.scrollWidth
  }))
  assert.ok(actual.doc <= actual.w, 'overflow at ' + width + ': ' + JSON.stringify(actual))
}
async function stub(app, account, html) {
  await app.evaluate(
    async ({ session, dialog, BrowserWindow }, { account, html }) => {
      if (!globalThis.__testMenus) {
        globalThis.__testMenus = new Map()
        const original = BrowserWindow.prototype.setMenu
        BrowserWindow.prototype.setMenu = function (menu) {
          globalThis.__testMenus.set(this.id, menu)
          return original.call(this, menu)
        }
      }
      const profile = session.fromPartition('persist:ja-' + account)
      await profile.protocol.handle(
        'https',
        () => new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } })
      )
      dialog.showMessageBox = async (_win, config) => {
        globalThis.__jaMessage = config.message
        return { response: 0 }
      }
    },
    { account, html }
  )
}
async function clickFill(app, win) {
  const wid = await win.evaluate(() => location.href)
  await app.evaluate(({ BrowserWindow }, url) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)
    const menu = globalThis.__testMenus.get(w.id).items.find((item) => item.label === '填入编辑器')
    globalThis.__jaMessage = null
    menu.click()
  }, wid)
  const limit = Date.now() + 5000
  while (Date.now() < limit) {
    const msg = await app.evaluate(() => globalThis.__jaMessage)
    if (msg) return msg
    await new Promise((r) => setTimeout(r, 35))
  }
  throw Error('填入结果未返回')
}
async function openJob(app, page, platform) {
  const state = await page.evaluate(() => window.studio.snapshot())
  const j = state.jobs.find(
    (j) => state.accounts.find((a) => a.id === j.accountId).platform === platform
  )
  const window = app.waitForEvent('window')
  await page.locator('[data-action=open][data-id="' + j.id + '"]').click()
  return { j, w: await window }
}
async function run() {
  await fs.mkdir(screenshots, { recursive: true })
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ja-ui-'))
  let app
  try {
    app = await launch(temp)
    let page = await app.firstWindow()
    page.setDefaultTimeout(8000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForSelector('#overview .metrics')
    assert.equal(
      await app.evaluate(async ({ safeStorage }) => {
        if (!(await safeStorage.isAsyncEncryptionAvailable())) return false
        const sealed = await safeStorage.encryptStringAsync('本机验收样本')
        return (await safeStorage.decryptStringAsync(sealed)).result === '本机验收样本'
      }),
      true
    )
    await page.screenshot({ path: path.join(screenshots, '首次打开.png') })
    await page.locator('nav [data-nav=accounts]').click()
    await createAccount(page, 'xiaobot', '研究手记', 'https://xiaobot.net/p/notebook?refer=test')
    await createAccount(page, 'x', '研究手记', '@writer')
    await createAccount(page, 'weibo', '编辑部', '10001')
    console.log('PASS three account forms and identity validation')
    await page.locator('nav [data-nav=write]').click()
    await page.fill('#title', '一篇稿件，两个发布版本')
    await page.fill(
      '#body',
      '记录一次真实操作：先在自己的稿件里做修改，再把同一份内容交给不同账号。\n\n长文保留完整步骤，X 使用单独的短文。'
    )
    await page.locator('#targets input').nth(0).check()
    await page.locator('#targets input').nth(1).check()
    await page.fill('#x-text', '换一份素材，把同一个步骤再做一次。')
    await page.waitForFunction(() => document.querySelector('#saved').textContent === '已保存')
    await page.waitForFunction(() => !document.querySelector('#toast').textContent)
    await page.screenshot({ path: path.join(screenshots, '写稿.png') })
    await fit(page, 1280)
    const pasteRejected = await page.locator('#body').evaluate((field) => {
      const original = field.value,
        transfer = new DataTransfer()
      transfer.setData('text/plain', '稿'.repeat(150001))
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer
      })
      field.dispatchEvent(event)
      return event.defaultPrevented && field.value === original
    })
    assert.equal(pasteRejected, true)
    await page.waitForFunction(() => !document.querySelector('#toast').textContent)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(390, 760))
    await fit(page, 390)
    await page.locator('.mobile-drafts').click()
    await page.locator('dialog [data-action=close]').click()
    await page.screenshot({ path: path.join(screenshots, '窄窗.png') })
    await page.locator('#enqueue').scrollIntoViewIfNeeded()
    assert.ok(
      await page
        .locator('#enqueue')
        .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)
    )
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 850))
    await page.locator('#later').click()
    await page.fill('#due', '2020-01-01T00:00')
    await page.locator('#enqueue').click()
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('未来'))
    await page.locator('#now').click()
    await page.locator('#enqueue').click()
    await page.waitForFunction(
      () => document.querySelectorAll('#jobs [data-action=open]').length === 2
    )
    let state = await page.evaluate(() => window.studio.snapshot())
    assert.equal(state.jobs.length, 2)
    assert.equal(state.drafts.length, 1)
    for (const a of state.accounts.filter((a) => a.platform !== 'weibo'))
      await stub(app, a.id, a.platform === 'x' ? xFixture : fixture)
    const bot = await openJob(app, page, 'xiaobot')
    await bot.w.waitForSelector('.ProseMirror')
    assert.equal(await bot.w.evaluate(() => typeof window.studio), 'undefined')
    const msg = await clickFill(app, bot.w)
    assert.match(msg, /已填入/)
    assert.equal(await bot.w.locator('textarea').inputValue(), bot.j.title)
    await bot.w.locator('.ProseMirror').fill('平台上后来修改过的稿件')
    assert.match(await clickFill(app, bot.w), /已有内容/)
    assert.equal(await bot.w.locator('.ProseMirror').innerText(), '平台上后来修改过的稿件')
    await bot.w.goto('https://xiaobot.net/creator/wrong/edit')
    assert.match(await clickFill(app, bot.w), /目标专栏/)
    assert.equal(await bot.w.locator('textarea').inputValue(), '')
    const xb = await openJob(app, page, 'x')
    await xb.w.waitForSelector('#foreground')
    assert.match(await clickFill(app, xb.w), /已填入/)
    assert.equal(await xb.w.locator('#foreground').innerText(), xb.j.body)
    assert.equal(await xb.w.locator('#background').innerText(), '')
    await xb.w
      .locator('[data-testid="SideNav_AccountSwitcher_Button"] span')
      .evaluate((el) => (el.textContent = '@other'))
    assert.match(await clickFill(app, xb.w), /身份/)
    const sessions = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().startsWith('https'))
        .map((w) => w.webContents.session.storagePath)
    )
    assert.equal(new Set(sessions).size, 2)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().startsWith('https'))
        .forEach((w) => w.destroy())
    )
    console.log(
      'PASS official URL fixtures, menu click, foreground editor, column and handle mismatch, occupied draft, isolated sessions'
    )
    await page.locator('#jobs [data-action=detail][data-id="' + bot.j.id + '"]').click()
    await page.fill('#receipt', 'https://evil.example/post/abc')
    await page.locator('#record-form button').click()
    await page.waitForFunction(() => document.querySelector('#modal-error').textContent.length > 0)
    await page.fill('#receipt', 'https://xiaobot.net/post/123456')
    await page.locator('#record-form button').click()
    await page.waitForSelector('dialog:not([open])', { state: 'attached' })
    await page.locator('[data-action=filter][data-id=done]').click()
    await page.waitForSelector('#jobs [data-action=visit]')
    await page.locator('nav [data-nav=write]').click()
    await page.locator('#enqueue').click()
    state = await page.evaluate(() => window.studio.snapshot())
    assert.equal(state.jobs.length, 2)
    console.log('PASS schedule past time, manual receipt, duplicate submit, narrow layout')
    const article = path.join(temp, 'samples')
    await fs.mkdir(article)
    await fs.writeFile(path.join(article, '发布文案.txt'), '禾高子导入\n\n图文正文\n')
    await page.screenshot({
      path: path.join(article, 'page-001.png'),
      clip: { x: 0, y: 0, width: 24, height: 24 }
    })
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      },
      path.join(article, '发布文案.txt')
    )
    await page.locator('nav [data-nav=write]').click()
    await page.locator('[data-action=import]').click()
    await page.waitForFunction(() => document.querySelector('#title').value === '禾高子导入')
    assert.equal(await page.locator('#images .thumb').count(), 1)
    await page.fill('#body', '退出前输入的改动')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    if (app.process().exitCode === null) await new Promise((r) => app.process().once('exit', r))
    app = await launch(temp)
    page = await app.firstWindow()
    await page.waitForFunction(() => document.querySelector('#body')?.value === '退出前输入的改动')
    assert.equal(await page.locator('#images .thumb').count(), 1)
    assert.deepEqual(errors, [])
    const disposable = await page.evaluate(async () =>
      (await studio.snapshot()).accounts.find((a) => a.platform === 'weibo')
    )
    const cookieAction = async (action) =>
      app.evaluate(
        async ({ session }, { id, action }) => {
          const profile = session.fromPartition('persist:ja-' + id)
          if (action === 'set')
            await profile.cookies.set({ url: 'https://weibo.com', name: 'fixture', value: 'demo' })
          return (await profile.cookies.get({ name: 'fixture' })).length
        },
        { id: disposable.id, action }
      )
    assert.equal(await cookieAction('set'), 1)
    await page.locator('nav [data-nav=accounts]').click()
    await page.locator('[data-action=account-open][data-id="' + disposable.id + '"]').first().click()
    await page.locator('.pick-tools').click()
    await page.locator('dialog [data-action=account-meta]').click()
    await page.locator('[data-action=archive][data-id="' + disposable.id + '"]').click()
    await page.locator('#confirm').click()
    await page.waitForFunction(
      async (id) => (await studio.snapshot()).accounts.find((a) => a.id === id).archived === 1,
      disposable.id
    )
    assert.equal(await cookieAction('check'), 0)
    await app.evaluate((_electron, root) => {
      const req = process.getBuiltinModule('node:module').createRequire(root + '/package.json')
      const nock = req('nock').default
      nock.disableNetConnect()
      globalThis.__jaXMock = nock('https://api.x.com')
        .matchHeader('authorization', /^OAuth /)
        .get('/2/users/me')
        .query(true)
        .times(2)
        .reply(200, { data: { id: '101', username: 'sandbox_writer' } })
        .post('/2/tweets', { text: '接口替身验收' })
        .reply(201, { data: { id: '8500' } })
    }, root)
    await page.locator('header [data-action=add]').click()
    await page.fill('#a-name', 'X API 测试账号')
    await page.selectOption('#platform', 'x')
    await page.fill('#identity', 'sandbox_writer')
    await page.selectOption('#mode', 'api')
    for (const field of ['appKey', 'appSecret', 'accessToken', 'accessSecret'])
      await page.fill('#' + field, 'fixture-' + field)
    await page.locator('#account-form button[type=submit]').click()
    await page.waitForSelector('dialog:not([open])', { state: 'attached' })
    await page.locator('nav [data-nav=write]').click()
    await page.locator('header [data-action=new]').click()
    await page.fill('#body', '接口替身验收')
    await page.getByRole('checkbox', { name: /sandbox_writer API/ }).check()
    await page.locator('#enqueue').click()
    await page.waitForFunction(async () =>
      (await studio.snapshot()).jobs.some(
        (j) => j.status === 'published' && j.url === 'https://x.com/sandbox_writer/status/8500'
      )
    )
    assert.equal(await app.evaluate(() => globalThis.__jaXMock.isDone()), true)
    console.log(
      'PASS API account binding → encrypted credential → signed post → verified mock receipt (network disabled)'
    )
    console.log('PASS Windows credential encryption and persistent session removal')
    console.log(
      'PASS 禾高子 text + page image import, window close flush, restart persistence; no renderer errors'
    )
  } finally {
    if (app && app.process().exitCode === null) await app.close()
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  }
}
run().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
