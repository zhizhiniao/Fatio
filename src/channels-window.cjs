const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')
const { app } = require('electron')
const hosts = new Set()
class ChannelsWindow extends EventEmitter {
  constructor(owner, id, mode, title) {
    super()
    if (!/^[\da-f-]{36}$/i.test(id)) throw Error('视频号分区无效')
    this.accountId = id
    this.mode = mode
    this.native = true
    this.webContents = this
    const binary = app.isPackaged
      ? path.join(process.resourcesPath, 'channels-host', 'FatioChannels.exe')
      : path.join(__dirname, '../.runtime/channels-host/FatioChannels.exe')
    const hwnd = owner.getNativeWindowHandle().readBigUInt64LE().toString()
    this.process = spawn(
      binary,
      [path.join(app.getPath('userData'), 'ChannelsWebView', id), mode, hwnd, title],
      { windowsHide: mode !== 'window', stdio: ['pipe', 'pipe', 'ignore'] }
    )
    this.pending = new Map()
    this.sequence = 0
    this.url = ''
    this.closed = false
    hosts.add(this)
    this.ready = new Promise((ok, fail) => {
      this.once('ready', ok)
      this.once('failed', fail)
    })
    this.ready.catch(() => {})
    this.exit = new Promise((ok) => this.once('closed', ok))
    this.debugger = new EventEmitter()
    this.debugger.isAttached = () => !!this.attached
    this.debugger.attach = () => {
      this.attached = true
    }
    this.debugger.detach = () => {
      this.attached = false
    }
    this.debugger.sendCommand = async (method, params = {}) => {
      if (method === 'Network.enable') {
        for (const event of [
          'Network.requestWillBeSent',
          'Network.responseReceived',
          'Network.loadingFinished'
        ])
          await this.send('subscribe', event)
      }
      return this.send('cdp', { method, params })
    }
    const lines = readline.createInterface({ input: this.process.stdout })
    lines.on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.evt === 'ready') this.emit('ready')
      else if (msg.evt === 'fatal') this.fail(Error('视频号窗口启动失败：' + msg.error))
      else if (msg.evt === 'location' || msg.evt === 'loaded') {
        this.url = msg.url
        if (msg.evt === 'loaded') this.emit('did-finish-load')
      } else if (msg.evt === 'cdp') this.debugger.emit('message', null, msg.method, msg.data)
      else if (msg.evt === 'action') this.emit('action', msg.label)
      else if (this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.fail(Error(msg.error))
        else p.ok(msg.result)
      }
    })
    this.process.on('error', (e) => this.fail(e))
    this.process.stdin.on('error', (e) => this.fail(e))
    this.process.on('close', () => {
      this.fail(Error('视频号窗口已关闭'))
      this.closed = true
      hosts.delete(this)
      this.emit('closed')
    })
  }
  fail(e) {
    this.emit('failed', e)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.fail(e)
    }
    this.pending.clear()
  }
  async send(op, arg) {
    await this.ready
    if (this.closed || !this.process.stdin.writable) throw Error('视频号窗口已关闭')
    const id = ++this.sequence
    return new Promise((ok, fail) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          fail(Error('视频号窗口操作超时'))
        },
        ['confirm', 'notice'].includes(op) ? 300000 : 35000
      )
      timer.unref()
      this.pending.set(id, { ok, fail, timer })
      this.process.stdin.write(JSON.stringify({ id, op, arg }) + '\n')
    })
  }
  loadURL(url) {
    return this.send('load', url)
  }
  getURL() {
    return this.url
  }
  isDestroyed() {
    return this.closed
  }
  async executeJavaScript(expression, userGesture = false) {
    const res = await this.debugger.sendCommand('Runtime.evaluate', {
      expression,
      userGesture,
      awaitPromise: true,
      returnByValue: true
    })
    if (res.exceptionDetails)
      throw Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
    return res.result.value
  }
  setTitle(title) {
    void this.send('title', title).catch(() => {})
  }
  show() {
    this.focus()
  }
  focus() {
    void this.send('focus').catch(() => {})
  }
  destroy() {
    if (!this.closed) this.process.stdin.end(JSON.stringify({ id: 0, op: 'close' }) + '\n')
  }
}
function closeChannels(id) {
  return Promise.all(
    [...hosts]
      .filter((w) => !id || w.accountId === id)
      .map((w) => {
        w.destroy()
        return w.exit
      })
  )
}
module.exports = { ChannelsWindow, closeChannels, channelWindows: () => [...hosts] }
