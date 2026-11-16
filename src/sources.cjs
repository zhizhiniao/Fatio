const fs = require('node:fs/promises')
const path = require('node:path')
const { importFiles } = require('./media.cjs')
const { importVideos } = require('./videos.cjs')

const kinds = ['local', 'vault', 'video', 'postvela']
const images = /\.(?:png|jpe?g|webp)$/i
const movies = /\.(?:mp4|m4v|mov|webm)$/i
const byName = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })
async function entries(dir) {
  return (await fs.readdir(dir, { withFileTypes: true })).filter(
    (e) => !e.isSymbolicLink() && !/^[.~]/.test(e.name)
  )
}
async function directory(p) {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}
async function within(root, p) {
  const real = await fs.realpath(p)
  const rel = path.relative(await fs.realpath(root), real)
  if (
    !rel ||
    path.isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith('..' + path.sep)
  )
    throw Error('文件不在绑定目录内')
  return real
}
async function readText(file) {
  if ((await fs.stat(file)).size > 600000) throw Error('文本超过 600 KB')
  return (await fs.readFile(file, 'utf8'))
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
}
function visibleMarkdown(raw) {
  return raw.replace(/%%[\s\S]*?(?:%%|$)/g, '').replace(/<!--[\s\S]*?(?:-->|$)/g, '')
}
function article(raw, file) {
  raw = visibleMarkdown(raw)
  const front = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  let body = front ? raw.slice(front[0].length) : raw
  const h = body.match(/^\s*#\s+(.+)\n/)
  let title =
    front?.[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ||
    h?.[1] ||
    path.parse(file).name
  if (h) body = body.slice(h[0].length)
  const copy = body.match(
    /^\s*(?:小红书笔记)?标题[：:]?\n+([^\n]+)\s*\n(?:笔记)?正文[^\n]*\n([\s\S]*)$/
  )
  if (copy) {
    title = copy[1].trim()
    body = copy[2]
  }
  body = body
    .split(/^##\s+(?:发布图片|编校依据)\s*$/m)[0]
    .replace(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/g, '')
    .trim()
  return { title: title.trim(), body }
}
class Sources {
  constructor(store, videoDir, nativeImage) {
    this.store = store
    this.videoDir = videoDir
    this.nativeImage = nativeImage
    this.catalogs = new Map()
    this.db = store.db
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS source_roots(kind TEXT PRIMARY KEY,path TEXT NOT NULL); CREATE TABLE IF NOT EXISTS source_drafts(kind TEXT NOT NULL,file TEXT NOT NULL,draftId TEXT NOT NULL REFERENCES drafts(id),PRIMARY KEY(kind,file))'
    )
  }
  root(kind) {
    if (!kinds.includes(kind)) throw Error('无效的稿件来源')
    if (kind === 'postvela') return this.root('local')
    const row = this.db
      .prepare('SELECT path FROM source_roots WHERE kind=?')
      .get(kind)
    if (row) return row.path
    if (process.env.FATIO_TEST_DATA || process.env.JASTUDIO_TEST_DATA) return ''
    return {
      local: 'K:\\02图文公众号',
      vault: '\\\\DXP4800PLUS-JY\\Obsidian\\思钱想厚',
      video: ''
    }[kind]
  }
  bind(kind, p) {
    if (kind === 'postvela') kind = 'local'
    this.root(kind)
    this.catalogs.delete(kind)
    this.db
      .prepare(
        'INSERT INTO source_roots VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET path=excluded.path'
      )
      .run(kind, p)
  }
  async list(kind) {
    const root = this.root(kind)
    if (!root) return { root, items: [] }
    let base = root
    if (kind === 'vault' && (await directory(path.join(root, '04_图文工作台'))))
      base = path.join(root, '04_图文工作台')
    if (['local', 'postvela'].includes(kind) && (await directory(path.join(root, 'projects'))))
      base = path.join(root, 'projects')
    const items = []
    const add = (file, label) =>
      items.push({ key: path.relative(root, file), label })
    const visit = async (dir, depth) => {
      const files = await entries(dir)
      if (kind === 'postvela' && files.some(e => e.isFile() && e.name === '图文索引.md') &&
          files.some(e => e.isFile() && e.name === '发布文案.txt')) {
        add(path.join(dir, '图文索引.md'), path.relative(base, dir))
        return
      }
      for (const e of files) {
        const f = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (
            depth > 0 &&
            ![
              'footage',
              'image',
              'images',
              '历史版本',
              '制作',
              '预览',
              '发布图片',
              'node_modules'
            ].includes(e.name)
          )
            await visit(f, depth - 1)
        } else if (e.isFile()) {
          if (kind === 'video' && movies.test(e.name)) add(f, e.name)
          if (
            kind === 'vault' &&
            e.name.endsWith('.md') &&
            !/^(?:AGENTS|00_|04_图文工作台)/.test(e.name)
          ) {
            const fd = await fs.open(f, 'r')
            try {
              const b = Buffer.alloc(2048)
              const { bytesRead } = await fd.read(b, 0, b.length, 0)
              if (
                /^type:\s*content\s*$/m.test(
                  b.subarray(0, bytesRead).toString()
                )
              )
                add(f, path.parse(e.name).name)
            } finally {
              await fd.close()
            }
          }
        }
      }
    }
    if (kind === 'local') {
      for (const e of await entries(base)) {
        if (!e.isDirectory()) continue
        const dir = path.join(base, e.name),
          files = (await entries(dir)).filter(
            (f) =>
              f.isFile() &&
              /\.(md|txt)$/i.test(f.name) &&
              !/记录|进度|规则|模板|备份|核验|清单|^AGENTS|^PROJECT|^README/i.test(f.name)
          )
        const selected =
          files.find((f) => f.name.includes('发布文案')) ||
          files.find((f) => /正文|主稿/.test(f.name)) ||
          (files.length === 1 ? files[0] : null)
        if (selected) add(path.join(dir, selected.name), e.name)
      }
    } else await visit(base, ['vault', 'postvela'].includes(kind) ? 3 : 5)
    const readDraft = this.db.prepare(
      'SELECT draftId FROM source_drafts WHERE kind=? AND file=?'
    )
    for (const item of items)
      item.draftId = readDraft.get(kind, path.join(root, item.key))?.draftId
    items.sort((a, b) => byName(a.label, b.label))
    if (this.root(kind) === root)
      this.catalogs.set(kind, { root, keys: new Set(items.map((i) => i.key)) })
    return { root, items }
  }
  async sourceFile(kind, key) {
    const root = this.root(kind)
    if (
      !root ||
      typeof key !== 'string' ||
      path.isAbsolute(key) ||
      key.split(/[\\/]/).some((p) => !p || p.startsWith('.'))
    )
      throw Error('来源项目无效')
    if (this.catalogs.get(kind)?.root !== root) await this.list(kind)
    if (this.root(kind) !== root || !this.catalogs.get(kind)?.keys.has(key))
      throw Error('该稿件已不在所选目录，请重新加载列表')
    const file = await within(root, path.join(root, key))
    return { root, file }
  }
  async openPostvela(key) {
    const { root, file } = await this.sourceFile('postvela', key)
    const pack = await require('./postvela.cjs').inspect(root, path.dirname(file))
    pack.key = key
    pack.draftId =
      this.db.prepare('SELECT draftId FROM source_drafts WHERE kind=? AND file=?').get('postvela', file)
        ?.draftId || null
    return pack
  }
  /** 图集转为普通图文稿：按页序导入备用 PNG（Live / GIF 页用其静态图），再次导入复用同一草稿。 */
  async postvelaDraft(key, fresh = false) {
    const { root, file } = await this.sourceFile('postvela', key)
    const old = this.db
      .prepare('SELECT draftId FROM source_drafts WHERE kind=? AND file=?')
      .get('postvela', file)
    if (old && !fresh) return this.store.draft(old.draftId)
    const pack = await require('./postvela.cjs').inspect(root, path.dirname(file))
    if (!pack.title && !pack.body) throw Error('发布文案为空，请先在 PostVela 填写标题和正文')
    const assets = importFiles(this.store, pack.pages.map((p) => p.image), this.nativeImage)
    return this.store.atomic(() => {
      const prior = this.db
        .prepare('SELECT draftId FROM source_drafts WHERE kind=? AND file=?')
        .get('postvela', file)
      if (prior && !fresh) return this.store.draft(prior.draftId)
      const draft = this.store.save({
        kind: 'article',
        title: pack.title.trim(),
        body: pack.body,
        assets,
        videos: [],
        targets: [],
        xText: ''
      })
      this.db.prepare('INSERT OR REPLACE INTO source_drafts VALUES(?,?,?)').run('postvela', file, draft.id)
      return draft
    })
  }
  async load(kind, key, fresh = false) {
    if (kind === 'postvela') throw Error('请在 PostVela 图集中检查动态素材')
    const { root, file } = await this.sourceFile(kind, key)
    const raw = kind === 'video' ? '' : visibleMarkdown(await readText(file))
    if (/!\[\[[^\]]+\.gif(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\([^)]*\.gif(?:[?#][^)]*)?\)/i.test(raw))
      throw Error('原稿含 GIF 动图，直接导入会丢失动态。请在 PostVela 导出图集后，选择「PostVela 图集」检查；公众号长文请使用 PostVela 公众号预览。')
    const old = this.db
      .prepare('SELECT draftId FROM source_drafts WHERE kind=? AND file=?')
      .get(kind, file)
    if (old && !fresh) return this.store.draft(old.draftId)
    let values
    if (kind === 'video') {
      if (!movies.test(file)) throw Error('不支持此视频格式')
      values = {
        kind: 'video',
        title: path.parse(file).name,
        body: '',
        assets: [],
        videos: await importVideos(this.store, this.videoDir, [file])
      }
    } else {
      if (!/\.(md|txt)$/i.test(file)) throw Error('不支持此文稿格式')
      const dir = path.dirname(file)
      let files = []
      if (kind === 'vault') {
        for (const m of raw.matchAll(
          /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g
        )) {
          const ref = (m[1] || m[2]).replace(/^<|>$/g, '').trim()
          if (!images.test(ref) || /^(?:[a-z]+:|[\\/])/i.test(ref)) continue
          let p = path.resolve(dir, ref)
          try {
            await fs.access(p)
          } catch {
            p = path.resolve(root, ref)
          }
          files.push(await within(root, p))
        }
      } else {
        const art = (await directory(path.join(dir, '发布图片')))
          ? path.join(dir, '发布图片')
          : dir
        for (const n of (await entries(art))
          .filter((e) => e.isFile() && images.test(e.name))
          .map((e) => e.name)
          .sort(byName))
          files.push(await within(root, path.join(art, n)))
      }
      values = {
        kind: 'article',
        ...article(raw, file),
        assets: importFiles(this.store, [...new Set(files)], this.nativeImage),
        videos: []
      }
    }
    return this.store.atomic(() => {
      const prior = this.db
        .prepare('SELECT draftId FROM source_drafts WHERE kind=? AND file=?')
        .get(kind, file)
      if (prior && !fresh) return this.store.draft(prior.draftId)
      const draft = this.store.save({ ...values, targets: [], xText: '' })
      this.db
        .prepare('INSERT OR REPLACE INTO source_drafts VALUES(?,?,?)')
        .run(kind, file, draft.id)
      return draft
    })
  }
}
module.exports = { Sources, article, visibleMarkdown }
