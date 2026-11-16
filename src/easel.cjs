const fs = require('node:fs'),
  path = require('node:path')
const fsp = fs.promises
const photo = /\.(?:png|jpe?g|webp)$/i,
  video = /\.(?:mp4|m4v|mov|webm)$/i,
  text = /\.(?:md|txt)$/i
function inside(root, child) {
  const rel = path.relative(root, child)
  return rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)
}
function safe(root, name) {
  if (
    typeof name !== 'string' ||
    name.split(/[\\/]/).some((s) => !s || s.startsWith('.') || s === '..') ||
    /[:\x00]/.test(name)
  )
    throw Error('Easel 成品路径无效')
  const real = fs.realpathSync(path.join(root, name))
  if (!inside(fs.realpathSync(root), real)) throw Error('Easel 成品路径越界')
  return real
}
function metadata(root, name) {
  const p = path.join(root, name)
  if (!fs.existsSync(p)) return {}
  if (!inside(fs.realpathSync(root), fs.realpathSync(p)) || fs.statSync(p).size > 2 * 1024 * 1024)
    throw Error('Easel 元数据不可读')
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
}
function project(root, key) {
  if (!key || /^[._]/.test(key) || key.toLowerCase() === 'analytics' || /[\\/]/.test(key))
    throw Error('项目标识无效')
  const dir = safe(root, key),
    manifest = metadata(dir, '.easel.json'),
    meta = metadata(dir, 'meta.json')
  const fallback = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && text.test(e.name))
    .map((e) => e.name)
  const declared =
    Array.isArray(manifest.deliverables) && manifest.deliverables.length
      ? manifest.deliverables
      : fallback
  const names = [...new Set([...declared, ...(Array.isArray(meta.images) ? meta.images : [])])]
  const items = []
  for (const n of names.filter(
    (n) => typeof n === 'string' && (text.test(n) || video.test(n) || photo.test(n))
  )) {
    try {
      const file = safe(dir, n)
      if (fs.statSync(file).isFile()) items.push({ name: n, file })
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
  return { key, title: String(manifest.title || meta.title || key), items }
}
function projects(root) {
  if (!fs.existsSync(root)) throw Error('未找到 Easel outputs 目录')
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^[._]/.test(e.name) && e.name.toLowerCase() !== 'analytics')
    .map((e) => {
      try {
        const p = project(root, e.name)
        return {
          key: p.key,
          title: p.title,
          items: p.items.filter((i) => text.test(i.name) || video.test(i.name)).map((i) => i.name)
        }
      } catch (error) {
        return { key: e.name, title: e.name, items: [], error: error.message }
      }
    })
}
async function importProject(store, root, key, item, media) {
  const p = project(root, key),
    selected = p.items.find((i) => i.name === item)
  if (!selected) throw Error('所选成品不在项目清单中')
  let body = '',
    assets = [],
    videos = [],
    kind = 'article'
  if (video.test(item)) {
    kind = 'video'
    videos = await media.videos([selected.file])
  } else {
    if (!text.test(item) || fs.statSync(selected.file).size > 600000)
      throw Error('正文格式或大小不支持')
    body = fs
      .readFileSync(selected.file, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
    if (body.startsWith('# ' + p.title + '\n')) body = body.slice(p.title.length + 3).trimStart()
    assets = media.images(p.items.filter((i) => photo.test(i.name)).map((i) => i.file))
  }
  return store.save({ kind, title: p.title, body, xText: '', targets: [], assets, videos })
}
async function exportProject(store, root, draftId, videoRoot) {
  if (!fs.statSync(root).isDirectory()) throw Error('未找到 Easel 作品目录')
  const d = store.draft(draftId),
    key = 'Fatio-' + d.id + '-r' + d.revision
  const dest = path.join(root, key)
  if (fs.existsSync(dest) || fs.existsSync(path.join(root, 'JAStudio-' + d.id + '-r' + d.revision)))
    throw Error('此版本的 Easel 项目已存在')
  const stage = await fsp.mkdtemp(path.join(root, '_jastudio-'))
  try {
    const title = d.title || '未命名草稿',
      files = ['正文.md']
    await fsp.writeFile(path.join(stage, files[0]), '# ' + title + '\n\n' + d.body, 'utf8')
    for (const [i, id] of (d.assets || []).entries()) {
      const a = store.asset(id, true),
        name =
          'image-' +
          (i + 1) +
          '.' +
          { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[a.mime]
      await fsp.writeFile(path.join(stage, name), a.bytes)
      files.push(name)
    }
    for (const [i, id] of (d.videos || []).entries()) {
      const v = store.db.prepare('SELECT filename FROM videos WHERE id=?').get(id),
        name = 'video-' + (i + 1) + path.extname(v.filename)
      const file = await require('./videos.cjs').verifiedVideo(store, videoRoot, id)
      await fsp.copyFile(file, path.join(stage, name))
      files.push(name)
    }
    await fsp.writeFile(
      path.join(stage, '.easel.json'),
      JSON.stringify(
        { title, kind: d.kind || 'article', status: 'draft', deliverables: files },
        null,
        2
      )
    )
    await fsp.rename(stage, dest)
    return key
  } catch (e) {
    await fsp.rm(stage, { recursive: true, force: true })
    throw e
  }
}
module.exports = { projects, project, importProject, exportProject }
