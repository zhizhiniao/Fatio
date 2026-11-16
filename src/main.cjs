const {
  app,
  BrowserWindow,
  Menu,
  session,
  ipcMain,
  protocol,
  dialog,
  clipboard,
  safeStorage,
  nativeImage,
  net,
  shell
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const brand = require('./brand.cjs')
const { UpdateService } = require('./updates.cjs')
const { pathToFileURL } = require('node:url')
const { Store } = require('./store.cjs')
const { accountInput, platforms, editorUrl, allowedPage, receiptUrl } = require('./platforms.cjs')
const { credentials, xClient, identityOk, runDue } = require('./publisher.cjs')
const { prepareEditor } = require('./editor.cjs')
const { importFiles } = require('./media.cjs')
const { importVideos, videoPath, attachMedia } = require('./videos.cjs')
const { readCreator, readReview, importReport, performance } = require('./insights.cjs')
const easel = require('./easel.cjs')
const { Library } = require('./library.cjs')
const { clientFor, ORIGIN } = require('./douyin.cjs')
const { picture } = require('./pictures.cjs')
const { AccountTabs } = require('./account-tabs.cjs')
const { installAccountNavigation } = require('./account-navigation.cjs')
const { ChannelsWindow, closeChannels } = require('./channels-window.cjs')
const xhs = require('./xhs.cjs')
const kuaishou = require('./kuaishou.cjs')
const biliStudio = require('./bili-studio.cjs')
const studioPlatforms = {
  xhs,
  kuaishou,
  bilibili: biliStudio,
  wechat: require('./wechat-studio.cjs'),
  channels: require('./channels-data.cjs'),
  tiktok: require('./tiktok-studio.cjs')
}
const { watchReceipt, armReceipt, fillDraft } = require('./douyin-window.cjs')
const { graphicPlatforms, installGraphicEditor } = require('./graphic-editor.cjs')
const { createVideoHandoff, videoMaterials, draftCopy } = require('./video-handoff.cjs')
const { QueueReconciler } = require('./queue-reconcile.cjs')
const { randomUUID, createHash } = require('node:crypto')
const { bilibili, reportItems, canonicalId } = require('./platform-data.cjs')
const { fromPage, checkPage } = require('./public-work.cjs')
const nasExport = require('./nas-export.cjs')
const autoSample = require('./auto-sample.cjs')
const videoRoot = () => path.join(app.getPath('userData'), 'videos')
protocol.registerSchemesAsPrivileged([{scheme:'studio-media',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true,corsEnabled:true}}])
const index = path.join(__dirname, '../ui/index.html')
const homeUrl = pathToFileURL(index).href
app.setName(brand.name)
const dataDirectory = brand.dataDirectory(app.getPath('appData'))
fs.mkdirSync(dataDirectory, { recursive: true })
app.setPath('userData', dataDirectory)
app.setPath('sessionData', dataDirectory)
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', (_, argv) => {
    if (main) {
      main.show()
      main.focus()
      void requestedAccount(argv).catch((e) => notify(main, e.message))
      requestedLogin(argv)
    }
  })
  app.whenReady().then(start)
}
let main,
  accountTabs,
  store,
  library,
  queueReconciler,
  receiptTimer,
  exportTimer,
  sampleTimer,
  updates,
  updateTimer,
  importRoot,
  timer,
  closing = false
