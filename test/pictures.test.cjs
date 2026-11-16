const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createHash } = require('node:crypto')
const { pictureUrl, dimensions } = require('../src/pictures.cjs')
function png(width, height) {
  const b = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}
test('platform pictures accept only HTTPS CDN hosts and valid size headers', () => {
  assert.equal(pictureUrl('https://not-douyinpic.com/a'), null)
  assert.equal(pictureUrl('https://p3.douyinpic.com@evil.test/a'), null)
  assert.ok(pictureUrl('https://p3.douyinpic.com/media'))
  assert.deepEqual(dimensions(png(731, 1080)), [731, 1080])
  assert.equal(dimensions(Buffer.alloc(200)), null)
})
test('new picture wins delayed replies; oversized input never reaches the image decoder', async () => {
  const electronId = require.resolve('electron'),
    original = require.cache[electronId],
    picturesId = require.resolve('../src/pictures.cjs')
  const gates = new Map(),
    decoded = []
  const fake = {
    net: { fetch: (url) => new Promise((resolve) => gates.set(url, resolve)) },
    nativeImage: {
      createFromBuffer: (b) => {
        const size = dimensions(b)
        decoded.push(size)
        return {
          isEmpty: () => false,
          getSize: () => ({ width: size[0], height: size[1] }),
          resize: ({ width, height }) => ({ toJPEG: () => Buffer.from(width + 'x' + height) })
        }
      }
    }
  }
  require.cache[electronId] = { ...original, exports: fake }
  const originalPictures = require.cache[picturesId]
  delete require.cache[picturesId]
  const { picture } = require(picturesId)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE pictures(id TEXT PRIMARY KEY,fingerprint TEXT,image TEXT,checked INTEGER)')
  try {
    const base = 'https://p3.douyinpic.com/',
      send = (key, name) => picture(db, key, base + name, 96)
    const old = send('avatar', 'old'),
      fresh = send('avatar', 'new')
    gates.get(base + 'new')(new Response(png(30, 1000)))
    await fresh
    gates.get(base + 'old')(new Response(png(200, 100)))
    await old
    const stored = db.prepare('SELECT * FROM pictures WHERE id=?').get('avatar')
    assert.equal(
      stored.fingerprint,
      createHash('sha256')
        .update(base + 'new')
        .digest('hex')
    )
    assert.equal(Buffer.from(stored.image.split(',')[1], 'base64').toString(), '3x96')
    const huge = send('huge', 'huge')
    gates.get(base + 'huge')(new Response(png(8000, 8000)))
    await huge
    assert.equal(decoded.length, 1)
    assert.equal(db.prepare('SELECT count(*) n FROM pictures').get().n, 1)
  } finally {
    db.close()
    require.cache[electronId] = original
    require.cache[picturesId] = originalPictures
  }
})
