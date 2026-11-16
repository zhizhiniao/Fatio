// Passed to Electron's main process by Playwright. No request in this temporary
// WebView2 profile leaves the fixture, including requests to unexpected origins.
async function installNativeFixture({ app }) {
  if (!app.getPath('userData').includes('ja-weixin-'))
    throw Error('fixture requires an isolated profile')
  const requireApp = process
    .getBuiltinModule('node:module')
    .createRequire(app.getAppPath() + '/package.json')
  const { ChannelsWindow, channelWindows } = requireApp('./src/channels-window.cjs')
  globalThis.fixtureWindow = () => channelWindows().find((w) => w.mode === 'window')
  globalThis.fixtureTab = () => channelWindows().find((w) => w.mode === 'embed')
  let logged = false
  const send = ChannelsWindow.prototype.send
  ChannelsWindow.prototype.send = function (op, args) {
    if (op === 'bounds') this.fixtureBounds = args
    if (op === 'confirm') return Promise.resolve(true)
    if (op === 'notice') return Promise.resolve()
    return send.call(this, op, args)
  }
  const load = ChannelsWindow.prototype.loadURL
  ChannelsWindow.prototype.loadURL = async function (url) {
    if (!this.fixtureInstalled) {
      this.fixtureInstalled = true
      await this.send('subscribe', 'Fetch.requestPaused')
      this.debugger.on('message', (_, method, p) => {
        if (method !== 'Fetch.requestPaused') return
        const url = new URL(p.request.url),
          base = 'https://channels.weixin.qq.com'
        let html = '',
          json,
          code = 200
        const script =
          '<script>window._store={userStore:{getAuthData:()=>fetch("/cgi-bin/mmfinderassistant-bin/auth/auth_data",{method:"POST"}).then(r=>r.json())},postStore:{pageSize:10,changePageAsync:n=>fetch("/cgi-bin/mmfinderassistant-bin/post/post_list",{method:"POST",body:JSON.stringify({currentPage:n,pageSize:10})}).then(r=>r.json())}}</script>'
        if (url.origin !== base) code = 403
        else if (url.pathname === '/fixture-login') {
          logged = true
          json = { ok: true }
        } else if (url.pathname.endsWith('/auth/auth_data'))
          json = logged
            ? {
                errCode: 0,
                data: {
                  finderUser: {
                    finderUsername: globalThis.changedOwner ? 'other@finder' : 'studio@finder',
                    nickname: '隔离测试'
                  }
                }
              }
            : { errCode: 100 }
        else if (!logged)
          html =
            '<button id="scan" onclick="fetch(\'/fixture-login\').then(()=>location.reload())">模拟扫码</button>'
        else if (url.pathname.endsWith('/post/post_list') && url.pathname.startsWith('/cgi-bin'))
          json = {
            errCode: 0,
            data: { totalCount: globalThis.fixtureWorks.length, list: globalThis.fixtureWorks }
          }
        else if (url.pathname === '/fixture-publish') {
          const d = JSON.parse(p.request.postData)
          if (d.file !== 1 || d.title !== '隔离稿件' || d.body !== '隔离正文') code = 400
          else {
            const id = 'finder/7777777777777777777+v1='
            globalThis.fixtureWorks.push({
              id,
              finderUsername: 'studio@finder',
              desc: { description: d.body },
              readCount: 17,
              likeCount: 0
            })
            json = { url: base + '/platform/post/list?objectId=' + encodeURIComponent(id) }
          }
        } else if (url.pathname === '/platform/post/create')
          html =
            script +
            `<wujie-app></wujie-app><script>
            const root = document.querySelector('wujie-app').attachShadow({mode:'open'});
            root.innerHTML = '<input type=file accept="video/mp4" id=file><input id=title placeholder="短标题"><div class="input-editor" id=body contenteditable></div><button class="horizon-cover-wrap">分享卡片 4:3</button><button class="vertical-cover-wrap">个人主页卡片 3:4</button><button id=fake>模拟发表</button>';
            const find = s => root.querySelector(s);
            for (const [slot, caption] of [['horizon','编辑分享卡片'],['vertical','编辑个人主页卡片']]) {
              const entry = find('.'+slot+'-cover-wrap');
              entry.onclick = () => {
                const dialog = document.createElement('div');
                dialog.className='weui-desktop-dialog';
                dialog.innerHTML='<h3>'+caption+'</h3><div class="single-cover-uploader-wrap"><input type=file accept="image/jpeg"></div><button disabled>确认</button>';
                root.append(dialog);
                const input=dialog.querySelector('input'), ok=dialog.querySelector('button');
                input.onchange=()=>{
                  const crop=document.createElement('div');
                  crop.className='weui-desktop-dialog';
                  crop.innerHTML='<h3>裁剪封面图</h3><button>确定</button>';
                  root.append(crop);
                  crop.querySelector('button').onclick=()=>{crop.remove();ok.disabled=false};
                };
                ok.onclick=()=>{entry.dataset.file=input.files[0].name;const img=new Image();img.src=URL.createObjectURL(input.files[0]);entry.append(img);dialog.remove()};
              };
            }
            find('#fake').onclick=()=>fetch('/fixture-publish',{method:'POST',body:JSON.stringify({file:find('#file').files.length,title:find('#title').value,body:find('#body').innerText})}).then(r=>r.json()).then(j=>document.body.dataset.receipt=j.url);
            </script>`
        else if (url.pathname === '/platform' || url.pathname === '/platform/post/list')
          html = script
        else code = 404
        const bytes = Buffer.from(json === undefined ? html : JSON.stringify(json))
        void this.debugger
          .sendCommand('Fetch.fulfillRequest', {
            requestId: p.requestId,
            responseCode: code,
            responseHeaders: [
              {
                name: 'Content-Type',
                value: json === undefined ? 'text/html;charset=UTF-8' : 'application/json'
              }
            ],
            body: bytes.toString('base64')
          })
          .catch(() => {})
      })
      await this.debugger.sendCommand('Fetch.enable', { patterns: [{ urlPattern: 'https://*' }] })
    }
    return load.call(this, url)
  }
}
module.exports = { installNativeFixture }
