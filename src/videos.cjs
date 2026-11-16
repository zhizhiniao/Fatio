const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
async function matches(file, id) {
  if (!fs.existsSync(file)) return false
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex') === id
}

async function importVideos(store, root, files) {
  if (!Array.isArray(files) || files.length > 32) throw Error('每批最多 32 个视频')
  await fsp.mkdir(root, { recursive: true })
  const imported = []
  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    if (!['.mp4', '.m4v', '.mov', '.webm'].includes(ext)) throw Error('支持 MP4、MOV、M4V 和 WebM')
    const tmp = path.join(root, randomUUID() + '.part')
    const hash = createHash('sha256')
    let size = 0,
      header = Buffer.alloc(0)
    const count = new Transform({
      transform(chunk, _, cb) {
        if (header.length < 32)
          header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)])
        hash.update(chunk)
        size += chunk.length
        cb(null, chunk)
      }
    })
    try {
      await pipeline(fs.createReadStream(file), count, fs.createWriteStream(tmp, { flags: 'wx' }))
      const valid =
        ext === '.webm'
          ? header.subarray(0, 4).toString('hex') === '1a45dfa3'
          : ['ftyp', 'wide', 'moov', 'mdat', 'free'].includes(header.toString('ascii', 4, 8))
      if (!valid || size < 12) throw Error('视频文件头与格式不符：' + path.basename(file))
      const id = hash.digest('hex')
      const old = store.db.prepare('SELECT * FROM videos WHERE id=?').get(id)
      const filename = old?.filename || id + ext
      const dest = path.join(root, filename)
      if (!old || !(await matches(dest, id))) await fsp.rename(tmp, dest)
      store.db
        .prepare('INSERT OR IGNORE INTO videos(id,name,filename,size) VALUES(?,?,?,?)')
        .run(id, path.basename(file), filename, size)
      imported.push(id)
    } finally {
      await fsp.rm(tmp, { force: true })
    }
  }
  return [...new Set(imported)]
}
async function verifiedVideo(store, root, id) {
  const row = store.db.prepare('SELECT filename,size FROM videos WHERE id=?').get(id)
  if (!row) throw Error('任务没有视频')
  const file = path.join(root, row.filename)
  if (!fs.existsSync(file) || fs.statSync(file).size !== row.size || !(await matches(file, id)))
    throw Error('排期视频缺失或已改变，请重新导入原文件')
  return file
}
const videoPath = (store, root, jobId) => verifiedVideo(store, root, store.job(jobId).videoId)
// Only attach to a unique empty video input on the intended official upload route.
async function attachMedia(win, account, job, files) {
  const { editorUrl } = require('./platforms.cjs')
  const expected = new URL(editorUrl(account, job.videoId ? 'video' : 'article')),
    wc = win.webContents
  const valid = () => {
    const u = new URL(wc.getURL())
    return (
      u.origin === expected.origin &&
      u.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '') &&
      ![...u.searchParams.keys()].some((k) =>
        /^(aid|bvid|cvid|id|item_?id|note_?id|draft_?id|workId|publishId|edit)$/i.test(k)
      ) &&
      [...expected.searchParams].every(([k, v]) => u.searchParams.get(k) === v)
    )
  }
  if (!valid()) throw Error('请先登录目标账号并进入对应的官方投稿页')
  const dbg = wc.debugger
  const owns = !dbg.isAttached()
  if (!owns && !require('./douyin-window.cjs').watched.has(wc)) throw Error('上传窗口正忙')
  if (owns) dbg.attach('1.3')
  try {
    const pattern = job.videoId ? 'video|mp4|mov|webm' : 'image|png|jpe?g|webp'
    const inputSelector =
      account.platform === 'bilibili' && job.videoId
        ? '.bcc-upload-wrapper input[type=file]'
        : 'input[type=file]'
    const { editorExpression } = require('./video-editor-dom.cjs')
    const result = await dbg.sendCommand('Runtime.evaluate', {expression:editorExpression(
      account.platform, wc.getURL(), (root, selector, pattern, count) => {
        const re = new RegExp(pattern,'i')
        const nodes = [...root.querySelectorAll(selector)].filter(n => !n.disabled && re.test(n.accept))
        return nodes.length === 1 && !nodes[0].files.length && (count === 1 || nodes[0].multiple) ? nodes[0] : null
      }, inputSelector, pattern, files.length)})
    const objectId = result.result.objectId
    if (!objectId || !valid()) throw Error('未找到唯一且兼容的空上传框，请手动选择素材。')
    await dbg.sendCommand('DOM.setFileInputFiles', { objectId, files })
    await dbg.sendCommand('Runtime.releaseObject', {objectId}).catch(() => {})
    return '已向官方上传框选入素材，请在平台检查上传状态。'
  } finally {
    if (owns && dbg.isAttached()) dbg.detach()
  }
}
module.exports = { importVideos, videoPath, verifiedVideo, attachMedia, matches }
