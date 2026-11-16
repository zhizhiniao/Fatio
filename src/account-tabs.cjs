const { WebContentsView, session, screen } = require('electron')
const { ChannelsWindow } = require('./channels-window.cjs')
const { platforms } = require('./platforms.cjs')
const { installAccountNavigation } = require('./account-navigation.cjs')

// Only the trusted local renderer can position a tab. Remote pages have no preload or IPC.
class AccountTabs {
  constructor(main, identify) {
    this.main = main
    this.identify = identify
    this.views = new Map()
    this.active = null
    main.on('focus', () => this.active?.checkIdentity?.())
    const poll = setInterval(() => this.active?.checkIdentity?.(), 30000)
    main.once('closed', () => {
      clearInterval(poll)
      for (const v of this.views.values()) v.native ? v.destroy() : v.webContents.close()
      this.views.clear()
    })
  }
  hide() {
    if (this.active?.native) void this.active.send('hide').catch(() => {})
    else if (this.active) this.main.contentView.removeChildView(this.active)
    this.active = null
  }
  close(id) {
    const v = this.views.get(id)
    if (!v) return
    if (v === this.active) this.hide()
    this.views.delete(id)
    if (v.native) v.destroy()
    else v.webContents.close()
  }
  display(account, rect) {
    const [width, height] = this.main.getContentSize()
    const { x, y, w, h } = rect || {}
    if (
      ![x, y, w, h].every(Number.isInteger) ||
      w <= 0 ||
      h <= 0 ||
      x < 0 ||
      y < 0 ||
      x + w > width + 1 ||
      y + h > height + 1
    ) {
      this.hide()
      return
    }
    let v = this.views.get(account.id)
    if (account.platform === 'channels') {
      if (!v) {
        v = new ChannelsWindow(this.main, account.id, 'embed', '发条 Fatio · ' + account.name)
        const tab = v
        v.checkIdentity = async () => {
          let status
          try {
            status = await this.identify(account, tab.webContents)
          } catch {
            status = '请在视频号助手核对登录'
          }
          if (this.active === tab && !this.main.isDestroyed())
            this.main.webContents.send('account-tab-identity', account.id, status || '待核对身份')
        }
        v.on('did-finish-load', v.checkIdentity)
        this.views.set(account.id, v)
        void v.loadURL(platforms.channels.home).catch(() => {
          if (this.active === tab && !this.main.isDestroyed())
            this.main.webContents.send('account-tab-error', account.id, '后台加载失败')
        })
      }
      if (this.active !== v) {
        this.hide()
        this.active = v
        void v.checkIdentity()
      }
      const scale = screen.getDisplayMatching(this.main.getBounds()).scaleFactor
      void v
        .send('bounds', {
          x: Math.round(x * scale),
          y: Math.round(y * scale),
          width: Math.round(w * scale),
          height: Math.round(h * scale)
        })
        .catch(() => {})
      return
    }
    if (!v) {
      const profile = session.fromPartition('persist:ja-' + account.id)
      profile.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
      profile.setPermissionCheckHandler(() => false)
      v = new WebContentsView({
        webPreferences: {
          session: profile,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false
        }
      })
      const wc = v.webContents
      installAccountNavigation(wc, account.platform, this.main, () => this.active === v)
      let generation = 0,
        checkTimer
      const tell = (message) => {
        if (this.active === v && !wc.isDestroyed() && !this.main.isDestroyed())
          this.main.webContents.send('account-tab-identity', account.id, message)
      }
      v.checkIdentity = () => {
        const attempt = ++generation
        clearTimeout(checkTimer)
        if (this.active !== v) return
        tell('待核对后台身份')
        checkTimer = setTimeout(async () => {
          if (wc.isDestroyed() || this.active !== v) return
          let message
          try {
            message = await this.identify(account, wc)
          } catch {
            message = '身份未核对，请检查后台登录'
          }
          if (attempt === generation) tell(message || '请在后台核对当前账号')
        }, 160)
      }
      wc.on('did-start-navigation', (_e, _url, _inPlace, isMain) => {
        if (isMain) {
          ++generation
          clearTimeout(checkTimer)
          tell('待核对后台身份')
        }
      })
      wc.on('did-navigate-in-page', (_e, _url, isMain) => {
        if (isMain) v.checkIdentity()
      })
      wc.on('did-finish-load', v.checkIdentity)
      wc.once('destroyed', () => {
        ++generation
        clearTimeout(checkTimer)
      })
      wc.on('did-fail-load', (_e, code, _message, _url, top) => {
        if (top && code !== -3 && this.active === v && !this.main.isDestroyed())
          this.main.webContents.send('account-tab-error', account.id, code)
      })
      this.views.set(account.id, v)
      void wc.loadURL(platforms[account.platform].home).catch(() => {})
    }
    if (this.active !== v) {
      this.hide()
      this.main.contentView.addChildView(v)
      this.active = v
      v.checkIdentity()
    }
    v.setBounds({ x, y, width: w, height: h })
  }
  action(id, cmd) {
    const wc = this.views.get(id)?.webContents
    if (!wc) return
    if (wc.native) {
      if (cmd === 'close') this.close(id)
      else if (['back', 'forward', 'reload'].includes(cmd)) void wc.send(cmd).catch(() => {})
      return
    }
    if (cmd === 'reload') wc.reload()
    if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    if (cmd === 'close') this.close(id)
  }
}
module.exports = { AccountTabs }
