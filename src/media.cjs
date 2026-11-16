const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
function mimeOf(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp'
  throw Error('仅支持 PNG、JPEG 和 WebP 图片')
}
function importFiles(store, files, nativeImage) {
  if (files.length > 64) throw Error('单稿最多 64 张配图')
  let total = 0
  return store.atomic(() =>
    files.map((filename) => {
      const size = fs.statSync(filename).size
      total += size
      if (size > 10 * 1024 * 1024 || total > 200 * 1024 * 1024)
        throw Error('单图上限 10 MB，单次导入上限 200 MB')
      const bytes = fs.readFileSync(filename)
      const mime = mimeOf(bytes)
      const id = createHash('sha256').update(bytes).digest('hex')
      const img = nativeImage.createFromBuffer(bytes)
      if (img.isEmpty()) throw Error('图片无法解码：' + path.basename(filename))
      const { width, height } = img.getSize()
      const scale = Math.min(1, 64 / width, 64 / height)
      const thumb = img
        .resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale))
        })
        .toJPEG(76)
        .toString('base64')
      store.db
        .prepare('INSERT OR IGNORE INTO assets(id,name,mime,size,thumb,bytes) VALUES(?,?,?,?,?,?)')
        .run(
          id,
          path.basename(filename),
          mime,
          bytes.length,
          'data:image/jpeg;base64,' + thumb,
          bytes
        )
      return id
    })
  )
}
async function materializeImages(store, job, root) {
  const dir = path.join(root, job.id)
  await fs.promises.mkdir(dir, { recursive: true })
  const paths = []
  for (const [i, id] of JSON.parse(job.assets).entries()) {
    const a = store.asset(id, true)
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[a.mime]
    if (!ext) throw Error('不支持的图片')
    const file = path.join(dir, String(i + 1).padStart(3, '0') + '-' + id + '.' + ext)
    await fs.promises.writeFile(file, a.bytes)
    paths.push(file)
  }
  return paths
}
module.exports = { importFiles, mimeOf, materializeImages }
