const fs = require('node:fs')
const path = require('node:path')

const REPOSITORY = 'https://github.com/zhizhiniao/Fatio'
const FEED = 'https://api.github.com/repos/zhizhiniao/Fatio/releases?per_page=20'
const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const RETRY_INTERVAL = 15 * 60 * 1000

function version(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(value))
  if (!match) return null
  const parts = match.slice(1, 4).map(Number)
  return parts.every(n => Number.isSafeInteger(n) && n <= 2147483647) ? parts : null
}
function compare(a, b) {
  const x = version(a), y = version(b)
  if (!x || !y) throw Error('无效版本号')
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  return 0
}
function release(row) {
  if (!row || row.draft || !version(row.tag_name)) return null
  const tag = String(row.tag_name)
  const numeric = version(tag).join('.')
  const url = REPOSITORY + '/releases/tag/' + encodeURIComponent(tag)
  const name = 'Fatio-Setup-' + numeric + '-x64.exe'
  const download = REPOSITORY + '/releases/download/' + encodeURIComponent(tag) + '/' + name
  if (row.html_url !== url) return null
  const asset = row.assets?.find(a => a.name === name && a.state === 'uploaded' && a.size > 0 && a.browser_download_url === download)
  if (!asset) return null
  return { tag, version: numeric, url, download, title: String(row.name || tag).slice(0, 200),
    notes: String(row.body || '').slice(0, 6000), prerelease: !!row.prerelease, publishedAt: String(row.published_at || '').slice(0, 40) }
}
function cachedRelease(value) {
  if (!value) return null
  return release({ tag_name: value.tag, html_url: value.url, name: value.title, body: value.notes,
    prerelease: value.prerelease, published_at: value.publishedAt,
    assets: [{ name: 'Fatio-Setup-' + value.version + '-x64.exe', state: 'uploaded', size: 1, browser_download_url: value.download }] })
}
function latestRelease(rows) {
  if (!Array.isArray(rows)) throw Error('版本服务返回格式错误')
  return rows.map(release).filter(Boolean).sort((a, b) => compare(b.version, a.version) || Number(a.prerelease) - Number(b.prerelease) || b.publishedAt.localeCompare(a.publishedAt))[0] || null
}
async function readJson(response) {
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1024 * 1024) throw Error('版本服务响应过大')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
class UpdateService {
  constructor({ directory, currentVersion, fetcher = fetch, notify = () => {}, now = Date.now }) {
    if (!version(currentVersion)) throw Error('无效的本机版本')
    this.file = path.join(directory, 'updates.json')
    this.currentVersion = currentVersion
    this.fetcher = fetcher
    this.notify = notify
    this.now = now
    this.state = { auto: true, skippedTag: '', lastChecked: 0, lastAttempt: 0, latest: null }
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.state = { auto: saved.auto !== false, skippedTag: String(saved.skippedTag || '').slice(0, 100),
        lastChecked: Number(saved.lastChecked) || 0, lastAttempt: Number(saved.lastAttempt) || 0, latest: cachedRelease(saved.latest) }
    } catch {}
    this.status = this.state.lastChecked ? (this.state.latest ? 'current' : 'empty') : 'unchecked'
  }
  info() {
    const available = !!this.state.latest && compare(this.state.latest.version, this.currentVersion) > 0
    return { ...this.state, currentVersion: this.currentVersion,
      status: available && !['error', 'checking'].includes(this.status) ? 'available' : this.status,
      available, notify: available && this.state.skippedTag !== this.state.latest.tag, message: this.message || '' }
  }
  emit() { this.notify(this.info()) }
  persist(patch) {
    this.state = { ...this.state, ...patch }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state))
    fs.renameSync(this.file + '.tmp', this.file)
  }
  automatic(enabled) {
    if (typeof enabled !== 'boolean') throw Error('无效更新偏好')
    this.persist({ auto: enabled })
    this.emit()
    return this.info()
  }
  skip() {
    if (!this.info().available) throw Error('当前没有可跳过的新版本')
    this.persist({ skippedTag: this.state.latest.tag })
    this.emit()
    return this.info()
  }
  target(kind) {
    const latest = cachedRelease(this.state.latest)
    if (!latest || !this.info().available || !['release', 'download'].includes(kind)) throw Error('当前没有可打开的更新')
    return kind === 'download' ? latest.download : latest.url
  }
  shouldCheck() {
    const now = this.now()
    return this.state.auto && (!this.state.lastChecked || now - this.state.lastChecked >= CHECK_INTERVAL) &&
      (!this.state.lastAttempt || now - this.state.lastAttempt >= RETRY_INTERVAL)
  }
  async check(force = false) {
    if (this.pending) return this.pending
    if (!force && !this.shouldCheck()) return this.info()
    this.pending = this.load().finally(() => { this.pending = null })
    return this.pending
  }
  async load() {
    const controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 12000)
    this.status = 'checking'
    this.message = ''
    this.emit()
    try {
      this.persist({ lastAttempt: this.now() })
      const response = await this.fetcher(FEED, { headers: { Accept: 'application/vnd.github+json',
        'User-Agent': 'Fatio/' + this.currentVersion, 'X-GitHub-Api-Version': '2022-11-28' },
        credentials: 'omit', redirect: 'error', signal: controller.signal })
      if (!response.ok) {
        await response.body?.cancel()
        throw Error([403, 429].includes(response.status) ? '版本服务暂时限流，请稍后重试' : '检查更新失败（HTTP ' + response.status + '）')
      }
      const latest = latestRelease(await readJson(response))
      this.persist({ latest, lastChecked: this.now() })
      this.status = latest ? 'current' : 'empty'
    } catch (error) {
      this.status = 'error'
      this.message = /版本服务|HTTP/.test(error.message) ? error.message : '暂时无法连接版本服务，请检查网络后重试；不影响账号和草稿使用'
    } finally {
      clearTimeout(timeout)
      this.controller = null
    }
    this.emit()
    return this.info()
  }
  cancel() { this.controller?.abort() }
}
module.exports = { UpdateService, version, compare, release, latestRelease, FEED, REPOSITORY, CHECK_INTERVAL }
