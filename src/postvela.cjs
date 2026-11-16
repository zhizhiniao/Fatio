const fs = require('node:fs/promises')
const path = require('node:path')

async function safeFile(root, file) {
  const real = await fs.realpath(file)
  const rel = path.relative(await fs.realpath(root), real)
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep))
    throw Error('PostVela 文件不在绑定目录内')
  const stat = await fs.stat(real)
  if (!stat.isFile() || stat.size === 0) throw Error('图集文件为空或不可读')
  return { file: real, size: stat.size }
}
async function inspect(root, folder) {
  const copyFile = await safeFile(root, path.join(folder, '发布文案.txt'))
  if (copyFile.size > 600000) throw Error('发布文案超过 600 KB')
  const copy = (await fs.readFile(copyFile.file, 'utf8')).replace(/^\uFEFF/, '').trim()
  const [title, ...lines] = copy.split(/\r?\n/)
  const entries = await fs.readdir(folder, { withFileTypes: true })
  const names = new Set(entries.map(e => e.name))
  const files = entries.filter(e => e.isFile() && /^page-\d{3}\.png$/.test(e.name))
    .map(e => e.name).sort()
  if (!files.length || files.length > 64) throw Error('图集需要 1 至 64 页 PNG 备用图')
  const pages = []
  for (const [index, name] of files.entries()) {
    const stem = name.slice(0, -4), number = Number(stem.slice(5))
    if (number !== index + 1) throw Error('图集页码不连续，请重新导出')
    const image = await safeFile(root, path.join(folder, name))
    const page = { number, name, image: image.file, kind: 'static' }
    if (names.has(stem + '.pvt')) {
      const pair = path.join(folder, stem + '.pvt')
      const children = await fs.readdir(pair)
      const jpg = children.filter(n => /\.jpe?g$/i.test(n))
      const mov = children.filter(n => /\.mov$/i.test(n))
      if (jpg.length !== 1 || mov.length !== 1 || !children.includes('metadata.plist'))
        throw Error('第 ' + number + ' 页 Live 配对文件不完整，请重新导出')
      for (const n of [jpg[0], mov[0], 'metadata.plist']) await safeFile(root, path.join(pair, n))
      page.kind = 'live'
      page.preview = (await safeFile(root, path.join(folder,
        names.has(stem + '-预览.mp4') ? stem + '-预览.mp4' : stem + '.pvt/' + mov[0]))).file
    } else if (names.has(stem + '.gif')) {
      page.kind = 'gif'
      page.preview = (await safeFile(root, path.join(folder, stem + '.gif'))).file
    }
    pages.push(page)
  }
  // A dynamic file without its corresponding page must never disappear from the count.
  for (const name of names) {
    const m = /^(page-\d{3})\.(?:pvt|gif)$/.exec(name)
    if (m && !files.includes(m[1] + '.png')) throw Error('动态页缺少备用 PNG：' + name)
  }
  return { folder, title, body: lines.join('\n').trim(), pages }
}
module.exports = { inspect }
