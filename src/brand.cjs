const path = require('node:path')

const name = '发条 Fatio'
const appId = 'Fatio.CreatorWorkspace'
const icon = path.join(__dirname, '../ui/fatio.ico')

// This is a storage identity, not the product name. Keep the existing database,
// Chromium Local State, cookies and WebView2 profiles together across upgrades.
function dataDirectory(appData, env = process.env) {
  return path.resolve(env.FATIO_TEST_DATA || env.JASTUDIO_TEST_DATA || path.join(appData, 'JAStudio'))
}

module.exports = { name, appId, icon, dataDirectory }
