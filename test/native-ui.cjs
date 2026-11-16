const { _electron } = require('playwright')
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path')
const root = path.resolve(__dirname, '..')
const installed = process.env.JASTUDIO_INSTALLED_EXE
async function until(fn) {
  const deadline = Date.now() + 18000
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('原生流程等待超时：' + fn.toString())
}
async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ja-native-'))
  const env = { ...process.env, JASTUDIO_TEST_DATA: dir }
  delete env.ELECTRON_RUN_AS_NODE
  if (installed) env.PATH = path.join(process.env.SystemRoot, 'system32')
  const launch = () =>
    _electron.launch(
      installed ? { executablePath: installed, args: [], cwd: dir, env } : { args: [root], env }
    )
  let app
  try {
    app = await launch()
    let page = await app.firstWindow()
    page.setDefaultTimeout(12000)
    if (installed) {
      const appPath = await app.evaluate(({ app }) => app.getAppPath())
      assert.ok(appPath.startsWith(path.dirname(installed)), appPath)
      assert.ok(!appPath.startsWith(root), appPath)
    }
    await app.evaluate(
      ({ app, BrowserWindow, dialog }, file) => {
        const created = '7999999999999999991',
          uid = '7888888888888888882'
        globalThis.__menu = new Map()
        globalThis.__notice = ''
        globalThis.__postCount = 0
        globalThis.__foreign = false
        app.on('session-created', (s) => {
          if (!s.storagePath?.includes('ja-')) return
          const send = (data) =>
            new Response(typeof data === 'string' ? data : JSON.stringify(data), {
              headers: { 'content-type': 'application/json' }
            })
          s.protocol.handle('https', async (req) => {
            const path = new URL(req.url).pathname
            if (path === '/fixture-login') {
              await s.cookies.set({
                url: 'https://creator.douyin.com',
                name: 'fixture',
                value: 'logged',
                expirationDate: Math.ceil(Date.now() / 1000) + 3600
              })
              return send({ ok: true })
            }
            const signed = (await s.cookies.get({ name: 'fixture' })).length > 0
            if (path.includes('/user/info/'))
              return send(
                signed
                  ? {
                      status_code: 0,
                      uid: globalThis.__foreign ? '999' : uid,
                      user_profile: { nick_name: '试用创作者', unique_id: 'test_owner' }
                    }
                  : { status_code: 8 }
              )
            if (path.endsWith('work_list'))
              return send({
                status_code: 0,
                aweme_list: globalThis.__postCount
                  ? [
                      {
                        aweme_id: created,
                        author: { uid },
                        desc: '投稿草稿',
                        create_time: 1790000000
                      }
                    ]
                  : [],
                items: globalThis.__postCount ? [{ id: created, metrics: { view_count: 0 } }] : [],
                has_more: 0
              })
            if (path.endsWith('/item/mget'))
              return send({
                status_code: 0,
                items: [
                  {
                    id: created,
                    user_id: uid,
                    description: '投稿草稿',
                    metrics: { view_count: 25, like_count: 3, collect_count: 1 },
                    review: { status: 2 }
                  }
                ]
              })
            if (path === '/web/api/media/aweme/create_v2/' && req.method === 'POST') {
              globalThis.__postCount++
              return send('{"status_code":0,"item_id":7999999999999999991}')
            }
            if (path.endsWith('/content/upload') && new URL(req.url).searchParams.get('default-tab') === '3')
              return new Response('<input type="file" accept="image/png" multiple onchange="sessionStorage.album=JSON.stringify(Array.from(this.files,f=>f.name));location.href=\'/creator-micro/content/post/image?type=new\'">',{headers:{'content-type':'text/html;charset=utf-8'}})
            if (path.endsWith('/content/post/image'))
              return new Response('<section class="content-upload-test"></section><input placeholder="添加作品标题"><div class="zone-container" contenteditable="true">&#8203;</div><script>for(const name of JSON.parse(sessionStorage.album)){let card=document.createElement("div");card.className="mycard-test";card.innerHTML="<img width=24 height=24>";document.querySelector("section").append(card)}</script>',{headers:{'content-type':'text/html;charset=utf-8'}})
            let html = path.includes('/content/upload')
              ? '<input id="file" type="file" accept="video/mp4"><input placeholder="标题"><label>横版封面<input type="file" accept="image/jpeg" id="wide"></label><label>竖版封面<input type="file" accept="image/jpeg" id="portrait"></label><input type="file" accept="image/png" id="unrelated"><div contenteditable="true" id="desc"></div><button id="publish" onclick="if(document.querySelector(\'#file\').files.length)fetch(\'/web/api/media/aweme/create_v2/\',{method:\'POST\',body:\'fixture\'})">发布</button>'
              : '<button id="scan" onclick="fetch(\'/fixture-login\')">模拟扫码</button>'
            return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } })
          })
        })
        const original = BrowserWindow.prototype.setMenu
        BrowserWindow.prototype.setMenu = function (menu) {
          globalThis.__menu.set(this.id, menu)
          return original.call(this, menu)
        }
        dialog.showMessageBox = async (_w, opts) => {
          globalThis.__notice = opts.message
          return { response: opts.type === 'question' ? 1 : 0 }
        }
        dialog.showOpenDialog = async (_win, options) => ({ canceled: false,
          filePaths: options.filters[0].extensions.includes('mp4') ? [file.clip] : file.images })
      },
      {clip:path.join(root, 'test', 'fixtures', 'clip.mp4'),images:['douyin','xhs'].map(k=>path.join(root,'ui/brands',k+'.png'))}
    )
    await page.locator('nav [data-nav=accounts]').click()
    const loginWindow = app.waitForEvent('window')
    await page.locator('header [data-action=new-douyin]').click()
    const login = await loginWindow
    await login.locator('#scan').click()
    await until(() => page.evaluate(async () => (await studio.snapshot()).sessions.length === 1))
    assert.equal((await page.evaluate(() => studio.snapshot())).accounts[0].name, '试用创作者')
    await login.close()
    await page.locator('nav [data-nav=write]').click()
    await page.locator('[data-action=format][data-id=video]').click()
    await page.locator('#video-drop').click()
    await page.fill('#title', '投稿草稿')
    await page.fill('#body', '投稿简介')
    await page.locator('#targets input').check()
    await page.fill('#video-tags', '#动效, AE 动效')
    await page.waitForFunction(() => document.getElementById('clip-player').readyState >= 2)
    await page.locator('[data-desk=make-covers]').click()
    await page.waitForFunction(() => document.querySelectorAll('#cover-formats img').length === 2)
    const dims = await page.locator('#cover-formats img').evaluateAll(images => images.map(i => [i.naturalWidth, i.naturalHeight]))
    assert.deepEqual(dims, [[1600,900],[1080,1440]])
    if (process.env.JASTUDIO_PROOF_DIR) await page.screenshot({path:path.join(process.env.JASTUDIO_PROOF_DIR,'发视频.png')})
    const windowEvent = app.waitForEvent('window')
    await page.locator('#sync-video').click()
    const upload = await windowEvent
    await until(() => page.evaluate(async () => Object.values((await studio.snapshot()).videoProgress).some(p => p.phase === 'ready')))
    assert.equal(await upload.locator('#desc').innerText(), '投稿简介\n#动效 #AE')
    assert.deepEqual(await upload.locator('#file,#wide,#portrait,#unrelated').evaluateAll(inputs => inputs.map(i => i.files.length)), [1,1,1,0])
    assert.equal(await app.evaluate(() => globalThis.__postCount), 0)
    if (process.env.JASTUDIO_PROOF_DIR) await page.screenshot({path:path.join(process.env.JASTUDIO_PROOF_DIR,'同步中心.png')})
    await page.locator('#jobs [data-action=open-only]').click()
    await upload.locator('#publish').click()
    await until(() => page.evaluate(async () => (await studio.snapshot()).candidates.length === 1))
    const state = await page.evaluate(() => studio.snapshot()),
      job = state.jobs[0]
    assert.equal(job.status, 'uncertain')
    await upload.close()
    await page.locator('[data-action=filter][data-id=attention]').click()
    await page.locator('#jobs [data-action=detail]').click()
    await page.locator('[data-action=candidate]').click()
    await page.locator('#confirm').click()
    await until(() =>
      page.evaluate(async () => (await studio.snapshot()).jobs[0].status === 'published')
    )
    await page.locator('nav [data-nav=data]').click()
    await page.locator('[data-action=data-tab][data-id=native]').click()
    await page.locator('#analytics [data-action=native-detail]').click()
    await page.waitForFunction(() => document.querySelector('dialog').innerText.includes('25'))
    if (process.env.JASTUDIO_CAPTURE)
      await page.screenshot({ path: path.join(root, 'docs', '验收', '作品回读.png') })
    await page.locator('dialog [data-action=draft]').click()
    assert.equal(await page.inputValue('#title'), '投稿草稿')
    const info = await page.evaluate(() => studio.insights())
    assert.equal(info.native[0].itemId, '7999999999999999991')
    assert.equal(info.native[0].draftId, job.draftId)
    await page.locator('nav [data-nav=write]').click()
    await page.locator('[data-action=images]').click()
    await page.fill('#title','图文标题')
    await page.fill('#body','图文正文')
    await page.locator('#targets input').check()
    await page.locator('#enqueue').click()
    const graphicJob = await page.evaluate(async ()=>(await studio.snapshot()).jobs.find(j=>j.title==='图文标题'))
    const graphicWindow = app.waitForEvent('window')
    await page.locator('#jobs [data-action=open][data-id="'+graphicJob.id+'"]').click()
    const graphic = await graphicWindow
    await graphic.waitForFunction(()=>document.querySelector('.zone-container')?.innerText.replace(/\u200b/g,'')==='图文正文')
    assert.equal(await graphic.locator('input[placeholder]').inputValue(),'图文标题')
    assert.equal(await graphic.locator('.mycard-test').count(),2)
    await page.evaluate(id=>studio['open-job'](id),graphicJob.id)
    assert.equal(await graphic.locator('.mycard-test').count(),2)
    await graphic.close()
    await app.evaluate(() => {
      globalThis.__foreign = true
    })
    await assert.rejects(
      page.evaluate((id) => studio['sync-works'](id, '0'), job.accountId),
      /身份|UID|账号/
    )
    assert.equal(await app.evaluate(() => globalThis.__postCount), 1)
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.waitForSelector('#overview .metrics')
    const restored = await page.evaluate(() => studio.insights())
    assert.equal(restored.native[0].views, 25)
    assert.ok(
      await app.evaluate(
        async ({ session }, id) =>
          (await session.fromPartition('persist:ja-' + id).cookies.get({ name: 'fixture' }))
            .length === 1,
        job.accountId
      )
    )
    console.log(
      'PASS independent ' +
        (installed ? 'installed' : 'development') +
        ' Electron → Douyin sign-in → verified video selection and text → native publish receipt → owned metrics → draft → restart (no platform post)'
    )
  } finally {
    if (app && app.process().exitCode === null) {
      await app
        .evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .filter((w) => w.webContents.getURL().startsWith('https:'))
            .forEach((w) => w.destroy())
        )
        .catch(() => {})
      await app.close().catch(() => {})
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
run().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
