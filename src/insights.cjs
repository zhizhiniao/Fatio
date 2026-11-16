const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { parse } = require('csv-parse/sync')
const { createHash } = require('node:crypto')
const { platforms } = require('./catalog.cjs')

function platformName(key) {
  return platforms[key]?.label ?? (key === 'shipinhao' ? '微信视频号' : key)
}
function readCreator(file) {
  if (!fs.existsSync(file)) throw Error('未找到 CreatorHub 数据库')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500; BEGIN')
    for (const table of ['douyinaccount', 'accountstatsnapshot', 'accountwork']) {
      if (db.prepare('SELECT COUNT(*) n FROM ' + table).get().n > 100000)
        throw Error('单表超过 10 万条，请缩小导入范围')
    }
    const accounts = db.prepare('SELECT id,platform,nickname FROM douyinaccount ORDER BY id').all()
    const snapshots = db
      .prepare(
        'SELECT account_id,platform,date,follower_count,aweme_count,total_like,total_play,total_comment FROM accountstatsnapshot ORDER BY date DESC,id DESC'
      )
      .all()
    const works = db
      .prepare(
        'SELECT platform,account_id,item_id,desc AS title,create_time,like_count,comment_count,collect_count,share_count,play_count,fetched_at FROM accountwork ORDER BY create_time DESC'
      )
      .all()
    const lookup = new Map(accounts.map((a) => [a.id, a.nickname || '账号 ' + a.id]))
    return {
      accounts: accounts.map((a) => {
        const stat = snapshots.find((s) => s.account_id === a.id && s.platform === a.platform)
        const hasWorks = works.some((w) => w.account_id === a.id && w.platform === a.platform)
        return {
          source: 'CreatorHub',
          sourceAccountId: a.id,
          account: lookup.get(a.id),
          platform: platformName(a.platform),
          time: stat?.date,
          followers: stat?.follower_count,
          views: hasWorks ? stat?.total_play : null,
          likes: hasWorks ? stat?.total_like : null,
          comments: hasWorks ? stat?.total_comment : null,
          worksCount: stat?.aweme_count,
          history: snapshots
            .filter((s) => s.account_id === a.id && s.platform === a.platform)
            .slice(0, 31)
            .map((s) => ({ date: s.date, followers: s.follower_count }))
        }
      }),
      works: works.map((w) => ({
        source: 'CreatorHub',
        sourceAccountId: w.account_id,
        sourceItemId: w.item_id,
        platform: platformName(w.platform),
        account: lookup.get(w.account_id),
        title: w.title || w.item_id,
        time: w.create_time ? new Date(w.create_time * 1000).toISOString().slice(0, 10) : null,
        views: w.play_count,
        likes: w.like_count,
        comments: w.comment_count,
        shares: w.share_count,
        collects: w.collect_count
      })),
      snapshots: snapshots.length
    }
  } finally {
    db.close()
  }
}
function loadJson(file, root) {
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file))
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep))
    throw Error('归档文件超出所选目录')
  if (fs.statSync(file).size > 192 * 1024 * 1024) throw Error('单份归档超过 192 MB')
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}
function readReview(root) {
  const index = loadJson(path.join(root, 'accounts.json'), root)
  if (!Array.isArray(index.accounts)) throw Error('账号索引格式不匹配')
  return index.accounts.map((a) => {
    if (!/^(?:default|[0-9a-f]{12})$/.test(a.id)) throw Error('账号目录标识不匹配')
    const recordFile = path.join(
      root,
      ...(a.id === 'default' ? [] : ['accounts', a.id]),
      'records.json'
    )
    const base = { account: a.nickname || a.id, sourceAccountId: a.uid || a.id }
    if (!fs.existsSync(recordFile)) return { ...base, missing: true }
    const d = loadJson(recordFile, root)
    if (![1, 2].includes(d.schemaVersion) || !d.records) throw Error('参考记录格式不匹配')
    const lists = ['watch_history', 'liked_videos', 'favorite_videos'].map((k) => d.records[k])
    if (!lists.every(Array.isArray)) throw Error('参考记录缺少分类')
    return {
      ...base,
      watched: lists[0].length,
      liked: lists[1].length,
      favorites: lists[2].length,
      unique: new Set(lists.flatMap((xs) => xs.map((x) => x.videoId).filter(Boolean))).size,
      time: d.updatedAt
    }
  })
}
const metricNames = {
  views: ['阅读（播放）', '阅读（播放）量', '总播放量'],
  recommended: ['推荐量', '推荐'],
  followerGain: ['涨粉数'],
  yesterdayViews: ['昨日播放量'],
  followers: ['粉丝数'],
  likes: ['点赞', '点赞数'],
  comments: ['评论', '评论数'],
  shares: ['分享'],
  collects: ['收藏'],
  revenue: ['总收益', '收益'],
  yesterdayRevenue: ['昨日收益'],
  yesterdayLikes: ['昨日点赞'],
  yesterdayComments: ['昨日评论'],
  yesterdayFollowers: ['昨日涨粉']
}
function numeric(v) {
  if (v == null || /^(\s*|--?|—|N\/A)$/.test(v.trim())) return null
  const value = v.trim().replace(/,/g, '')
  if (!/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
    throw Error('无法识别数值：' + v.slice(0, 32))
  return Number(value)
}
function decodeCSV(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
  }
}
function importReport(store, bytes) {
  if (bytes.length > 32 * 1024 * 1024) throw Error('CSV 文件超过 32 MB')
  const grid = parse(decodeCSV(bytes), {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  })
  const header = grid.shift() || []
  const kind =
    header.includes('阅读（播放）') && header.includes('账号')
      ? 'works'
      : header.includes('总收益') && header.includes('账号')
        ? 'accounts'
        : header.includes('推荐量') && header.includes('平台')
          ? 'platforms'
          : null
  if (!kind || !header.includes('平台'))
    throw Error('请选择易媒导出的「内容数据」「数据总览」或「平台数据」CSV')
  const keys = {
    works: ['标题', '账号', '链接'],
    accounts: ['账号', '更新时间'],
    platforms: ['更新时间']
  }[kind]
  if (!keys.every((k) => header.includes(k))) throw Error('报表列不完整')
  let entries = 0
  store.atomic(() => {
    const write = store.db.prepare(
      'INSERT INTO reports(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
    )
    for (const values of grid) {
      if (values.every((v) => !v)) continue
      if (values.length > header.length && values.slice(header.length).some(Boolean))
        throw Error('报表行列数不一致')
      const row = Object.fromEntries(header.map((h, i) => [h, values[i] || '']))
      if (
        !row['平台'] ||
        (kind !== 'platforms' && !row['账号']) ||
        (kind === 'works' && !row['标题'] && !row['链接'])
      )
        throw Error('报表行缺少平台、账号或作品')
      const item = {
        source: '易媒 CSV',
        platform: row['平台'],
        account: row['账号'],
        title: row['标题'],
        time: row['更新时间'] || row['发布时间'] || null
      }
      for (const [key, names] of Object.entries(metricNames)) {
        const col = names.find((n) => header.includes(n))
        item[key] = col ? numeric(row[col]) : null
      }
      const identity = kind === 'works' ? row['链接'] || [item.title, item.time] : item.time
      const id = createHash('sha256')
        .update(JSON.stringify([kind, item.platform, item.account, identity]))
        .digest('hex')
      write.run(id, kind, JSON.stringify(item))
      entries++
    }
  })
  return entries
}
function performance(store) {
  const rows = store.db
    .prepare("SELECT data FROM reports WHERE kind='accounts'")
    .all()
    .map((r) => JSON.parse(r.data))
  const dated = rows
    .map((row) => {
      const date = new Date(
        String(row.time ?? '')
          .replace(/年|月|\//g, '-')
          .replace(/日/g, '')
      )
      return {
        row,
        stamp: date.getTime(),
        day: Number.isFinite(date.getTime())
          ? [
              date.getFullYear(),
              String(date.getMonth() + 1).padStart(2, '0'),
              String(date.getDate()).padStart(2, '0')
            ].join('-')
          : null
      }
    })
    .filter((r) => r.day)
    .sort((a, b) => b.stamp - a.stamp)
  const date = dated[0]?.day ?? null,
    latest = new Map()
  for (const r of dated.filter((r) => r.day === date)) {
    const key = JSON.stringify([r.row.platform, r.row.account])
    if (!latest.has(key)) latest.set(key, r.row)
  }
  const items = [...latest.values()]
  const totals = {}
  for (const key of [
    'revenue',
    'yesterdayRevenue',
    'yesterdayViews',
    'yesterdayComments',
    'yesterdayLikes',
    'yesterdayFollowers'
  ]) {
    totals[key] =
      items.length && items.every((r) => r[key] != null)
        ? items.reduce((a, r) => a + r[key], 0)
        : null
  }
  return { date, count: items.length, totals }
}
module.exports = { readCreator, readReview, importReport, performance }
