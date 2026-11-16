const { receiptUrl } = require('./platforms.cjs')
const { platforms } = require('./catalog.cjs')

const eligible = new Set(['douyin', 'xhs', 'kuaishou', 'wechat', 'bilibili', 'tiktok'])
const published = new Set(['已发布', '已发表', '仅自己可见', '仅好友可见'])
const day = 86400000
const compact = value => String(value || '').normalize('NFKC').replace(/[\s\u200b]+/gu, '')

function copyMatches(job, item) {
  const title = compact(job.title), body = compact(job.body)
  const caption = String(item.title || '')
  // Douyin can append hashtags and insert a stop between the title and description.
  const candidates = [compact(caption), compact(caption.replace(/(?:\s+#[^\s#]+)+\s*$/u, ''))]
  return candidates.some(text => {
    if (title.length >= 6 && text === title) return true
    if (body.length < 12) return false
    return text === body || text === title + body || text === title + '。' + body
  })
}

function compatibleWork(job, item) {
  if (job.platform !== 'bilibili' && job.platform !== 'tiktok') return true
  let path
  try { path = new URL(item.url).pathname } catch { return false }
  if (job.platform === 'tiktok') return !!job.videoId && /^\/@[^/]+\/video\//.test(path)
  return job.videoId ? path.startsWith('/video/') : path.startsWith('/read/')
}
function publicationMatches(jobs, items, now = Date.now()) {
  const edges = []
  for (const item of items) {
    if (!item.itemId || !item.url || !published.has(item.status)) continue
    for (const job of jobs) {
      if (!compatibleWork(job, item)) continue
      if (job.receipt) {
        if (job.receipt === item.itemId) edges.push({ job, item, receipt: true })
        continue
      }
      const start = Math.floor(Math.max(job.created, job.due) / 1000)
      if (!Number.isSafeInteger(item.publishedAt) || item.publishedAt < start ||
          item.publishedAt > Math.floor(now / 1000) || item.publishedAt > start + 7 * day / 1000) continue
      if (copyMatches(job, item)) edges.push({ job, item })
    }
  }
  // Resolve an exact receipt first; text matches must be unique in both directions.
  const reserved = new Set(edges.filter(e => e.receipt).map(e => e.item.itemId))
  const possible = edges.filter(e => e.receipt || !reserved.has(e.item.itemId))
  return possible.filter(e =>
    possible.filter(other => other.job.id === e.job.id).length === 1 &&
    possible.filter(other => other.item.itemId === e.item.itemId).length === 1)
}

class QueueReconciler {
  constructor(store, library, readPage, onChange) {
    this.store = store
    this.library = library
    this.readPage = readPage
    this.onChange = onChange
    this.results = new Map()
    this.running = null
  }
  pending() {
    return this.store.db.prepare(
      "SELECT j.*,a.platform,c.itemId AS receipt FROM jobs j JOIN accounts a ON a.id=j.accountId " +
      "LEFT JOIN receipt_candidates c ON c.jobId=j.id WHERE j.status IN ('waiting','uncertain') " +
      "AND a.archived=0 AND a.mode='web' AND NOT EXISTS (SELECT 1 FROM native_works w WHERE w.jobId=j.id)"
    ).all().filter(j => eligible.has(j.platform) && (j.platform !== 'bilibili' || j.videoId) && j.url === '')
  }
  check(force = false) {
    if (this.running) return this.running
    this.running = this.checkAccounts(force).finally(() => { this.running = null })
    return this.running
  }
  async checkAccounts(force) {
    const pending = this.pending()
    const accounts = [...new Set(pending.map(j => j.accountId))]
    const outcomes = await Promise.all(accounts.map(async id => {
      const previous = this.results.get(id)
      if (!force && previous && Date.now() < previous.next) return previous
      const platform = pending.find(j => j.accountId === id).platform
      let result
      try {
        const count = await this.checkAccount(id)
        result = { platform: platforms[platform].label, count, next: Date.now() + 90000 }
      } catch (e) {
        result = { platform: platforms[platform].label, count: 0, error: e.message, next: Date.now() + 300000 }
      }
      this.results.set(id, result)
      return result
    }))
    return { linked: outcomes.reduce((sum, r) => sum + r.count, 0), remaining: this.pending().length,
      errors: outcomes.filter(r => r.error).map(r => r.platform + '：' + r.error) }
  }
  async checkAccount(accountId) {
    const jobs = this.pending().filter(j => j.accountId === accountId)
    if (!jobs.length) return 0
    const account = this.store.account(accountId)
    const items = new Map(), cursors = new Set()
    let cursor = '0'
    const oldest = Math.floor(Math.min(...jobs.map(j => Math.max(j.created, j.due))) / 1000)
    while (cursor != null) {
      if (cursors.has(cursor) || cursors.size >= 12) throw Error('作品分页未能完整核对，请在任务详情选择本人作品')
      cursors.add(cursor)
      const page = await this.readPage(account, cursor)
      for (const item of page.items) items.set(item.itemId, item)
      cursor = page.next
      // Official management lists are newest first; skip older pages only once a whole page predates the jobs.
      if (page.items.length && page.items.every(w => Number.isSafeInteger(w.publishedAt) && w.publishedAt < oldest) &&
          jobs.every(j => !j.receipt || items.has(j.receipt))) break
    }
    const current = this.pending().filter(j => j.accountId === accountId)
    const matches = publicationMatches(current, [...items.values()])
    let count = 0
    for (const { job, item } of matches) {
      const url = receiptUrl(account, item.url)
      const known = this.store.db.prepare('SELECT jobId FROM native_works WHERE accountId=? AND itemId=?').get(accountId, item.itemId)
      if (known?.jobId && known.jobId !== job.id) continue
      const uid = account.platform === 'douyin' ? this.library.binding(accountId)?.uid : undefined
      const rows = this.library.writeItems(accountId, [{ ...item, url }], uid)
      const work = rows.find(w => w.itemId === item.itemId)
      this.library.link(job.id, work.id, '官方后台自动核对')
      count++
      this.onChange()
    }
    return count
  }
}
module.exports = { QueueReconciler, publicationMatches }
