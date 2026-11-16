const { contextBridge, ipcRenderer, webUtils } = require('electron')
const names = [
  'update-info', 'update-check', 'update-auto', 'update-skip', 'update-open',
  'account-tab',
  'account-tab-action',
  'snapshot',
  'source-list', 'source-bind', 'source-load', 'frame-cover', 'author-assist',
  'postvela-open', 'postvela-action', 'postvela-draft',
  'nas-export-status', 'nas-export-bind', 'nas-export-run',
  'auto-sample-status', 'auto-sample-toggle',
  'cover-art', 'apply-pending-covers', 'creative-notes',
  'creative-save-notes',
  'creative-variant',
  'versions',
  'version-save',
  'version-restore',
  'account-meta',
  'insights',
  'new-douyin',
  'new-creator',
  'lookup-work',
  'work-report',
  'sync-works',
  'reconcile-queue',
  'await-receipt',
  'undo-manual',
  'video-materials',
  'copy-video-copy',
  'sync-job-work',
  'work-history',
  'work-refresh',
  'history-import',
  'project-import',
  'easel-import',
  'easel-export',
  'report-import',
  'pick-videos',
  'video-path',
  'save',
  'count',
  'add-account',
  'archive',
  'login',
  'queue',
  'open-job',
  'record',
  'cancel',
  'reschedule',
  'retry',
  'resolve-missing',
  'visit',
  'copy',
  'pick-images',
  'copy-image',
  'import',
  'closed'
]
const api = {}
api.onTabIdentity = (callback) =>
  ipcRenderer.on('account-tab-identity', (_e, id, label) => callback(id, label))
api.onTabError = (callback) =>
  ipcRenderer.on('account-tab-error', (_e, id, code) => callback(id, code))
api.dropVideos = async (files) => {
  const result = await ipcRenderer.invoke(
    'drop-videos',
    files.map((file) => webUtils.getPathForFile(file))
  )
  if (!result.ok) throw Error(result.message)
  return result.value
}
for (const name of names)
  api[name] = async (...args) => {
    const result = await ipcRenderer.invoke(name, ...args)
    if (!result.ok) throw Error(result.message)
    return result.value
  }
api.onQueue = (callback) => ipcRenderer.on('queue-changed', () => callback())
api.onUpdate = callback => ipcRenderer.on('update-changed', (_event, info) => callback(info))
api.onClose = (callback) => ipcRenderer.on('flush-close', () => callback())
api.onWorks = (callback) => ipcRenderer.on('native-show-works', () => callback())
api.onJob = (callback) => ipcRenderer.on('native-job', (_, id) => callback(id))
contextBridge.exposeInMainWorld('studio', api)