const remoteWindows = new Map()
const videoEditors = new WeakMap()
const videoProgress = new Map()
const batchWaiting = new Set()
const batchAccounts = new Map()
const materialsFor = job => videoMaterials(store, job, path.join(app.getPath('userData'), 'handoff'))
async function openMaterials(job) {
  const { folder } = await materialsFor(job)
  const error = await require('electron').shell.openPath(folder)
  if (error) throw Error(error)
}
function progress(id, phase, message) {
  if (videoProgress.get(id)?.message === message && videoProgress.get(id)?.phase === phase) return
  videoProgress.set(id, {phase, message})
  if (phase !== 'queued')
    store.db.prepare('INSERT OR REPLACE INTO video_handoffs(jobId,message) VALUES(?,?)').run(id, message)
  changed()
}
function startVideoBatch(ids) {
  for (const id of ids) {
    const job = store.job(id)
    if (job.status === 'waiting' && job.videoId && store.account(job.accountId).mode === 'web') {
      if (batchAccounts.get(job.accountId) === id) continue
      batchWaiting.add(id)
      progress(id, 'queued', '等待带入平台')
    }
  }
  advanceVideoBatch()
}
function advanceVideoBatch() {
  if (closing || !main || main.isDestroyed()) return
  for (const id of batchWaiting) {
    const job = store.job(id)
    if (job.status !== 'waiting') { batchWaiting.delete(id); continue }
    if (batchAccounts.has(job.accountId)) {
      progress(id, 'queued', '等待关闭同账号上一条核对窗口')
      continue
    }
    batchWaiting.delete(id)
    try {
      const win = remote(store.account(job.accountId), job, {prepare: true, background: true})
      batchAccounts.set(job.accountId,id)
      win.once('closed', () => { batchAccounts.delete(job.accountId); setImmediate(advanceVideoBatch) })
    } catch (error) { progress(id,'partial',error.message) }
  }
}
const pendingLogin = new Map()
const focusHome = () => {
  main.show()
  main.focus()
}
// 指标快照导出到 NAS（统一数据契约 v1.4 §15 方案 A）。后台失败只记录，不打断操作。
function runNasExport(force = false) {
  if (!store) return { skipped: 'no-store' }
  try {
    return nasExport.maybeExport(store.db, { force, version: app.getVersion() })
  } catch (e) {
    if (force) throw e
    return { error: e.message }
  }
}
// 自动采样（统一数据契约 v1.4 §15.4）：每次只读一个账号，读完立即导出到 NAS。
let sampling = false
async function runAutoSample() {
  if (!store || closing || sampling || !autoSample.enabled(store.db)) return
  // 用户正开着官方窗口（发稿、核对或浏览）的账号不去打扰
  const busy = new Set(
    [...remoteWindows.entries()]
      .filter(([, w]) => w && !w.isDestroyed())
      .map(([k]) => (String(k).startsWith('view:') ? String(k).split(':')[1] : store.db.prepare('SELECT accountId FROM jobs WHERE id=?').get(k)?.accountId || k))
  )
  const next = autoSample.plan(store.db, Date.now(), busy)[0]
  if (!next) return
  sampling = true
  try {
    const r = await syncWorks(next.id, '0')
    autoSample.record(store.db, next.id, true, '读到 ' + (r?.count ?? 0) + ' 条作品')
    runNasExport()
  } catch (e) {
    autoSample.record(store.db, next.id, false, e.message)
  } finally {
    sampling = false
    changed()
  }
}
function changed() {
  if (main && !main.isDestroyed()) main.webContents.send('queue-changed')
}
async function rememberProfile(id, user) {
  if (!library.saveProfile(id, user)) return
  await picture(store.db, 'avatar:' + id, user.avatarUrl, 96, main.webContents)
  changed()
}
function remote(account, job, options = {}) {
  const key = options.viewUrl
    ? 'view:' + account.id + ':' + options.viewUrl
    : (job?.id ?? account.id)
  let win = remoteWindows.get(key)
  if (win && !win.isDestroyed()) {
    if (!options.background) { win.show(); win.focus() }
    if (options.prepare && !win.webContents.isLoadingMainFrame?.()) void videoEditors.get(win)?.()
    else if (options.prepare) win.webContents.once('did-finish-load', () => void videoEditors.get(win)?.())
    return win
  }
  if (account.archived && !options.viewUrl) throw Error('账号已移除')
  const profile = session.fromPartition(
    account.archived ? 'public-' + randomUUID() : 'persist:ja-' + account.id
  )
  profile.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  profile.setPermissionCheckHandler(() => false)
  const label =
    platforms[account.platform].label + ' · ' + account.name + ' (' + account.identity + ')'
  win =
    account.platform === 'channels'
      ? new ChannelsWindow(main, account.archived ? randomUUID() : account.id, 'window', label)
      : new BrowserWindow({
          width: 1080,
          height: 850,
          show: !options.background,
          title: label,
          parent: main,
          icon: brand.icon,
          webPreferences: {
            session: profile,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            devTools: false
          }
        })
  remoteWindows.set(key, win)
  win.on('closed', () => remoteWindows.delete(key))
  if (!win.native) {
    win.on('page-title-updated', (event) => event.preventDefault())
    installAccountNavigation(win.webContents, account.platform, win)
  }
  const submenu = []
  let refreshVideoMenu
  if (job?.videoId) {
    const run = createVideoHandoff({
      win, account, job,
      verify: () => account.platform === 'douyin' ? whoBound(win,account) : verifyCreator(account,studioPlatforms[account.platform].client(win.webContents)),
      pending: () => store.job(job.id).status === 'waiting' && !store.account(account.id).archived,
      video: () => videoPath(store, videoRoot(), job.id), materials: () => materialsFor(job),
      arm: uid => armReceipt(win.webContents,uid),
      report: (phase,message) => { if (!win.isDestroyed()) { win.setTitle(message + ' · ' + label); progress(job.id,phase,message); refreshVideoMenu?.(phase, message) } }
    })
    videoEditors.set(win,run)
    if (options.prepare) {
      progress(job.id,'working','正在打开平台')
      win.webContents.once('did-finish-load',run)
    }
    win.once('closed', () => { videoProgress.delete(job.id); changed() })
    const tools = [
      {label:'打开投稿素材文件夹', click:() => openMaterials(job).catch(e => notify(win,e.message))},
      {label:'单独选入视频', click:async () => {
        if (videoProgress.get(job.id)?.phase === 'working') return notify(win,'正在带入视频，请查看窗口标题中的进度')
        try { await transfer(win,account,job,[await videoPath(store,videoRoot(),job.id)]) }
        catch (error) { await notify(win,error.message) }
      }},
      {label:'复制视频路径', click:() => videoPath(store,videoRoot(),job.id).then(file => clipboard.writeText(file)).catch(e => notify(win,e.message))},
      {label:'复制整份文案', click:() => clipboard.writeText(draftCopy(job))}
    ]
    if (account.platform === 'douyin') tools.push({label:'核对投稿回执', click:() => {
      focusHome()
      main.webContents.send('native-job',job.id)
    }})
    let menuPhase
    refreshVideoMenu = (phase, message) => {
      if (phase === menuPhase) return
      menuPhase = phase
      const primary = phase === 'working' ? '正在带入…' : phase === 'ready' ? '已带入 · 待审核' :
        phase === 'partial' ? '继续未完成项' : '带入本稿'
      const menu = [{label:primary, enabled:!['working','ready'].includes(phase), click:run},
        {label:'投稿素材', submenu:tools}, {label:'回工作台', click:focusHome}]
      if (win.native) {
        void win.send('menu',menu.map(({label,enabled,submenu}) => ({label,enabled:enabled !== false,
          children:submenu?.map(t => t.label),hint:message || ''}))).catch(() => {})
      } else win.setMenu(Menu.buildFromTemplate(menu))
      win.videoMenuActions = [...menu, ...tools]
    }
    if (win.native) win.on('action', label => {
      const item = win.videoMenuActions?.find(i => i.label === label && i.enabled !== false)
      if (item?.click) void Promise.resolve(item.click()).catch(e => notify(win,e.message))
    })
  }
  const graphic = job && !job.videoId && graphicPlatforms.has(account.platform) && JSON.parse(job.assets).length > 0
  if (graphic) installGraphicEditor({
    win, account, job, label, menu: submenu,
    verify: () => account.platform === 'douyin' ? whoBound(win, account) :
      verifyCreator(account, studioPlatforms[account.platform].client(win.webContents)),
    getFiles: () => require('./media.cjs').materializeImages(store, job, path.join(app.getPath('userData'), 'handoff')),
    pending: () => store.job(job.id).status === 'waiting' && !store.account(account.id).archived
  })
  if (studioPlatforms[account.platform] && !job && !options.viewUrl) {
    const provider = studioPlatforms[account.platform],
      label = platforms[account.platform].label
    let busy = false,
      bound = false
    const verify = async (manual = false) => {
      if (busy || (bound && !manual) || win.isDestroyed()) return
      const current = win.webContents.getURL()
      if (
        !(account.platform === 'bilibili'
          ? allowedPage('bilibili', current)
          : current.startsWith(provider.origin + '/'))
      )
        return
      busy = true
      try {
        const user = await provider.client(win.webContents).self()
        if (win.isDestroyed()) return
        if (account.platform === 'tiktok' && /^\/login(?:\/|$)/.test(new URL(current).pathname)) {
          await win.loadURL(provider.manager)
          return
        }
        if (options.expected && user.name !== options.expected)
          throw Error('当前昵称与指定平台账号不符')
        store.atomic(() => {
          if (
            options.newAccount &&
            !store.db.prepare('SELECT id FROM accounts WHERE id=?').get(account.id)
          ) {
            const existing = store.db
              .prepare(
                'SELECT a.id FROM accounts a LEFT JOIN official_profiles p ON p.accountId=a.id WHERE a.platform=? AND a.archived<>1 AND (p.uid=? OR a.identity IN (?,?))'
              )
              .get(account.platform, user.uid, user.uid, user.handle)
            if (existing) throw Error('该平台账号已添加，请从账号列表打开原账号')
            store.addAccount(
              {
                platform: account.platform,
                mode: 'web',
                identity: account.platform === 'tiktok' ? user.handle : user.uid,
                name: user.name || user.uid
              },
              null,
              null,
              account.id
            )
          }
          if (!library.saveProfile(account.id, user)) throw Error('当前身份与绑定账号不符')
          store.db
            .prepare('INSERT OR IGNORE INTO creator_logins(accountId) VALUES(?)')
            .run(account.id)
          if (options.newAccount)
            store.db.prepare('DELETE FROM pending_logins WHERE id=?').run(account.id)
        })
        bound = true
        win.setTitle('已登录 · ' + user.name + ' · ' + label)
        changed()
        if (account.platform === 'bilibili' && new URL(current).origin !== provider.origin)
          void win.loadURL(platforms.bilibili.home).catch(() => {})
        void picture(store.db, 'avatar:' + account.id, user.avatarUrl, 96, main.webContents).then(
          changed
        )
      } catch (e) {
        if (!win.isDestroyed() && /已添加|身份与绑定账号不符|指定平台账号不符/.test(e.message))
          win.setTitle(label + ' · ' + e.message)
        if (manual && !win.isDestroyed()) await notify(win, e.message)
      } finally {
        busy = false
      }
    }
    submenu.push({ label: '核对登录身份', click: () => verify(true) })
    win.webContents.on('did-finish-load', () => verify())
    const timer = setInterval(() => verify(), 4500)
    win.once('closed', () => {
      clearInterval(timer)
      pendingLogin.delete(account.id)
    })
  }
  if (account.platform === 'douyin' && !job && !options.viewUrl) {
    let busy = false,
      done = false
    const verify = async (manual = false) => {
      if (
        busy ||
        (!manual && done) ||
        win.isDestroyed() ||
        !win.webContents.getURL().startsWith(ORIGIN + '/')
      )
        return
      busy = true
      try {
        const user = await clientFor(win.webContents).who()
        if (win.isDestroyed()) return
        if (options.expected && user.name !== options.expected)
          throw Error('当前登录昵称与指定账号「' + options.expected + '」不一致')
        store.atomic(() => {
          if (options.newAccount && !library.binding(account.id)) {
            store.addAccount(
              {
                name: user.name || user.uid,
                identity: user.handle || user.uid,
                mode: 'web',
                platform: 'douyin'
              },
              null,
              null,
              account.id
            )
          }
          library.identify(account.id, user, { firstLogin: !!options.newAccount })
        })
        done = true
        void picture(store.db, 'avatar:' + account.id, user.avatarUrl, 96, main.webContents).then(
          changed
        )
        win.setTitle('已登录 · ' + (user.name || user.uid) + ' · 抖音')
        changed()
        if (manual)
          await notify(win, '已绑定抖音账号 ' + (user.name || user.uid) + '，可回工作台同步作品。')
      } catch (e) {
        if (manual) await notify(win, e.message)
      } finally {
        busy = false
      }
    }
    submenu.push({ label: '核对登录身份', click: () => verify(true) })
    win.webContents.on('did-finish-load', () => verify())
    const poll = setInterval(() => verify(), 4000)
    win.on('closed', () => {
      clearInterval(poll)
      pendingLogin.delete(account.id)
      if (options.newAccount && !library.binding(account.id))
        void profile.clearData().catch(() => {})
    })
  }
  if (account.platform === 'douyin' && job?.videoId) {
    watchReceipt(win.webContents, job, library, changed)
  }
  if (studioPlatforms[account.platform] && job && !job.videoId && !graphic)
    submenu.push({
      label: '填入本稿标题和正文',
      click: async () => {
        try {
          if (store.job(job.id).status !== 'waiting') throw Error('任务已结束')
          await verifyCreator(account, studioPlatforms[account.platform].client(win.webContents))
          const result = await win.webContents.executeJavaScript(
            '(' +
              fillDraft.toString() +
              ')(' +
              JSON.stringify({ title: job.title, body: job.body }) +
              ',' +
              JSON.stringify(account.platform) +
              ')',
            true
          )
          await notify(win, result)
        } catch (e) {
          await notify(win, e.message)
        }
      }
    })
  if (account.platform === 'wechat' && job && !graphic) {
    const wc = win.webContents
    let opened = false,
      busy = false
    const openArticle = async (manual = false) => {
      if (
        busy ||
        (!manual && opened) ||
        win.isDestroyed() ||
        new URL(wc.getURL()).pathname !== '/cgi-bin/home'
      )
        return
      busy = true
      try {
        if (store.job(job.id).status !== 'waiting') throw Error('任务已结束')
        await verifyCreator(account, studioPlatforms.wechat.client(wc))
        if (
          !(await wc.executeJavaScript(
            '(' + studioPlatforms.wechat.enterEditor.toString() + ')()',
            true
          ))
        )
          throw Error('请在公众号后台的「新的创作」中选择「文章」')
        opened = true
      } catch (e) {
        if (manual && !win.isDestroyed()) await notify(win, e.message)
      } finally {
        busy = false
      }
    }
    wc.on('did-finish-load', () => openArticle())
    submenu.push({ label: '打开新建文章', click: () => openArticle(true) })
  }
  if (job && !job.videoId) {
    if (['x', 'xiaobot'].includes(account.platform))
      submenu.push({
        label: '填入编辑器',
        click: () => fill(job.id).catch((err) => notify(win, err.message))
      })
    submenu.push({ label: '复制正文', click: () => clipboard.writeText(job.body) })
    if (job.title) submenu.push({ label: '复制标题', click: () => clipboard.writeText(job.title) })
    const assets = JSON.parse(job.assets)
    if (!graphic && assets.length && ['douyin', 'kuaishou', 'xhs'].includes(account.platform))
      submenu.push({
        label: '选入本次配图',
        click: async () => {
          try {
            const files = await require('./media.cjs').materializeImages(
              store,
              job,
              path.join(app.getPath('userData'), 'handoff')
            )
            await transfer(win, account, job, files)
          } catch (e) {
            await notify(win, e.message)
          }
        }
      })
    if (assets.length)
      submenu.push({
        label: '复制配图',
        submenu: assets.map((assetId, i) => ({
          label: i + 1 + ' · ' + store.asset(assetId).name,
          click: () => copyImage(job.id, assetId)
        }))
      })
  }
  const menu = [...submenu, { label: '回工作台', click: focusHome }]
  if (refreshVideoMenu) refreshVideoMenu(options.prepare ? 'working' : 'idle')
  else if (win.native) {
    void win
      .send(
        'menu',
        menu.filter((x) => x.click).map((x) => x.label)
      )
      .catch(() => {})
    win.on('action', (label) => {
      const item = menu.find((x) => x.label === label)
      if (item?.click) void Promise.resolve(item.click()).catch((e) => notify(win, e.message))
    })
  } else win.setMenu(Menu.buildFromTemplate(menu))
  const url =
    options.viewUrl ||
    (job
      ? editorUrl(account, job.videoId ? 'video' : 'article')
      : account.platform === 'xiaobot'
        ? platforms.xiaobot.home + '/' + account.identity
        : platforms[account.platform].home)
  win.loadURL(url).catch((e) => {
    if (e.code === 'ERR_ABORTED') return
    if (options.prepare && job?.videoId && !win.isDestroyed()) {
      progress(job.id,'partial','官方页面加载失败，请检查网络并重开后台')
      if (options.background) return
    }
    if (!win.isDestroyed())
      void notify(
        win.native ? main : win,
        win.native ? e.message : '官方页面未能加载，请检查网络后关闭并重新打开。'
      )
  })
  return win
}
const notify = (win, message) =>
  win.native
    ? win.send('notice', message)
    : dialog.showMessageBox(win, { type: 'info', buttons: ['好'], message })
