const path = require('node:path')
const fs = require('node:fs')
const { Readable } = require('node:stream')
function previewMedia(store, root, req) {
  const url = new URL(req.url),
    id = url.pathname.slice(1)
  if (req.method !== 'GET' || !/^[0-9a-f]{64}$/.test(id))
    return new Response(null, { status: 404 })
  if (url.hostname === 'image') {
    const a = store.asset(id, true)
    return a
      ? new Response(a.bytes, { headers: { 'Content-Type': a.mime } })
      : new Response(null, { status: 404 })
  }
  const row =
    url.hostname === 'video' &&
    store.db.prepare('SELECT filename,size FROM videos WHERE id=?').get(id)
  if (!row || path.basename(row.filename) !== row.filename)
    return new Response(null, { status: 404 })
  const file = path.join(root, row.filename)
  if (!fs.existsSync(file) || fs.statSync(file).size !== row.size)
    return new Response(null, { status: 404 })
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type':
      path.extname(file) === '.webm'
        ? 'video/webm'
        : path.extname(file) === '.mov'
          ? 'video/quicktime'
          : 'video/mp4',
    'Accept-Ranges': 'bytes'
  }
  const range = req.headers.get('range')
  let start = 0,
    end = row.size - 1
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!m || (!m[1] && !m[2]))
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': 'bytes */' + row.size }
      })
    start = m[1] ? Number(m[1]) : Math.max(0, row.size - Number(m[2]))
    end = m[1] && m[2] ? Math.min(Number(m[2]), end) : end
    if (start > end || start >= row.size)
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': 'bytes */' + row.size }
      })
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + row.size
  }
  headers['Content-Length'] = String(end - start + 1)
  return new Response(
    Readable.toWeb(fs.createReadStream(file, { start, end })),
    { status: range ? 206 : 200, headers }
  )
}
module.exports = { previewMedia }
