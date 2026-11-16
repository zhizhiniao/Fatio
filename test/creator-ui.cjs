const { _electron } = require('playwright')
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path')
const root = path.resolve(__dirname, '..')
async function run(platform) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ja-creator-')),
    env = { ...process.env, JASTUDIO_TEST_DATA: dir }
  delete env.ELECTRON_RUN_AS_NODE
  const image = path.join(dir, 'cover.png')
  await fs.copyFile(path.join(root, 'ui/brands/xhs.png'), image)
  const exe = env.JASTUDIO_INSTALLED_EXE
  if(exe)env.PATH=path.join(process.env.SystemRoot,'system32')
  const app = await _electron.launch(
    exe ? { executablePath: exe, args: [], env, cwd: dir } : { args: [root], env }
  )
  try {
    const p = await app.firstWindow()
    p.setDefaultTimeout(7000)
    await p.waitForSelector('#overview .kpis')
    await app.evaluate(
      ({ app, BrowserWindow, dialog }, [clip, image, platform]) => {
        const original = BrowserWindow.prototype.setMenu
        BrowserWindow.prototype.setMenu = function (menu) {
          this.fixtureMenu = menu
          return original.call(this, menu)
        }
        globalThis.posts = []
        globalThis.foreign = false
        dialog.showMessageBox = async (_w, o) => {
          globalThis.notice = o.message
          return { response: o.type === 'question' ? 1 : 0 }
        }
        dialog.showOpenDialog = async (_w, o) => ({
          canceled: false,
          filePaths: [o.filters[0].extensions.includes('mp4') ? clip : image]
        })
        app.on('session-created', (s) => {
          if (!s.storagePath?.includes('ja-creator-')) return
          const json = (x) =>
            new Response(JSON.stringify(x), { headers: { 'Content-Type': 'application/json' } })
          const html = (x) =>
            new Response(x, { headers: { 'Content-Type': 'text/html;charset=utf-8' } })
          const ks = platform === 'kuaishou',
            bi = platform === 'bilibili',
            tt = platform === 'tiktok',
            uid = tt
              ? '7123456789012345678'
              : bi
                ? '123456'
                : ks
                  ? '652233'
                  : '611111111111111111111111'
          const imageSlot = '<input type="file" aria-label="视频封面" accept="image/jpeg" id="cover">'
          const coverPanel = (ks ? '<div><span>封面设置</span></div><div><div id="openCover">编辑</div></div>' :
            '<div class="upload-cover" id="openCover">设置封面</div>') +
            '<div class="' + (ks ? 'ant-modal' : 'd-modal') + '" hidden id="coverDialog"><h3>编辑封面</h3><button id="localCover">上传封面</button><div id="coverSlot"></div><button id="confirmCover" disabled>确定</button></div>' +
            '<script>openCover.onclick=()=>coverDialog.hidden=false;localCover.onclick=()=>{coverSlot.innerHTML=' + JSON.stringify(imageSlot) +
            ';coverSlot.firstChild.onchange=()=>confirmCover.disabled=false};confirmCover.onclick=()=>{document.body.dataset.cover=coverSlot.firstChild.files[0].name;coverDialog.hidden=true}</script>'
          s.protocol.handle('https', async (req) => {
            const u = new URL(req.url)
            const domains = bi
              ? ['member.bilibili.com', 'passport.bilibili.com', 'api.bilibili.com']
              : [tt ? 'www.tiktok.com' : ks ? 'cp.kuaishou.com' : 'creator.xiaohongshu.com']
            if (!domains.includes(u.hostname)) return new Response('', { status: 403 })
            if (u.pathname === '/mock-login') {
              await s.cookies.set({
                url: u.origin,
                name: 'testuser',
                value: '1',
                expirationDate: Date.now() / 1000 + 3600
              })
              return json({ ok: true })
            }
            if (tt) {
              if (
                u.pathname === '/tiktokstudio' &&
                !(await s.cookies.get({ name: 'testuser' })).length
              )
                return Response.redirect('https://www.tiktok.com/login/qrcode', 302)
              if (u.pathname === '/passport/web/account/info/') {
                const signed = (await s.cookies.get({ name: 'testuser' })).length
                return json(
                  signed
                    ? {
                        message: 'success',
                        data: {
                          user_id_str: globalThis.foreign ? '999999' : uid,
                          username: 'studio_test',
                          screen_name: '笔记测试'
                        }
                      }
                    : { message: 'error' }
                )
              }
              if (u.pathname === '/tiktokstudio/content')
                return html(
                  '<script id="__Creator_Center_Context__" type="application/json">' +
                    JSON.stringify({
                      firstBatchQueryItems: {
                        status_code: 0,
                        item_list: globalThis.posts,
                        has_more: false
                      }
                    }) +
                    '</script>'
                )
              if (u.pathname === '/tiktokstudio/upload')
                return html(
                  imageSlot + '<input type="file" id="file" accept="video/mp4"><textarea placeholder="Caption" id="caption"></textarea><button id="submit" onclick="fetch(\'/mock-publish\',{method:\'POST\',body:JSON.stringify({file:file.files.length,body:caption.value})}).then(r=>r.json()).then(j=>document.body.dataset.post=j.id)">本地模拟发表</button>'
                )
            }
            if (bi) {
              const signed = (await s.cookies.get({ name: 'testuser' })).length
              if (u.pathname === '/x/web-interface/nav')
                return json(
                  signed
                    ? {
                        code: 0,
                        data: {
                          isLogin: true,
                          mid: globalThis.foreign ? '999999' : uid,
                          uname: '笔记测试'
                        }
                      }
                    : { code: -101 }
                )
              if (u.pathname === '/platform/home' && !signed)
                return Response.redirect('https://passport.bilibili.com/login', 302)
              if (u.pathname === '/login')
                return html(
                  '<button id="login" onclick="fetch(\'/mock-login\').then(()=>this.textContent=\'扫码成功\')">模拟手机确认</button>'
                )
              if (u.pathname === '/x/web/archives') {
                const list = globalThis.posts.filter((w) => w.Archive)
                return json({
                  code: 0,
                  data: { arc_audits: list, page: { pn: 1, ps: 30, count: list.length } }
                })
              }
              if (u.pathname === '/x/article/viewinfo') {
                const item = globalThis.posts.find((w) => w.cv === 'cv' + u.searchParams.get('id'))
                return json(
                  item
                    ? {
                        code: 0,
                        data: { mid: uid, title: item.title, stats: { view: 12, like: 0 } }
                      }
                    : { code: -404 }
                )
              }
            }
            if (u.pathname === '/rest/cp/creator/pc/home/userInfo') {
              const signed = (await s.cookies.get({ name: 'testuser' })).length
              return json(
                signed
                  ? {
                      result: 1,
                      data: {
                        coreUserInfo: {
                          userId: globalThis.foreign ? '999999' : uid,
                          userName: '笔记测试',
                          fansNum: 2
                        }
                      }
                    }
                  : { result: 109 }
              )
            }
            if (u.pathname === '/article/manage/video')
              return html(
                '<script>fetch("/rest/cp/works/v2/video/pc/photo/list",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({queryType:"1",cursor:1893456000000})})</script>'
              )
            if (u.pathname === '/rest/cp/works/v2/video/pc/photo/list') {
              const q = await req.json()
              if (q.queryType !== '1') return json({ result: 400 })
              return json({ result: 1, list: globalThis.posts, nextCursor: 'no_more' })
            }
            if (u.pathname === '/api/galaxy/user/info') {
              const signed = (await s.cookies.get({ name: 'testuser' })).length
              return json(
                signed
                  ? {
                      success: true,
                      code: 0,
                      data: {
                        userId: globalThis.foreign ? '633333333333333333333333' : uid,
                        userName: '笔记测试',
                        redId: 'testwriter'
                      }
                    }
                  : { code: -100 }
              )
            }
            if (u.pathname === '/new/note-manager')
              return html(
                '<div class="tab-list"><button class="tab-item" onclick="this.classList.add(\'tab-item--active\');fetch(\'/api/galaxy/v2/creator/note/user/posted?tab=1&page=0\')">已发布</button></div><script>fetch("/api/galaxy/user/info")</script>'
              )
            if (u.pathname === '/api/galaxy/v2/creator/note/user/posted')
              return json({ code: 0, success: true, data: { notes: globalThis.posts, page: -1 } })
            if (u.pathname === '/mock-publish' && req.method === 'POST') {
              const data = await req.json(),
                id = '67777777777777777777777' + (globalThis.posts.length + 1)
              if (((!bi || data.video) && !data.file) || (!tt && !data.title) || !data.body)
                throw Error('missing fixture draft')
              if (tt) {
                const id = '7999999999999999991'
                globalThis.posts.push({
                  status: 102,
                  item_id: id,
                  author_id: uid,
                  desc: data.body,
                  play_count: 12,
                  like_count: 0
                })
                return json({ id })
              }
              if (bi) {
                const id = data.video ? 'BV1abcdef0123' : 'cv9876'
                globalThis.posts.push(
                  data.video
                    ? {
                        Archive: { bvid: id, state: 0, mid: uid, title: data.title },
                        stat: { view: 12, like: 0 }
                      }
                    : { cv: id, title: data.title }
                )
                return json({ id })
              }
              globalThis.posts.push(
                ks
                  ? {
                      workId: id,
                      userId: uid,
                      title: data.title,
                      uploadTime: Date.now(),
                      playCount: 12,
                      likeCount: 0,
                      commentCount: 1
                    }
                  : {
                      id,
                      user_id: uid,
                      display_title: data.title,
                      time: Date.now(),
                      view_count: 12,
                      likes: 0,
                      comments_count: 1
                    }
              )
              return json({ id })
            }
            if (bi && ['/platform/upload/video/frame', '/york/read-editor'].includes(u.pathname)) {
              const video = u.pathname.includes('/video/')
              return html(
                (video ? imageSlot : '') + (video
                  ? '<div class="bcc-upload-wrapper"><input id="file" type="file" accept=".mp4"></div><input id="shadow" type="file" accept=".mp4"><div class="tag-list"><input placeholder="输入标签" id="tags"></div><script>tags.onkeydown=e=>{if(e.key==="Enter"){let n=document.createElement("span");n.className="tag-item";n.textContent=tags.value;tags.parentNode.append(n);tags.value=""}}</script>'
                  : '') +
                  '<textarea id="title" placeholder="请输入标题"></textarea><div contenteditable="true" id="body"></div><button id="submit" onclick="fetch(\'/mock-publish\',{method:\'POST\',body:JSON.stringify({video:' +
                  video +
                  ",file:document.querySelector('#file')?.files.length,title:document.querySelector('#title').value,body:document.querySelector('#body').innerText})}).then(r=>r.json()).then(j=>document.body.dataset.post=j.id)\">本地模拟发表</button>"
              )
            }
            if (['/publish/publish', '/article/publish/video'].includes(u.pathname)) {
              const accept = (
                ks
                  ? u.searchParams.get('tabType') === '1'
                  : u.searchParams.get('target') === 'video'
              )
                ? 'video/mp4'
                : 'image/png'
              const graphic = accept === 'image/png'
              const previews = graphic
                ? '<div class="ant-tabs-tabpane-active"><button id="pick">上传图片</button><div id="previews" class="' +
                  (ks ? 'swiper-wrapper' : 'img-container') + '"></div>'
                : coverPanel
              return html(
                previews + '<input id="file" type="file" accept="' +
                  accept +
                  '" multiple><input id="title" ' + (graphic && ks ? 'type="hidden" ' : '') + 'placeholder="' + (graphic && ks ? '' : '标题') +
                  '"><div contenteditable="true" class="tiptap ProseMirror" id="' + (graphic && ks ? 'work-description-edit' : 'body') +
                  '"></div><button id="submit" onclick="fetch(\'/mock-publish\',{method:\'POST\',body:JSON.stringify({file:Number(document.body.dataset.received)||file.files.length,title:document.querySelector(\'#title\').value||document.querySelector(\'[contenteditable]\').innerText.split(\'\\n\')[0],body:document.querySelector(\'[contenteditable]\').innerText})}).then(r=>r.json()).then(j=>document.body.dataset.post=j.id)">本地模拟发表</button>' +
                  (graphic ? '</div><script>let armed=' + !ks + ';pick.onclick=()=>{armed=true;file.click()};file.onchange=()=>{if(!armed)return;document.body.dataset.received=file.files.length;for(const f of file.files){const card=document.createElement("div");card.className="' +
                    (ks ? '_upload-item_fixture' : 'format-img') + '";const img=new Image();img.className="preview";img.src=URL.createObjectURL(f);card.append(img);previews.append(card)}};</script>' : '')
              )
            }
            return html(
              '<button id="login" onclick="fetch(\'/mock-login\').then(()=>location.reload())">模拟登录</button>'
            )
          })
        })
      },
      [path.join(root, 'test/fixtures/clip.mp4'), image, platform]
    )
    await p.locator('nav [data-nav=accounts]').click()
    const openLogin = async () => {
      await p.locator('header [data-action=add]').click()
      await p.selectOption('#platform', platform)
      const opened = app.waitForEvent('window')
      await p.locator('#platform-login').click()
      return opened
    }
    let login = await openLogin()
    if (platform === 'bilibili') {
      await login.waitForSelector('#login')
      const partition = () =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().find((w) => w.getParentWindow()).webContents.session
              .storagePath
        )
      const original = await partition()
      await login.close()
      login = await openLogin()
      assert.equal(
        await partition(),
        original,
        'a closed passport tab must resume the same account session'
      )
    }
    await login.locator('#login').click()
    let a
    for (let i = 0; i < 120 && !a; i++) {
      a = await p.evaluate(async (platform) => {
        const s = await studio.snapshot()
        return s.accounts.find(
          (a) =>
            a.platform === platform &&
            s.sessions.some((u) => u.accountId === a.id && u.name === '笔记测试')
        )
      }, platform)
      if (!a) await new Promise((r) => setTimeout(r, 120))
    }
    assert(a, 'login and stable identity must be saved')
    await login.close()
    for (const kind of platform === 'tiktok' ? ['video'] : ['video', 'article']) {
      await p.locator('nav [data-nav=' + (kind === 'video' ? 'video' : 'write') + ']').click()
      if (kind === 'video') await p.locator('#video-drop').click()
      else if (platform !== 'bilibili') await p.locator('[data-action=images]').click()
      await p.fill('#title', '本地' + kind)
      await p.fill('#body', '仅隔离稿件')
      if (platform === 'bilibili' && kind === 'video') await p.fill('#video-tags', '教程 AE')
      await p.locator('#targets input').check()
      if (kind === 'video') {
        await p.waitForFunction(() => document.getElementById('clip-player').readyState >= 2)
        await p.locator('[data-desk=make-covers]').click()
        await p.waitForFunction(() => document.querySelectorAll('#cover-formats img').length === 1)
      }
      await p.locator('#enqueue').click()
      const target = await p.evaluate(
        async (title) => (await studio.snapshot()).jobs.find((j) => j.title === title),
        '本地' + kind
      )
      assert(target, 'target job missing')
      const open = p.locator('#jobs [data-action=open][data-id="' + target.id + '"]')
      const windowWait = app.waitForEvent('window')
      await open.click()
      const upload = await windowWait
      const menu = (label) =>
        app.evaluate(async ({ BrowserWindow }, label) => {
          const w = BrowserWindow.getAllWindows().find((w) =>
            /\/(publish\/publish|article\/publish\/video|platform\/upload\/video\/frame|york\/read-editor|tiktokstudio\/upload)/.test(
              w.webContents.getURL()
            )
          )
          await w.fixtureMenu.items.find((i) => i.label === label).click()
        }, label)
      const automatic = kind === 'article' && ['xhs','kuaishou'].includes(platform)
      const combined = automatic && platform === 'kuaishou'
      await upload.waitForSelector(platform === 'tiktok' ? '#caption' : combined ? '#work-description-edit' : '#title')
      if (automatic) {
        await upload.waitForFunction(single => document.body.dataset.received === '1' &&
          (single || document.querySelector('#title').value === '本地article') &&
          document.querySelector('[contenteditable]').innerText === (single ? '本地article\n仅隔离稿件' : '仅隔离稿件'),
          combined, { timeout: 10000 })
        assert.equal(await upload.locator('#previews img').count(), 1)
        assert.equal(await upload.locator('body').getAttribute('data-post'), null)
      }
      if (!automatic && kind !== 'video' && platform !== 'bilibili') await menu('选入本次配图')
      if (!automatic && (kind === 'video' || platform !== 'bilibili'))
        await upload.waitForFunction(
          () => document.querySelector('#file')?.files.length === 1,
          null,
          { timeout: 5000 }
        )
      if (!automatic && kind !== 'video') await menu('填入本稿标题和正文')
      if (!combined) await upload.waitForFunction(
        () => Boolean(document.querySelector('#caption,#title')?.value),
        null,
        { timeout: 5000 }
      )
      if (platform === 'bilibili' && kind === 'video')
        assert.equal(await upload.locator('#shadow').evaluate((n) => n.files.length), 0)
      if (platform === 'tiktok')
        assert.equal(
          await upload.inputValue('#caption'),
          '本地video\n仅隔离稿件',
          JSON.stringify([upload.url(), await app.evaluate(() => globalThis.notice)])
        )
      else {
        if (!combined) assert.equal(
          await upload.inputValue('#title'),
          '本地' + kind,
          JSON.stringify([upload.url(), await app.evaluate(() => globalThis.notice)])
        )
        assert.equal(await upload.locator('[contenteditable]').first().innerText(), combined ? '本地article\n仅隔离稿件' : '仅隔离稿件')
      }
      if (platform === 'bilibili' && kind === 'video') assert.deepEqual(await upload.locator('.tag-item').allTextContents(),['教程','AE'])
      if (kind === 'video') {
        await p.locator('#jobs .row').filter({has:p.locator('[data-id="' + target.id + '"]')})
          .locator('.sync-stage[data-phase=ready]').waitFor({timeout:20000})
        const expected = platform === 'bilibili' ? '横版封面.jpg' : '竖版封面.jpg'
        assert.equal(await upload.locator('#cover').evaluate(n=>n.files[0]?.name),expected,
          JSON.stringify({platform,formats:target.coverFormats,receipt:await upload.locator('body').getAttribute('data-cover'),
            progress:await p.evaluate(async id=>(await studio.snapshot()).videoProgress[id],target.id)}))
        if (['kuaishou','xhs'].includes(platform)) assert.equal(await upload.locator('body').getAttribute('data-cover'),expected)
      }
      await upload.locator('#submit').click()
      await upload.waitForFunction(() => !!document.body.dataset.post)
      const id = await upload.evaluate(() => document.body.dataset.post)
      await upload.close()
      const job = await p.evaluate(
        async (title) => (await studio.snapshot()).jobs.find((j) => j.title === title),
        '本地' + kind
      )
      const prefix =
        platform === 'tiktok'
          ? 'https://www.tiktok.com/@studio_test/video/'
          : platform === 'bilibili'
            ? 'https://www.bilibili.com/' + (kind === 'video' ? 'video/' : 'read/')
            : platform === 'xhs'
              ? 'https://www.xiaohongshu.com/explore/'
              : 'https://www.kuaishou.com/short-video/'
      if (automatic) {
        await p.waitForFunction(() => !checkingQueue)
        await p.locator('header [data-action=reconcile-queue]').click()
        await p.waitForFunction(() => document.querySelector('#pending').textContent === '')
        await p.locator('#queue-filters [data-id=done]').click()
        assert.equal(await p.locator('#jobs [data-action=visit][data-id="'+job.id+'"]').count(), 1)
        const updated = await p.evaluate(async id => (await studio.snapshot()).jobs.find(j=>j.id===id), job.id)
        assert.equal(updated.status, 'published')
        assert.equal(updated.url, prefix + id)
      } else {
        await p.evaluate(([job, url]) => studio.record(job, url), [job.id, prefix + id])
      }
      const w = await p.evaluate(
        async (id) => (await studio.insights()).native.find((w) => w.itemId === id),
        id
      )
      assert.equal(w.jobId, job.id)
      assert.equal(w.draftId, job.draftId)
      assert.equal(w.views, 12)
      assert.equal(w.likes, 0)
    }
    await app.evaluate(() => {
      globalThis.foreign = true
    })
    await assert.rejects(
      p.evaluate((id) => studio['sync-works'](id, '0'), a.id),
      /身份/
    )
    console.log(
      'PASS ' +
        platform +
        ' isolated login, supported editor handoff, fixture receipt and draft link, zero metrics and switched UID'
    )
  } finally {
    await app.close()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
;(async () => {
  for (const p of process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['xhs', 'kuaishou', 'bilibili', 'tiktok'])
    await run(p)
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
