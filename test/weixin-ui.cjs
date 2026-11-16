const { _electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
async function run(platform) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ja-weixin-')),
    env = { ...process.env, JASTUDIO_TEST_DATA: dir }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = env.JASTUDIO_INSTALLED_EXE
  if (exe) env.PATH = path.join(process.env.SystemRoot, 'system32')
  const app = await _electron.launch(
    exe ? { executablePath: exe, args: [], cwd: dir, env } : { args: [root], env }
  )
  try {
    const p = await app.firstWindow()
    p.setDefaultTimeout(9000)
    await p.waitForSelector('#overview .kpis')
    await app.evaluate(
      ({ app, BrowserWindow, dialog, shell }, [clip, images]) => {
        globalThis.fixtureWorks = []
        globalThis.externalLinks = []
        shell.openExternal = async url => { globalThis.externalLinks.push(url) }
        globalThis.changedOwner = false
        const set = BrowserWindow.prototype.setMenu
        BrowserWindow.prototype.setMenu = function (menu) {
          this.fixtureMenu = menu
          return set.call(this, menu)
        }
        dialog.showMessageBox = async (_w, o) => {
          globalThis.fixtureNotice = o.message
          return { response: o.type === 'question' ? 1 : 0 }
        }
        dialog.showOpenDialog = async (_win, options) => ({ canceled: false,
          filePaths: options.filters[0].extensions.includes('mp4') ? [clip] : images })
        app.on('session-created', (s) => {
          if (!s.storagePath?.includes('ja-weixin-')) return
          const html = (x) =>
            new Response(x, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } })
          const json = (x) =>
            new Response(JSON.stringify(x), { headers: { 'Content-Type': 'application/json' } })
          s.protocol.handle('https', async (req) => {
            const url = new URL(req.url)
            if (!['mp.weixin.qq.com', 'channels.weixin.qq.com'].includes(url.hostname))
              return new Response('', { status: 403 })
            const signed = (await s.cookies.get({ url: url.origin, name: 'fixture' })).length
            if (url.pathname === '/fixture-login') {
              await s.cookies.set({ url: url.origin, name: 'fixture', value: '1' })
              return json({ ok: true })
            }
            if (!signed)
              return html(
                '<button id="scan" onclick="fetch(\'/fixture-login\').then(()=>location.reload())">模拟扫码</button>'
              )
            if (url.hostname === 'mp.weixin.qq.com') {
              const profile =
                '<script>window.wx={commonData:{data:{uin:"' +
                (globalThis.changedOwner ? '999' : '101') +
                '",nick_name:"隔离测试",user_name:"wx_fixture"}}}</script>'
              if (url.pathname === '/')
                return Response.redirect(url.origin + '/cgi-bin/home?token=42', 302)
              if (url.pathname === '/cgi-bin/home')
                return html(
                  profile +
                    '<a id="developer" href="https://developers.weixin.qq.com/platform/" target="_blank">微信开发者平台</a>' +
                    '<a id="migration" href="https://developers.weixin.qq.com/doc/subscription/guide/dev/migration.html">了解详情</a>' +
                    '<a id="lookalike" href="https://developers.weixin.qq.com.example.com/" target="_blank">仿冒域名</a>' +
                    '<a href="/cgi-bin/appmsgpublish?sub=list&begin=0&count=10&token=42">发表记录</a>' +
                    ['文章','贴图'].map((kind,index) => '<div class="new-creation__menu-item" onclick="location.href=\'/cgi-bin/appmsg?action=edit&t=media/appmsg_edit_v2&type=' + (index ? 77 : 10) +
                      '&token=42\'"><div class="new-creation__menu-title">' + kind + '</div></div>').join('')
                )
              if (url.pathname === '/cgi-bin/appmsg' && url.searchParams.get('type') === '77') {
                return html(profile + '<input id="toolbar-file" type="file" accept="image/png" multiple>' +
                  '<div class="image-selector__add"><div class="js_upload_btn_container"><input id="album" type="file" accept="image/png" multiple></div></div>' +
                  '<div class="title-editor__input"><div id="title" contenteditable="true"></div></div><div class="share-text__input"><div id="body" contenteditable="true"><span class="editor_placeholder" contenteditable="false">填写描述信息，让大家了解更多内容</span><img class="ProseMirror-separator" alt=""></div></div>' +
                  '<button id="fake" onclick="fetch(\'/fixture-publish\',{method:\'POST\',body:JSON.stringify({title:document.querySelector(\'#title\').innerText,body:document.querySelector(\'#body\').innerText})}).then(r=>r.json()).then(j=>document.body.dataset.receipt=j.url)">模拟发表</button>' +
                  '<script>document.querySelector("#body").oninput=e=>e.target.querySelector(".editor_placeholder")?.remove();album.onchange=()=>{for(const file of album.files){const tile=document.createElement("div");tile.className="image-selector__bottom-list-item";tile.style.cssText="width:32px;height:32px";tile.style.backgroundImage="url("+URL.createObjectURL(file)+")";document.body.append(tile)}};</script>')
              }
              if (url.pathname === '/cgi-bin/appmsg')
                return html(
                  profile +
                    '<textarea id="title"></textarea><div class="rich_media_content"><div class="ProseMirror" id="body" contenteditable="true"></div></div><button id="fake" onclick="fetch(\'/fixture-publish\',{method:\'POST\',body:JSON.stringify({title:document.querySelector(\'#title\').value,body:document.querySelector(\'#body\').innerText})}).then(r=>r.json()).then(j=>document.body.dataset.receipt=j.url)">模拟发表</button>'
                )
              if (url.pathname === '/fixture-publish') {
                const entry = await req.json()
                if (entry.title !== '隔离稿件' || entry.body !== '隔离正文\n\n第二段 <图> & 标题')
                  throw Error('稿件没有完整进入编辑器')
                const link = url.origin + '/s/test_article'
                globalThis.fixtureWorks.push({ ...entry, url: link })
                return json({ url: link })
              }
              if (url.pathname === '/cgi-bin/appmsgpublish') {
                const groups = [
                  ...globalThis.fixtureWorks.map((w) => ({ ...w, status: '已发表', code: 2 })),
                  { title: '失败记录', url: url.origin + '/s/failed', status: '发表失败', code: 6 }
                ]
                const data = {
                  total_count: groups.length,
                  publish_list: groups.map((g) => ({
                    sent_result: { msg_status: g.code },
                    sent_info: { time: 1700000000 }
                  }))
                }
                return html(
                  profile +
                    '<script>wx.cgiData=' +
                    JSON.stringify(data) +
                    '</script>' +
                    groups
                      .map(
                        (g) =>
                          '<div class="publish_hover_content"><span class="weui-desktop-mass__status_text">' +
                          g.status +
                          '</span><div class="weui-desktop-mass-media"><a class="weui-desktop-mass-appmsg__title" href="' +
                          g.url +
                          '">' +
                          g.title +
                          '</a><span class="appmsg-view"><span class="weui-desktop-mass-media__data__inner">17</span></span><span class="appmsg-like"><span class="weui-desktop-mass-media__data__inner">0</span></span></div></div>'
                      )
                      .join('')
                )
              }
            }
            return new Response('', { status: 404 })
          })
        })
      },
      [path.join(root, 'test/fixtures/clip.mp4'), ['wechat','xhs'].map(k => path.join(root,'ui/brands',k+'.png'))]
    )
    const video = platform === 'channels'
    if (video) await app.evaluate(require('./weixin-native-fixture.cjs').installNativeFixture)
    const native = (expression) =>
      app.evaluate(async (_, expression) => {
        const w = globalThis.fixtureWindow()
        if (!w) return null
        return w.executeJavaScript(expression)
      }, expression)
    const until = async (fn) => {
      for (let i = 0; i < 120; i++) {
        if (await fn()) return
        await new Promise((r) => setTimeout(r, 100))
      }
      throw Error('微信测试窗口未达到预期状态')
    }
    await p.locator('nav [data-nav=accounts]').click()
    await p.locator('header [data-action=add]').click()
    await p.selectOption('#platform', platform)
    const loginEvent = video ? null : app.waitForEvent('window')
    await p.locator('#platform-login').click()
    const login = await loginEvent
    if (video) {
      await until(() => native("!!document.querySelector('#scan')"))
      await native("document.querySelector('#scan').click()")
    } else await login.locator('#scan').click()
    let a
    for (let i = 0; i < 100 && !a; i++) {
      a = await p.evaluate(
        async (platform) =>
          (await studio.snapshot()).accounts.find(
            (a) => a.platform === platform && a.name === '隔离测试'
          ),
        platform
      )
      if (!a) await new Promise((r) => setTimeout(r, 100))
    }
    assert(a, 'verified account must be saved')
    if (video)
      await app.evaluate(async () => {
        const w = globalThis.fixtureWindow()
        w.destroy()
        await w.exit
      })
    else {
      const developer = 'https://developers.weixin.qq.com/platform/'
      await login.locator('#developer').click()
      assert.deepEqual(await app.evaluate(() => globalThis.externalLinks.splice(0)), [developer])
      await login.close()
      await p.locator('.account-pick[data-id="' + a.id + '"]').click()
      await p.waitForFunction(() => document.querySelector('#tab-identity')?.textContent.startsWith('已核对'))
      const clickLink = id => app.evaluate(async ({ BrowserWindow }, id) => {
        const owner = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:'))
        const tab = owner.contentView.children[0].webContents
        await tab.executeJavaScript('document.getElementById(' + JSON.stringify(id) + ').click()', true)
        return tab.getURL()
      }, id)
      const from = await clickLink('developer')
      assert.deepEqual(await app.evaluate(() => globalThis.externalLinks), [developer])
      assert.equal(await clickLink('lookalike'), from)
      assert.equal(await clickLink('migration'), from)
      await until(() => app.evaluate(() => globalThis.externalLinks.length >= 2))
      assert.deepEqual(await app.evaluate(() => globalThis.externalLinks), [
        developer,
        'https://developers.weixin.qq.com/doc/subscription/guide/dev/migration.html'
      ])
      await app.evaluate(({ shell }) => {
        shell.openExternal = async () => { throw Error('模拟默认浏览器启动失败') }
      })
      assert.equal(await clickLink('developer'), from)
      await until(() => app.evaluate(() => globalThis.fixtureNotice === '未能打开系统默认浏览器'))
    }
    if (video) {
      await p.locator('nav [data-nav=accounts]').click()
      await p.locator('.account-pick[data-id="' + a.id + '"]').click()
      await until(() =>
        app.evaluate(async () => {
          const tab = globalThis.fixtureTab()
          return (
            !!tab &&
            tab.getURL().endsWith('/platform') &&
            (await tab.executeJavaScript('!!window._store.userStore'))
          )
        })
      )
      const host = await p.locator('#official-pane').evaluate(el => el.getBoundingClientRect().toJSON())
      const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
        const owner = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:'))
        return { bounds: globalThis.fixtureTab().fixtureBounds,
          scale: screen.getDisplayMatching(owner.getBounds()).scaleFactor }
      })
      assert.equal(host.y, 0)
      assert.equal(geometry.bounds.y, 0)
      assert.equal(geometry.bounds.height, Math.round(host.height * geometry.scale))
      assert.ok(Math.abs(geometry.bounds.width - host.width * geometry.scale) <= geometry.scale + 1)
      await p.locator('.pick-tools').click()
      await p.locator('dialog [data-action=profile-mode]').click()
    }
    await p.locator('nav [data-nav=' + (video ? 'video' : 'write') + ']').click()
    if (video) await p.locator('#video-drop').click()
    if (platform === 'wechat') await p.locator('[data-action=images]').click()
    await p.fill('#title', '隔离稿件')
    const expectedBody = video ? '隔离正文' : '隔离正文\n\n第二段 <图> & 标题'
    await p.fill('#body', expectedBody)
    await p.locator('#targets input').check()
    if (video) {
      await p.waitForFunction(() => document.getElementById('clip-player').readyState >= 2)
      await p.locator('[data-desk=make-covers]').click()
      await p.waitForFunction(() => document.querySelectorAll('#cover-formats img').length === 2)
    }
    await p.locator('#enqueue').click()
    const job = await p.evaluate(async () =>
      (await studio.snapshot()).jobs.find((j) => j.title === '隔离稿件')
    )
    assert(job)
    const editorEvent = video ? null : app.waitForEvent('window')
    await p.locator('#jobs [data-action=open][data-id="' + job.id + '"]').click()
    const editor = await editorEvent
    if (video) await until(() => native("!!document.querySelector('wujie-app')?.shadowRoot?.querySelector('#fake')"))
    else await editor.waitForSelector('#fake', { timeout: 12000 })
    const menu = (label) =>
      app.evaluate(async ({ BrowserWindow }, label) => {
        if (globalThis.fixtureWindow) {
          globalThis.fixtureWindow().emit('action', label)
          return
        }
        const win = BrowserWindow.getAllWindows().find((w) => w.getParentWindow())
        await win.fixtureMenu.items.find((i) => i.label === label).click()
      }, label)
    if (video) {
      await until(() => native("document.querySelector('wujie-app').shadowRoot.querySelector('#file').files.length===1"))
    }
    if (!video) {
      assert.equal(new URL(editor.url()).searchParams.get('type'),'77')
      await editor.waitForFunction(body => document.querySelector('#body').innerText === body, expectedBody)
      assert.equal(await editor.locator('#body img:not(.ProseMirror-separator),#body script').count(),0)
      assert.equal(await editor.locator('#title').innerText(),'隔离稿件')
      assert.equal(await editor.locator('.image-selector__bottom-list-item').count(),2)
      assert.equal(await editor.locator('#toolbar-file').evaluate(n=>n.files.length),0)
      assert.equal(await editor.locator('body').getAttribute('data-receipt'),null)
    }
    let url
    if (video) {
      await until(() => native("document.querySelector('wujie-app').shadowRoot.querySelector('#body').innerText==='隔离正文'"))
      await until(() => native("document.querySelector('wujie-app').shadowRoot.querySelector('.vertical-cover-wrap').dataset.file==='竖版封面.jpg'"))
      await until(() => native("document.querySelector('wujie-app').shadowRoot.querySelector('.horizon-cover-wrap').dataset.file==='横版封面.jpg'"))
      await until(() => p.evaluate(async () => Object.values((await studio.snapshot()).videoProgress).some(v=>v.phase==='ready')))
      assert.equal(await native("document.body.dataset.receipt"),undefined)
      await native("document.querySelector('wujie-app').shadowRoot.querySelector('#fake').click()")
      await until(() => native('!!document.body.dataset.receipt'))
      url = await native('document.body.dataset.receipt')
      await app.evaluate(async () => {
        const w = globalThis.fixtureWindow()
        w.destroy()
        await w.exit
      })
    } else {
      await editor.waitForFunction(
        body => document.querySelector('#body').innerText === body,
        expectedBody,
        { timeout: 5000 }
      )
      await editor.locator('#fake').click()
      await editor.waitForFunction(() => !!document.body.dataset.receipt)
      url = await editor.evaluate(() => document.body.dataset.receipt)
      await editor.close()
    }
    await p.evaluate(([id, url]) => studio.record(id, url), [job.id, url])
    const work = await p.evaluate(
      async (id) => (await studio.insights()).native.find((w) => w.jobId === id),
      job.id
    )
    assert.equal(work.draftId, job.draftId)
    assert.equal(work.views, 17)
    assert.equal(work.likes, 0)
    await assert.rejects(
      p.evaluate(
        ([id, url]) => studio.record(id, url),
        [job.id, 'https://mp.weixin.qq.com/s/other']
      )
    )
    await app.evaluate(() => {
      globalThis.changedOwner = true
    })
    await assert.rejects(
      p.evaluate((id) => studio['sync-works'](id, '0'), a.id),
      /身份|账号|标识/
    )
    console.log(
      'PASS ' +
        platform +
        ' isolated login, editor handoff, simulated receipt, metrics, draft link and switched account'
    )
  } finally {
    await app.close()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 180 })
  }
}
;(async () => {
  for (const platform of process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['wechat', 'channels'])
    await run(platform)
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
