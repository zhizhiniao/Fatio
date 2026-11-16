// Serialized into the official editor, including the WebView2 host.
function editorRoot(platform) {
  if (platform === 'channels') {
    const app = document.querySelector('wujie-app')?.shadowRoot
    if (app) return app
    for (const frame of document.querySelectorAll('iframe')) {
      const doc = frame.contentDocument
      if (doc && doc.location.origin === location.origin && doc.location.pathname === '/micro/content/post/create') return doc
    }
  }
  return document
}
function editorExpression(platform, href, action, ...args) {
  return 'location.href === ' + JSON.stringify(href) + ' ? (' + action + ')((' +
    editorRoot + ')(' + JSON.stringify(platform) + '),...' + JSON.stringify(args) + ') : null'
}
module.exports = { editorRoot, editorExpression }
