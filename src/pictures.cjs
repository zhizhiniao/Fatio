const { createHash } = require('node:crypto')
const { nativeImage, net } = require('electron')

const MAX_BYTES = 2 * 1024 * 1024
const pendingPictures = new WeakMap()
function dimensions(b) {
  if (b.length < 30) return null
  if (
    b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
    b.toString('ascii', 12, 16) === 'IHDR'
  )
    return [b.readUInt32BE(16), b.readUInt32BE(20)]
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    switch (b.toString('ascii', 12, 16)) {
      case 'VP8X':
        return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1]
      case 'VP8 ':
        return [b.readUInt16LE(26) & 16383, b.readUInt16LE(28) & 16383]
      case 'VP8L': {
        if (b[20] !== 0x2f) return null
        const bits = b.readUInt32LE(21)
        return [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1]
      }
      default:
        return null
    }
  }
  if (b.readUInt16BE(0) !== 0xffd8) return null
  let i = 2
  while (i + 8 < b.length && b[i++] === 255) {
    while (i < b.length && b[i] === 255) i++
    if (i + 7 >= b.length) return null
    const marker = b[i++]
    if (marker === 0xda || marker === 0xd9) return null
    const n = b.readUInt16BE(i)
    if (n < 2 || i + n > b.length) return null
    if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker) && n >= 8)
      return [b.readUInt16BE(i + 5), b.readUInt16BE(i + 3)]
    i += n
  }
  return null
}
const allowed = [
  'douyinpic.com',
  'byteimg.com',
  'douyincdn.com',
  'hdslb.com',
  'xhscdn.com',
  'qpic.cn',
  'qlogo.cn',
  'finder.video.qq.com',
  'twimg.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'kwaicdn.com',
  'kwimgs.com',
  'wsukwai.com',
  'yximgs.com'
]
function pictureUrl(raw) {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      allowed.some((domain) => u.hostname === domain || u.hostname.endsWith('.' + domain))
      ? u
      : null
  } catch {
    return null
  }
}
async function shrinkWebp(data, width) {
  const image = new Image()
  image.src = data
  await image.decode()
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, width / Math.max(image.naturalWidth, image.naturalHeight))
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.83)
}
async function picture(db, key, raw, width, localRenderer) {
  const u = pictureUrl(raw)
  if (!u) return
  let pending = pendingPictures.get(db)
  if (!pending) {
    pending = new Map()
    pendingPictures.set(db, pending)
  }
  const prior = pending.get(key)
  if (prior?.url === u.href) return prior.result
  const entry = { url: u.href }
  pending.set(key, entry)
  entry.result = downloadPicture(
    db,
    key,
    u,
    width,
    localRenderer,
    () => pending.get(key) === entry
  ).finally(() => {
    if (pending.get(key) === entry) pending.delete(key)
  })
  return entry.result
}
async function downloadPicture(db, key, u, width, localRenderer, current) {
  const fingerprint = createHash('sha256')
    .update(u.origin + u.pathname)
    .digest('hex')
  const old = db.prepare('SELECT fingerprint,checked FROM pictures WHERE id=?').get(key)
  if (old?.fingerprint === fingerprint && Date.now() - old.checked < 12 * 3600000) return
  // No cookies, redirects or signed CDN URLs are stored with the image.
  try {
    const r = await net.fetch(u.href, {
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(7000)
    })
    if (!r.ok || Number(r.headers.get('content-length')) > MAX_BYTES || !r.body) return
    const chunks = []
    let bytes = 0
    for await (const part of r.body) {
      bytes += part.length
      if (bytes > MAX_BYTES) return
      chunks.push(part)
    }
    const buffer = Buffer.concat(chunks)
    const size = dimensions(buffer)
    if (
      !size ||
      Math.min(...size) < 1 ||
      Math.max(...size) > 8192 ||
      size[0] * size[1] > 8_000_000 ||
      !current()
    )
      return
    const img = nativeImage.createFromBuffer(buffer)
    let data
    if (!img.isEmpty()) {
      const { width: w, height: h } = img.getSize()
      const scale = Math.min(1, width / Math.max(w, h))
      const thumb = img.resize({
        width: Math.max(1, Math.round(w * scale)),
        height: Math.max(1, Math.round(h * scale))
      })
      data = 'data:image/jpeg;base64,' + thumb.toJPEG(83).toString('base64')
    } else if (
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP' &&
      localRenderer &&
      !localRenderer.isDestroyed()
    ) {
      const input = 'data:image/webp;base64,' + buffer.toString('base64')
      data = await localRenderer.executeJavaScript(
        '(' + shrinkWebp.toString() + ')(' + JSON.stringify(input) + ',' + width + ')'
      )
    } else return
    if (!current()) return
    db.prepare(
      'INSERT INTO pictures(id,fingerprint,image,checked) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,image=excluded.image,checked=excluded.checked'
    ).run(key, fingerprint, data, Date.now())
  } catch {
    /* A missing thumbnail must never discard the verified profile or work. */
  }
}
module.exports = { picture, pictureUrl, dimensions }
