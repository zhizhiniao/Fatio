const { dialog, shell } = require('electron')
const { allowedPage, platforms } = require('./platforms.cjs')

function installAccountNavigation(contents, platform, owner, isActive = () => true) {
  function openExternalPage(raw) {
    if (!owner.isVisible() || !isActive() || !allowedPage(platform, contents.getURL())) return
    const url = URL.parse(raw)
    if (!url || url.protocol !== 'https:' || url.username || url.password ||
        !platforms[platform].externalOrigins?.includes(url.origin)) return

    void shell.openExternal(url.href).catch(() => {
      if (!owner.isDestroyed() && isActive()) {
        void dialog.showMessageBox(owner, {
          type: 'warning',
          message: '未能打开系统默认浏览器',
          detail: '请检查系统默认浏览器设置后再点击链接。',
          buttons: ['好']
        })
      }
    })
  }

  contents.on('will-navigate', event => {
    if (allowedPage(platform, event.url)) return
    event.preventDefault()
    openExternalPage(event.url)
  })
  contents.on('will-redirect', event => {
    if (!allowedPage(platform, event.url)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url, postBody }) => {
    if (allowedPage(platform, url)) void contents.loadURL(url).catch(() => {})
    else if (!postBody) openExternalPage(url)
    return { action: 'deny' }
  })
}

module.exports = { installAccountNavigation }