function connectCreator(platform, expected = '') {
  if (!Object.hasOwn(studioPlatforms, platform)) throw Error('请选择受支持的平台')
  const key = platform + ':' + expected
  const current = [...pendingLogin].find(([, label]) => label === key)
  if (current && remoteWindows.has(current[0])) return remoteWindows.get(current[0]).focus()
  store.db
    .prepare('INSERT OR IGNORE INTO pending_logins(platform,expected,id) VALUES(?,?,?)')
    .run(platform, expected, randomUUID())
  const { id } = store.db
    .prepare('SELECT id FROM pending_logins WHERE platform=? AND expected=?')
    .get(platform, expected)
  pendingLogin.set(id, key)
  remote({ id, platform, name: expected || '登录', identity: '待识别' }, null, {
    newAccount: true,
    expected
  })
}
function requestedLogin(argv) {
  for (const platform of Object.keys(studioPlatforms)) {
    const prefix = '--connect-' + platform + '=',
      arg = argv.find((a) => a.startsWith(prefix))
    if (arg) connectCreator(platform, arg.slice(prefix.length))
  }
}
function newDouyin(expected = '') {
  for (const [id, name] of pendingLogin)
    if (name === expected && remoteWindows.has(id)) {
      remoteWindows.get(id).focus()
      return
    }
  const id = randomUUID()
  pendingLogin.set(id, expected)
  remote({ id, name: expected || '扫码登录', identity: '待识别', platform: 'douyin' }, null, {
    newAccount: true,
    expected
  })
}
async function requestedAccount(argv) {
  const sync = argv.find((s) => s.startsWith('--sync-account='))?.slice('--sync-account='.length)
  if (!sync) return
  const accounts = store.db
    .prepare(
      'SELECT a.id FROM accounts a JOIN native_sessions s ON s.accountId=a.id WHERE a.archived=0 AND s.name=?'
    )
    .all(sync)
  if (accounts.length !== 1) throw Error('未找到唯一已登录的目标账号')
  await syncWorks(accounts[0].id)
  const entry = library.works(accounts[0].id)[0]
  if (entry) await refreshWork(entry)
  main.webContents.send('native-show-works')
}
async function whoBound(win, account) {
  const user = await clientFor(win.webContents).who()
  library.identify(account.id, user)
  return user
}
async function withCreator(account, call) {
  if (account.platform !== 'douyin' || account.archived) throw Error('请选择活动的抖音账号')
  const active = remoteWindows.get(account.id)
  if (active && active.webContents.getURL().startsWith(ORIGIN + '/'))
    return call(clientFor(active.webContents))
  const reader = new BrowserWindow({
    icon: brand.icon,
    show: false,
    webPreferences: {
      session: session.fromPartition('persist:ja-' + account.id),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      devTools: false
    }
  })
  reader.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let timer
  try {
    await Promise.race([
      reader.loadURL(ORIGIN + '/'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('抖音读取超时，请检查网络')), 18000)
      })
    ])
    return await call(clientFor(reader.webContents))
  } finally {
    clearTimeout(timer)
    if (!reader.isDestroyed()) reader.destroy()
  }
}
async function verifyCreator(a, client) {
  const user = await client.self()
  if (!library.saveProfile(a.id, user))
    throw Error('当前' + platforms[a.platform].label + '身份与绑定账号不符，请切回原账号')
  return user
}
async function readCreatorWorks(a, cursor, itemId, queueOnly = false) {
  if (a.archived) throw Error('账号已移除')
  const win =
    a.platform === 'channels'
      ? new ChannelsWindow(main, a.id, 'hidden', brand.name + ' · 视频号作品')
      : new BrowserWindow({
          icon: brand.icon,
          show: false,
          webPreferences: {
            session: session.fromPartition('persist:ja-' + a.id),
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: false,
            devTools: false
          }
        })
  if (!win.native) win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    const validate = (user) => {
      if (!library.saveProfile(a.id, user)) throw Error('当前身份与绑定账号不符')
    }
    const { user, page } = await studioPlatforms[a.platform].readPublished(
      win,
      a,
      cursor,
      itemId,
      validate
    )
    store.db.prepare('INSERT OR IGNORE INTO creator_logins(accountId) VALUES(?)').run(a.id)
    if (queueOnly) return page
    if (a.platform === 'xhs' && !itemId && String(cursor) === '0') {
      const audience = await xhs.readAudience(win, user.uid).catch(() => null)
      if (audience) store.atomic(() => {
        if (!library.saveProfile(a.id, { ...user, followers: audience.followers })) throw Error('账号身份已改变')
        const write = store.db.prepare('INSERT OR REPLACE INTO follower_daily VALUES(?,?,?)')
        for (const row of audience.daily) write.run(a.id, row.day, row.change)
      })
    }
    const items = itemId ? page.items.filter((w) => w.itemId === itemId) : page.items
    const rows = library.writeItems(a.id, items)
    await picture(store.db, 'avatar:' + a.id, user.avatarUrl, 96, main.webContents)
    for (let i = 0; i < items.length; i += 5)
      await Promise.all(
        items
          .slice(i, i + 5)
          .map((w) =>
            picture(store.db, 'cover:' + a.id + ':' + w.itemId, w.coverUrl, 480, main.webContents)
          )
      )
    changed()
    return itemId ? rows.find((w) => w.itemId === itemId) : { count: items.length, next: page.next }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
async function syncWorks(id, cursor = '0', queueOnly = false) {
  const account = store.account(id)
  if (studioPlatforms[account.platform]) return readCreatorWorks(account, cursor, null, queueOnly)
  return withCreator(account, async (client) => {
    const user = await client.who()
    library.identify(id, user)
    const page = await client.recent(user.uid, cursor)
    if (queueOnly) return { items: page.items, next: page.more && page.cursor && page.cursor !== cursor ? page.cursor : null }
    library.writeItems(id, page.items, user.uid)
    await picture(store.db, 'avatar:' + id, user.avatarUrl, 96, main.webContents)
    for (let i = 0; i < page.items.length; i += 5)
      await Promise.all(
        page.items
          .slice(i, i + 5)
          .map((w) =>
            picture(store.db, 'cover:' + id + ':' + w.itemId, w.coverUrl, 480, main.webContents)
          )
      )
    changed()
    return {
      count: page.items.length,
      next: page.more && page.cursor && page.cursor !== cursor ? page.cursor : null
    }
  })
}
async function ownedDetail(account, itemId) {
  return withCreator(account, async (client) => {
    const user = await client.who()
    library.identify(account.id, user)
    const known = store.db
      .prepare('SELECT id FROM native_works WHERE accountId=? AND itemId=? AND status<>?')
      .get(account.id, itemId, '本人登记')
    if (!known) {
      const page = await client.recent(user.uid)
      if (!page.items.some((x) => x.itemId === itemId))
        throw Error('当前账号的最新作品里没有这个 ID。请先在作品页加载对应作品，再关联回执。')
      library.writeItems(account.id, page.items, user.uid)
    }
    const detail = await client.detail(user.uid, itemId)
    return library.writeItems(account.id, [detail], user.uid).find((w) => w.itemId === itemId)
  })
}
async function verifyJob(id, raw) {
  const job = store.job(id),
    a = store.account(job.accountId)
  const item = String(raw).trim()
  const patterns = {
    xhs: /^[a-f0-9]{24}$/i,
    kuaishou: /^[a-z0-9_-]{1,80}$/i,
    channels: /^[\w+/=-]{1,256}$/,
    bilibili: /^(?:BV[0-9A-Za-z]+|cv[1-9]\d*)$/
  }
  const itemId =
    a.platform === 'wechat'
      ? receiptUrl(a, item)
      : (patterns[a.platform] || /^[1-9]\d*$/).test(item)
        ? item
        : canonicalId(a.platform, receiptUrl(a, item))
  const work = studioPlatforms[a.platform]
    ? await readCreatorWorks(a, '0', itemId)
    : await ownedDetail(a, itemId)
  if (!work) throw Error('未取得目标账号的对应作品')
  if (
    a.platform === 'tiktok' &&
    (!job.videoId || new URL(work.url).pathname.split('/')[2] !== 'video')
  )
    throw Error('此回执并非本次视频稿件')
  if (
    a.platform === 'bilibili' &&
    Boolean(job.videoId) !== new URL(work.url).pathname.startsWith('/video/')
  )
    throw Error('B站回执类型与本次稿件不符')
  library.link(id, work.id)
  changed()
  return work
}
async function refreshWork(w) {
  if (
    studioPlatforms[w.platform] &&
    store.db.prepare('SELECT 1 FROM creator_logins WHERE accountId=?').get(w.accountId)
  )
    return readCreatorWorks(store.account(w.accountId), '0', w.itemId)
  if (w.platform === 'douyin') return ownedDetail(store.account(w.accountId), w.itemId)
  if (w.platform === 'channels') {
    const before = w.seen
    await syncWorks(w.accountId)
    const now = library.works(w.accountId).find((x) => x.id === w.id)
    if (now?.seen === before) throw Error('当前官方作品页未返回这条作品，本地保留上次采样')
    return now
  }
  if (['bilibili', 'tiktok', 'xhs', 'kuaishou'].includes(w.platform))
    return lookupWork(w.accountId, w.url)
  throw Error('该平台可在绑定账号的官方后台查看详细指标')
}
async function lookupWork(accountId, raw) {
  const a = store.account(accountId),
    url = receiptUrl(a, raw)
  if (a.archived) throw Error('账号已移除')
  let item
  if (a.platform === 'douyin') return ownedDetail(a, canonicalId(a.platform, url))
  if (a.platform === 'wechat') return readCreatorWorks(a, '0', url)
  if (
    (a.platform === 'tiktok' && new URL(url).pathname.includes('/photo/')) ||
    (a.platform === 'bilibili' && new URL(url).pathname.startsWith('/read/'))
  )
    return readCreatorWorks(a, '0', canonicalId(a.platform, url))
  if (a.platform === 'bilibili') item = await bilibili(a, url)
  else if (['tiktok', 'xhs', 'kuaishou'].includes(a.platform)) {
    const w = new BrowserWindow({
      icon: brand.icon,
      show: false,
      webPreferences: {
        session: session.fromPartition('persist:ja-' + a.id),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: false
      }
    })
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const local = (link) => allowedPage(a.platform, link)
    w.webContents.on('will-redirect', (e, u) => {
      if (!local(u)) e.preventDefault()
    })
    let timer
    try {
      await Promise.race([
        w.loadURL(url),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('官方作品页加载超时')), 18000)
        })
      ])
      if (!local(w.webContents.getURL())) throw Error('作品页已离开对应平台')
      const itemId = canonicalId(a.platform, url)
      let payload
      for (let i = 0; i < 6 && !payload; i++) {
        payload = await w.webContents.executeJavaScript(
          '(' +
            fromPage.toString() +
            ')(' +
            JSON.stringify(a.platform) +
            ',' +
            JSON.stringify(itemId) +
            ')'
        )
        if (!payload) await new Promise((r) => setTimeout(r, 250))
      }
      item = checkPage(a, url, payload)
    } finally {
      clearTimeout(timer)
      if (!w.isDestroyed()) w.destroy()
    }
  } else throw Error('此平台请导入带账号标识的作品报表，或打开官方后台')
  if (item.profile) await rememberProfile(a.id, item.profile)
  const cover = typeof item.coverUrl === 'string' ? item.coverUrl.replace(/^http:/, 'https:') : ''
  await picture(store.db, 'cover:' + a.id + ':' + item.itemId, cover, 192, main.webContents)
  return library.writeItems(a.id, [item]).find((w) => w.itemId === item.itemId)
}
async function registerReceipt(id, raw) {
  const job = store.job(id),
    a = store.account(job.accountId)
  const signed = store.db.prepare('SELECT 1 FROM creator_logins WHERE accountId=?').get(a.id)
  if (
    a.platform === 'douyin' ||
    (signed && ['xhs', 'kuaishou', 'tiktok', 'wechat'].includes(a.platform))
  )
    return verifyJob(id, raw)
  const url = receiptUrl(a, raw)
  if (a.platform === 'channels' && signed && new URL(url).hostname === 'channels.weixin.qq.com')
    return verifyJob(id, url)
  if (a.platform === 'bilibili' && !new URL(url).pathname.includes('/av') && signed)
    return verifyJob(id, url)
  if (a.platform === 'bilibili' && new URL(url).pathname.startsWith('/video/')) {
    const work = await lookupWork(a.id, url)
    library.link(id, work.id)
    changed()
    return work
  }
  return store.atomic(() => {
    store.record(id, url)
    const work = library.upsert(a, {
      itemId: canonicalId(a.platform, url),
      title: job.title || job.body,
      url,
      status: '本人登记'
    })
    store.db
      .prepare(
        "UPDATE native_works SET jobId=?,linkSource='本人登记' WHERE id=? AND (jobId IS NULL OR jobId=?)"
      )
      .run(id, work, id)
    if (store.db.prepare('SELECT jobId FROM native_works WHERE id=?').get(work).jobId !== id)
      throw Error('作品已关联其他任务')
  })
}
async function pickDirectory(title) {
  const p = await dialog.showOpenDialog(main, { title, properties: ['openDirectory'] })
  return p.canceled ? null : p.filePaths[0]
}
async function importHistory(kind) {
  let data, file
  if (kind === 'creator') {
    const p = await dialog.showOpenDialog(main, {
      title: '选择要迁入的账号快照数据库',
      properties: ['openFile'],
      filters: [{ name: 'SQLite', extensions: ['db', 'sqlite'] }]
    })
    if (p.canceled) return null
    file = p.filePaths[0]
    data = readCreator(file)
  } else if (kind === 'review') {
    const root = await pickDirectory('选择含 accounts.json 的参考归档目录')
    if (!root) return null
    file = root
    data = readReview(root)
  } else throw Error('导入格式无效')
  const key =
    kind + '-' + createHash('sha256').update(fs.realpathSync(file).toLowerCase()).digest('hex')
  const old = JSON.parse(
    store.db.prepare('SELECT data FROM legacy_imports WHERE source=?').get(key)?.data || 'null'
  )
  const combine = (left, right, keyOf) => [
    ...new Map([...left, ...right].map((row) => [keyOf(row), row])).values()
  ]
  let merged
  if (kind === 'review') merged = combine(old || [], data, (x) => x.sourceAccountId)
  else {
    const accountKey = (x) => JSON.stringify([x.platform, x.sourceAccountId])
    const accounts = combine(old?.accounts || [], data.accounts, accountKey).map((x) => {
      const found = old?.accounts.find((a) => accountKey(a) === accountKey(x))
      const history = combine(found?.history || [], x.history, (h) => h.date).sort((a, b) =>
        b.date.localeCompare(a.date)
      )
      return { ...(found?.time > x.time ? found : x), history }
    })
    const works = combine(old?.works || [], data.works, (x) =>
      JSON.stringify([x.platform, x.sourceAccountId, x.sourceItemId])
    )
    merged = { accounts, works, snapshots: accounts.reduce((n, a) => n + a.history.length, 0) }
  }
  const preview =
    kind === 'review'
      ? '参考账号 ' + data.length + ' 个'
      : '账号 ' + data.accounts.length + ' 个，作品 ' + data.works.length + ' 条'
  const decision = await dialog.showMessageBox(main, {
    type: 'question',
    message: '导入 ' + path.basename(file) + '？',
    detail: preview + '。已有条目按来源标识合并。',
    buttons: ['取消', '导入'],
    defaultId: 0,
    cancelId: 0
  })
  if (decision.response !== 1) return null
  store.db
    .prepare('INSERT OR REPLACE INTO legacy_imports VALUES(?,?)')
    .run(key, JSON.stringify(merged))
  return true
}
function localInsights() {
  library.backfill()
  const reports = { accounts: [], works: [], platforms: [] },
    legacy = {}
  for (const row of store.db.prepare('SELECT * FROM reports ORDER BY rowid DESC').all())
    reports[row.kind].push(JSON.parse(row.data))
  for (const row of store.db.prepare('SELECT source,data FROM legacy_imports').all()) {
    const data = JSON.parse(row.data)
    if (row.source.startsWith('creator')) {
      legacy.creator ??= { accounts: [], works: [], snapshots: 0 }
      legacy.creator.accounts.push(...data.accounts)
      legacy.creator.works.push(...data.works)
      legacy.creator.snapshots += data.snapshots
    } else if (row.source.startsWith('review')) {
      legacy.review ??= []
      legacy.review.push(...data)
    }
  }
  return {
    native: library.works(),
    growth: require('./growth.cjs').readGrowth(store.db),
    creator: legacy.creator || { accounts: [], works: [], snapshots: 0 },
    review: legacy.review || [],
    reports,
    errors: {}
  }
}
async function transfer(win, account, job, files) {
  if (store.job(job.id).status !== 'waiting') throw Error('任务已结束')
  const check = win.native
    ? {
        response: (await win.send(
          'confirm',
          '确认使用「' + account.name + '」选入本次视频？视频号可能立即开始上传。'
        ))
          ? 1
          : 0
      }
    : await dialog.showMessageBox(win, {
        type: 'question',
        message: '当前网页登录的是 ' + account.name + '（' + account.identity + '）吗？',
        detail: '确认后，官方投稿页可能立即开始上传这 ' + files.length + ' 个文件。',
        buttons: ['取消', '账号正确，选入素材'],
        defaultId: 0,
        cancelId: 0
      })
  if (check.response !== 1) return
  if (store.job(job.id).status !== 'waiting') throw Error('任务已结束')
  const user = account.platform === 'douyin' ? await whoBound(win, account) : null
  if (studioPlatforms[account.platform])
    await verifyCreator(account, studioPlatforms[account.platform].client(win.webContents))
  const message = await attachMedia(win, account, job, files)
  if (user) await armReceipt(win.webContents, user.uid)
  await notify(win, message)
}
function copyImage(jobId, assetId) {
  if (!JSON.parse(store.job(jobId).assets).includes(assetId)) throw Error('配图不属于此任务')
  const img = nativeImage.createFromBuffer(Buffer.from(store.asset(assetId, true).bytes))
  if (img.isEmpty()) throw Error('图片无法解码')
  clipboard.writeImage(img)
}
async function fill(id) {
  const job = store.job(id)
  if (job.status !== 'waiting') throw Error('任务已关闭')
  const account = store.account(job.accountId)
  const win = remoteWindows.get(id)
  if (!win || win.isDestroyed() || !allowedPage(account.platform, win.webContents.getURL()))
    throw Error('请先打开目标平台的官方编辑器')
  const args = JSON.stringify({
    account: { platform: account.platform, identity: account.identity },
    job: { title: job.title, body: job.body }
  })
  const message = await win.webContents.executeJavaScript(
    '(' + prepareEditor.toString() + ')(' + args + ')',
    true
  )
  await notify(win, String(message))
}
async function tick() {
  if (!store) return
  const hasWork = store.db
    .prepare("SELECT 1 FROM jobs WHERE status='queued' AND due<=? LIMIT 1")
    .get(Date.now())
  if (!hasWork) return
  const work = runDue(
    store,
    async (account) => {
      const encrypted = store.secret(account.id)
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))
      const keys = JSON.parse(decrypted.result)
      return xClient(keys)
    },
    Date.now()
  )
  changed()
  await work
  changed()
}
function invoke(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (
      event.sender !== main.webContents ||
      event.senderFrame !== main.webContents.mainFrame ||
      event.senderFrame.url !== homeUrl
    )
      throw Error('请求来源无效')
    try {
      return { ok: true, value: await fn(...args) }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  })
}
function register() {
  invoke('update-info', () => updates.info())
  invoke('update-check', () => updates.check(true))
  invoke('update-auto', enabled => updates.automatic(enabled))
  invoke('update-skip', () => updates.skip())
  invoke('update-open', async kind => { await shell.openExternal(updates.target(kind)); return true })
  const sources=new (require('./sources.cjs').Sources)(store,videoRoot(),nativeImage)
  protocol.handle('studio-media',req=>require('./preview-media.cjs').previewMedia(store,videoRoot(),req))
  invoke('source-list',kind=>sources.list(kind))
  const postvelaPackages = new Map()
  invoke('postvela-open',async key=>{
    const pack=await sources.openPostvela(key)
    const pages=[]
    const images=importFiles(store,pack.pages.map(p=>p.image),nativeImage)
    for(const [i,p] of pack.pages.entries()) {
      let preview=''
      if(p.kind==='live') preview=(await importVideos(store,videoRoot(),[p.preview]))[0]
      if(p.kind==='gif') {
        if((await fs.promises.stat(p.preview)).size>20*1024*1024)throw Error('GIF 文件超过 20 MB')
        const bytes=await fs.promises.readFile(p.preview)
        if(bytes.length>20*1024*1024 || !/^GIF8[79]a/.test(bytes.toString('ascii',0,6)))throw Error('GIF 文件无效或超过 20 MB')
        preview='data:image/gif;base64,'+bytes.toString('base64')
      }
      pages.push({number:p.number,kind:p.kind,image:images[i],preview})
    }
    const id=randomUUID()
    postvelaPackages.clear()
    postvelaPackages.set(id,pack)
    return {id,key:pack.key,draftId:pack.draftId,title:pack.title,body:pack.body,folder:pack.folder,pages}
  })
  invoke('postvela-action',async(id,action)=>{
    const pack=postvelaPackages.get(id)
    if(!pack)throw Error('请重新打开图集')
    if(action==='folder') {
      const error=await require('electron').shell.openPath(pack.folder)
      if(error)throw Error(error)
    } else if(['title','body'].includes(action)) clipboard.writeText(pack[action])
    else throw Error('无效的图集操作')
  })
  invoke('postvela-draft',(key,fresh)=>sources.postvelaDraft(key,fresh===true))
  invoke('source-bind',async kind=>{
    const titles={local:'指定图文制作目录',vault:'指定 Obsidian 仓库或主稿目录',video:'绑定视频目录',postvela:'指定含 PostVela 导出的图文制作目录'}
    if(!Object.hasOwn(titles,kind))throw Error('无效的来源')
    const p=await pickDirectory(titles[kind])
    if(p)sources.bind(kind,p)
    return Boolean(p)
  })
  invoke('source-load',(kind,key,fresh)=>sources.load(kind,key,fresh===true))
  invoke('frame-cover',async raw=>{
    if(typeof raw!=='string'||raw.length>8*1024*1024||!/^data:image\/jpeg;base64,/.test(raw))throw Error('封面格式无效')
    const folder=await fs.promises.mkdtemp(path.join(require('node:os').tmpdir(),'jastudio-cover-'))
    try{
      const file=path.join(folder,'视频封面.jpg')
      await fs.promises.writeFile(file,Buffer.from(raw.slice(raw.indexOf(',')+1),'base64'))
      return importFiles(store,[file],nativeImage)[0]
    }finally{await fs.promises.rm(folder,{recursive:true,force:true})}
  })
  invoke('author-assist', input=>require('./author-assist.cjs').generate(store,input))
  invoke('cover-art', input => require('./cover-art.cjs').generateArt(store, input,
    file => importFiles(store,[file],nativeImage)[0]))
  invoke('account-tab', (id, rect) => {
    if (!id) return accountTabs.hide()
    try {
      const account = store.account(id)
      if (account.archived) throw Error('账号已移除')
      accountTabs.display(account, rect)
    } catch (e) {
      accountTabs.hide()
      throw e
    }
  })
  invoke('account-tab-action', (id, cmd) => accountTabs.action(id, cmd))
  invoke('insights', () => localInsights())
  invoke('new-douyin', () => newDouyin())
  invoke('new-creator', (platform) => connectCreator(platform))
  invoke('lookup-work', lookupWork)
  invoke('work-report', async (id) => {
    const account = store.account(id)
    if (account.platform === 'douyin') throw Error('抖音请使用本人作品同步')
    const picked = await dialog.showOpenDialog(main, {
      title: '导入此账号的作品指标',
      properties: ['openFile'],
      filters: [{ name: '带账号标识和作品链接的报表', extensions: ['csv'] }]
    })
    if (picked.canceled) return null
    const file = picked.filePaths[0]
    if (fs.statSync(file).size > 32 * 1024 * 1024) throw Error('报表过大')
    const rows = reportItems(account, fs.readFileSync(file))
    library.writeItems(id, rows)
    return rows.length
  })
  invoke('sync-works', (id, cursor) => syncWorks(id, cursor))
  invoke('await-receipt', id => {
    const job=store.job(id)
    if(store.account(job.accountId).mode!=='web')throw Error('此任务不需要手动发表')
    if(job.status==='published'||job.status==='recorded'||job.status==='uncertain')return
    store.transition(id,['waiting'],'uncertain','本人已在平台手动发表，等待官方回执')
    changed()
  })
  invoke('reconcile-queue', force => queueReconciler.check(force === true))
  invoke('undo-manual', id => { library.undoManualMark(id); changed() })
  invoke('sync-job-work', (jobId, remoteItem) => verifyJob(jobId, remoteItem))
  invoke('work-history', (id) => library.samples(id))
  invoke('creative-notes', (id) => library.notes(id))
  invoke('creative-save-notes', (id, idea, refs) => library.saveNotes(id, idea, refs))
  invoke('creative-variant', (id, kind) => library.variant(id, kind))
  invoke('versions', (id) => library.versions(id))
  invoke('version-save', (id) => library.version(id))
  invoke('version-restore', (id, revision, expected) => library.restore(id, revision, expected))
  invoke('work-refresh', async (id) => {
    const w = library.works().find((w) => w.id === id)
    if (!w) throw Error('作品不存在')
    return refreshWork(w)
  })
  invoke('history-import', (kind) => importHistory(kind))
  invoke('project-import', async () => {
    const root = await pickDirectory('选择包含项目的作品目录')
    if (!root) return null
    importRoot = root
    return easel.projects(root)
  })
  invoke('easel-import', (key, item) => {
    if (!importRoot) throw Error('请先选择作品目录')
    return easel.importProject(store, importRoot, key, item, {
      images: (files) => importFiles(store, files, nativeImage),
      videos: (files) => importVideos(store, videoRoot(), files)
    })
  })
  invoke('easel-export', async (id) => {
    const root = await pickDirectory('选择作品导出目录')
    if (root) return easel.exportProject(store, root, id, videoRoot())
    return null
  })
  invoke('report-import', async () => {
    const p = await dialog.showOpenDialog(main, {
      properties: ['openFile'],
      filters: [{ name: '易媒数据报表', extensions: ['csv'] }]
    })
    if (p.canceled) return null
    if (fs.statSync(p.filePaths[0]).size > 32 * 1024 * 1024) throw Error('CSV 文件超过 32 MB')
    return importReport(store, fs.readFileSync(p.filePaths[0]))
  })
  invoke('pick-videos', async () => {
    const p = await dialog.showOpenDialog(main, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频', extensions: ['mp4', 'm4v', 'mov', 'webm'] }]
    })
    return p.canceled ? [] : importVideos(store, videoRoot(), p.filePaths)
  })
  invoke('drop-videos', (files) => importVideos(store, videoRoot(), files))
  invoke('video-path', async (id) => clipboard.writeText(await videoPath(store, videoRoot(), id)))
  invoke('snapshot', () => ({
    ...store.snapshot(),
    performance: performance(store),
    sessions: library.profiles(),
    candidates: library.candidates(),
    manualMarks: library.manualMarks(),
    videoProgress: Object.fromEntries(videoProgress),
    lastVideoSync: Object.fromEntries(store.db.prepare(
      "SELECT h.jobId,h.message FROM video_handoffs h JOIN jobs j ON j.id=h.jobId WHERE j.status='waiting'"
    ).all().map(row => [row.jobId,row.message]))
  }))
  invoke('account-meta', (id, name, group) => store.describe(id, name, group))
  invoke('save', (raw) => store.save(raw))
  invoke('count', (text) => require('twitter-text').parseTweet(String(text)).weightedLength)
  invoke('add-account', async (raw) => {
    const account = accountInput(raw)
    if (account.mode === 'creatorhub') throw Error('请选择发条 Fatio 的网页发布方式')
    if (account.mode === 'web') return store.addAccount(raw)
    const keys = credentials(raw.keys)
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw Error('Windows 凭据加密不可用')
    let me
    try {
      me = await xClient(keys).me(true)
    } catch {
      throw Error('无法验证 X 凭据，请检查网络和应用权限。')
    }
    if (!identityOk(me, account)) throw Error('X 凭据所属账号与填写的 @用户名不符')
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(keys))
    const a = store.addAccount(raw, encrypted.toString('base64'), me.id)
    await rememberProfile(a.id, {
      uid: me.id,
      handle: me.username,
      name: me.name,
      avatarUrl: me.profile_image_url,
      followers: me.public_metrics?.followers_count
    })
    return a
  })
  invoke('archive', async (id) => {
    store.archive(id)
    accountTabs.close(id)
    const profile = session.fromPartition('persist:ja-' + id)
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed() && win.webContents.session === profile) win.destroy()
    try {
      if (
        store.account(id).platform === 'channels' &&
        fs.existsSync(path.join(app.getPath('userData'), 'ChannelsWebView', id))
      ) {
        await closeChannels(id)
        const cleaner = new ChannelsWindow(main, id, 'hidden', '清理视频号会话')
        try {
          await cleaner.send('clear')
        } finally {
          cleaner.destroy()
          await cleaner.exit
        }
      }
      await profile.clearData()
    } catch {
      changed()
      throw Error('本机会话清理未完成，请在账号页重试清理。')
    }
    store.finishArchive(id)
  })
  invoke('login', (id) => {
    const a = store.account(id)
    if (a.archived) throw Error('账号已移除')
    remote(a)
  })
  invoke('queue', (id, revision, due, prepare) => {
    const ids = store.queue(id, revision, due)
    void tick().catch(() => changed())
    if (prepare === true && due === null) startVideoBatch(ids)
    return ids
  })
  invoke('open-job', (id, prepare) => {
    const j = store.job(id)
    if (j.status !== 'waiting') throw Error('此任务当前不能打开编辑器')
    remote(store.account(j.accountId), j, {prepare: prepare === true && !!j.videoId})
  })
  invoke('video-materials', id => openMaterials(store.job(id)))
  invoke('apply-pending-covers', (draftId,revision,clip) => {
    const result = store.applyPendingCovers(draftId,revision,clip,id =>
      remoteWindows.has(id) || batchWaiting.has(id) || store.db.prepare(
        'SELECT 1 FROM native_submits WHERE jobId=? UNION ALL SELECT 1 FROM receipt_candidates WHERE jobId=? UNION ALL SELECT 1 FROM native_works WHERE jobId=?'
      ).get(id,id,id))
    changed()
    return result
  })
  invoke('copy-video-copy', id => clipboard.writeText(draftCopy(store.job(id))))
  invoke('record', (id, url) => registerReceipt(id, url))
  invoke('cancel', (id) => store.cancel(id))
  invoke('reschedule', (id, due) => {
    const job = store.reschedule(id, due)
    changed()
    return job
  })
  invoke('retry', (id) => {
    store.transition(id, ['failed'], 'queued')
    void tick().catch(() => changed())
  })
  invoke('resolve-missing', async (id) => {
    if (store.db.prepare('SELECT jobId FROM receipt_candidates WHERE jobId=?').get(id))
      throw Error('平台已返回作品 ID，请先核对回执，不能重新发送同一任务。')
    if (store.db.prepare('SELECT jobId FROM hub_attempts WHERE jobId=?').get(id))
      throw Error('旧版远端接单结果须先人工核对；该任务保留去重记录。')
    const attempt = store.db.prepare('SELECT * FROM native_submits WHERE jobId=?').get(id)
    if (attempt) {
      const accountId = store.job(id).accountId
      await syncWorks(accountId)
      if (
        library
          .works(accountId)
          .some((w) => !w.posted || w.posted * 1000 >= attempt.started - 60000)
      )
        throw Error('本人列表中还有可能对应本次提交的作品，请先逐条核对回执。')
    }
    store.transition(id, ['uncertain'], 'cancelled', '本人核对平台后关闭本次发送')
  })
  invoke('visit', async (id) => {
    const j = store.job(id)
    const url = receiptUrl(store.account(j.accountId), j.url)
    remote(store.account(j.accountId), null, { viewUrl: url })
  })
  invoke('copy', (id, field) => {
    const j = store.job(id)
    if (!['title', 'body'].includes(field)) throw Error('复制字段无效')
    clipboard.writeText(j[field])
  })
  invoke('copy-image', copyImage)
  invoke('pick-images', async () => {
    const picked = await dialog.showOpenDialog(main, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '配图', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    return picked.canceled ? [] : importFiles(store, picked.filePaths, nativeImage)
  })
  invoke('import', async () => {
    const picked = await dialog.showOpenDialog(main, {
      properties: ['openFile'],
      filters: [{ name: '稿件', extensions: ['txt', 'md'] }]
    })
    if (picked.canceled) return null
    const p = picked.filePaths[0]
    if (fs.statSync(p).size > 600000) throw Error('稿件文件过大')
    const raw = require('./sources.cjs').visibleMarkdown(fs
      .readFileSync(p, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n'))
    if(path.basename(p)==='发布文案.txt' && fs.readdirSync(path.dirname(p)).some(n=>/^page-\d+\.(pvt|gif)$/i.test(n)))
      throw Error('这份 PostVela 图集含动态页，请从稿件库的「PostVela 图集」打开，避免只导入静态备用图。')
    const first = raw.indexOf('\n')
    const heading = raw.startsWith('# ') || path.basename(p) === '发布文案.txt'
    const pages =
      path.basename(p) === '发布文案.txt'
        ? fs
            .readdirSync(path.dirname(p))
            .filter((n) => /^page-\d+\.png$/i.test(n))
            .sort()
            .map((n) => path.join(path.dirname(p), n))
        : []
    const result = {
      title: heading
        ? (first < 0 ? raw : raw.slice(0, first)).replace(/^# /, '').trim()
        : path.parse(p).name,
      body: heading ? (first < 0 ? '' : raw.slice(first + 1)).trimStart() : raw
    }
    if (result.title.length > 300 || result.body.length > 150000)
      throw Error('导入稿件超过标题或正文长度上限')
    return { ...result, assets: importFiles(store, pages, nativeImage) }
  })
  invoke('nas-export-status', () => nasExport.status(store.db))
  invoke('nas-export-bind', async () => {
    const p = await pickDirectory('选择指标快照导出目录（建议 NAS 上仓库之外的文件夹）')
    if (!p) return null
    nasExport.setSetting(store.db, 'dir', p)
    nasExport.setSetting(store.db, 'signature', null)
    return runNasExport(true)
  })
  invoke('nas-export-run', () => runNasExport(true))
  invoke('auto-sample-status', () => autoSample.status(store.db))
  invoke('auto-sample-toggle', (on) => {
    autoSample.setEnabled(store.db, on === true)
    return autoSample.status(store.db)
  })
  invoke('closed', () => {
    closing = true
    runNasExport()
    main.close()
  })
}
function start() {
  app.setAppUserModelId(brand.appId)
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  store = new Store(path.join(app.getPath('userData'), 'studio.sqlite'))
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS pending_logins(platform TEXT NOT NULL,expected TEXT NOT NULL,id TEXT UNIQUE NOT NULL,PRIMARY KEY(platform,expected))'
  )
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS creator_logins(accountId TEXT PRIMARY KEY REFERENCES accounts(id))'
  )
  library = new Library(store)
  queueReconciler = new QueueReconciler(store, library, (account, cursor) => syncWorks(account.id, cursor, true), changed)
  main = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 390,
    minHeight: 530,
    backgroundColor: '#262624',
    title: brand.name,
    icon: brand.icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  Menu.setApplicationMenu(null)
  updates = new UpdateService({ directory: app.getPath('userData'), currentVersion: app.getVersion(),
    fetcher: (...args) => net.fetch(...args),
    notify: info => { if (main && !main.isDestroyed()) main.webContents.send('update-changed', info) } })
  accountTabs = new AccountTabs(main, async (a, wc) => {
    if (studioPlatforms[a.platform]) {
      if (!wc.getURL().startsWith(studioPlatforms[a.platform].origin + '/')) return
      const user = await studioPlatforms[a.platform].client(wc).self()
      if (!library.saveProfile(a.id, user))
        return '账号不符，请切回已绑定的' + platforms[a.platform].label + '账号'
      await picture(store.db, 'avatar:' + a.id, user.avatarUrl, 96, main.webContents)
      changed()
      return '已核对 · ' + user.name
    }
    if (a.platform !== 'douyin' || !wc.getURL().startsWith(ORIGIN + '/')) return
    const user = await clientFor(wc).who()
    const old = library.binding(a.id)
    if (old && old.uid !== user.uid) return '账号不符，请切回已绑定的抖音账号'
    if (!old && ![user.uid, user.secUid, user.handle].includes(a.identity))
      return '账号不符，请核对抖音号'
    library.identify(a.id, user)
    await picture(store.db, 'avatar:' + a.id, user.avatarUrl, 96, main.webContents)
    changed()
    return '已核对 · ' + (user.name || user.handle)
  })
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  main.webContents.on('will-navigate', (event) => event.preventDefault())
  main.on('close', (event) => {
    if (
      !closing &&
      !main.webContents.isDestroyed() &&
      main.webContents.getURL() === homeUrl &&
      !main.webContents.isCrashed()
    ) {
      event.preventDefault()
      main.webContents.send('flush-close')
    }
  })
  register()
  main.loadFile(index).then(() => {
    const expected = process.argv
      .find((arg) => arg.startsWith('--connect-douyin='))
      ?.slice('--connect-douyin='.length)
    if (expected) newDouyin(expected)
    requestedLogin(process.argv)
    if (!process.argv.some((arg) => arg.startsWith('--sync-account='))) {
      const account = store.db
        .prepare(
          "SELECT a.id FROM accounts a JOIN native_sessions s ON s.accountId=a.id LEFT JOIN pictures p ON p.id='avatar:'||a.id LEFT JOIN avatar_attempts t ON t.accountId=a.id WHERE a.archived=0 AND p.id IS NULL AND COALESCE(t.time,0)<? ORDER BY s.checked DESC LIMIT 1"
        )
        .get(Date.now() - 12 * 3600000)
      if (account) {
        const { id } = account
        store.db.prepare('INSERT OR REPLACE INTO avatar_attempts VALUES(?,?)').run(id, Date.now())
        void withCreator(store.account(id), async (client) => {
          const user = await client.who()
          library.identify(id, user)
          await picture(store.db, 'avatar:' + id, user.avatarUrl, 96, main.webContents)
          changed()
        }).catch(() => {})
      }
    }
    void requestedAccount(process.argv).catch((e) => notify(main, e.message))
  })
  timer = setInterval(() => tick().catch(() => changed()), 2500)
  void tick().catch(() => changed())
  const checkReceipts = () => { if (!closing) void queueReconciler.check().catch(() => {}) }
  receiptTimer = setInterval(checkReceipts, 90000)
  main.webContents.once('did-finish-load', checkReceipts)
  if (!process.env.FATIO_TEST_DATA && !process.env.JASTUDIO_TEST_DATA) {
    const checkUpdates = () => { if (!closing) void updates.check().catch(() => {}) }
    main.webContents.once('did-finish-load', checkUpdates)
    updateTimer = setInterval(checkUpdates, 60 * 60000)
    updateTimer.unref()
  }
  exportTimer = setInterval(() => { if (!closing) runNasExport() }, 10 * 60000)
  setTimeout(() => { if (!closing) runNasExport() }, 60000)
  sampleTimer = setInterval(() => void runAutoSample(), 5 * 60000)
  setTimeout(() => void runAutoSample(), 2 * 60000)
}
app.on('window-all-closed', () => {
  clearInterval(timer)
  clearInterval(receiptTimer)
  clearInterval(exportTimer)
  clearInterval(sampleTimer)
  clearInterval(updateTimer)
  updates?.cancel()
  app.quit()
})
