'use strict'
/*
 * 自动采样排程（统一数据契约 v1.4 §15.4）。
 * 发条开着时，按作品发布后 1 小时、24 小时、72 小时、7 天、30 天的时点，
 * 以及 30 天内作品每天至少一次，决定该去读哪个账号的官方后台。
 * 本模块只负责"该不该读、先读谁"，真正的读取沿用手动「刷新数据」的同一套 syncWorks。
 */
const H = 3600000
const D = 24 * H
const CHECKPOINTS = [
  [1 * H, 2 * H],
  [24 * H, 6 * H],
  [72 * H, 12 * H],
  [7 * D, 1 * D],
  [30 * D, 3 * D]
]
const SYNCABLE = ['douyin', 'xhs', 'kuaishou', 'bilibili', 'tiktok', 'wechat', 'channels']
const MIN_GAP = 30 * 60000 // 同一账号两次读取至少间隔
const FAIL_BACKOFF = 2 * H // 读取失败后等待
const NEW_POST_GAP = H // 近 48 小时有发布任务的账号，每小时读一次，及时拿到新作品的 1 小时数据

function ensure(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS auto_sample(accountId TEXT PRIMARY KEY, time INTEGER NOT NULL, ok INTEGER NOT NULL, message TEXT NOT NULL DEFAULT \'\')'
  )
  db.exec('CREATE TABLE IF NOT EXISTS auto_sample_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
}
function enabled(db) {
  ensure(db)
  return db.prepare("SELECT value FROM auto_sample_settings WHERE key='enabled'").get()?.value !== '0'
}
function setEnabled(db, on) {
  ensure(db)
  db.prepare("INSERT OR REPLACE INTO auto_sample_settings VALUES('enabled',?)").run(on ? '1' : '0')
}
function record(db, accountId, ok, message = '', now = Date.now()) {
  ensure(db)
  db.prepare('INSERT OR REPLACE INTO auto_sample VALUES(?,?,?,?)').run(accountId, now, ok ? 1 : 0, String(message).slice(0, 300))
}
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
const ms = (posted) => (posted > 1e12 ? posted : posted * 1000)

function loggedIn(db, a) {
  const table = a.platform === 'douyin' ? 'native_sessions' : 'creator_logins'
  return hasTable(db, table) && !!db.prepare('SELECT 1 FROM ' + table + ' WHERE accountId=?').get(a.id)
}

/**
 * 返回现在该读的账号，按紧急程度排序。
 * @param busy 正在被用户操作（官方窗口打开中）的账号 ID，跳过
 */
function plan(db, now = Date.now(), busy = new Set()) {
  ensure(db)
  const attempts = Object.fromEntries(db.prepare('SELECT * FROM auto_sample').all().map((r) => [r.accountId, r]))
  const accounts = db
    .prepare('SELECT id,platform FROM accounts WHERE archived=0 AND platform IN (' + SYNCABLE.map(() => '?').join(',') + ')')
    .all(...SYNCABLE)
  const hasWorks = hasTable(db, 'native_works')
  const out = []
  for (const a of accounts) {
    if (busy.has(a.id) || !loggedIn(db, a)) continue
    const last = attempts[a.id]
    if (last && now - last.time < (last.ok ? MIN_GAP : FAIL_BACKOFF)) continue
    const attempted = last?.ok ? last.time : 0 // 失败的读取不算已采样
    const reasons = new Set()
    let urgency = Infinity
    if (hasWorks) {
      const works = db
        .prepare(
          'SELECT w.posted,(SELECT max(time) FROM native_samples s WHERE s.workId=w.id) AS last FROM native_works w WHERE w.accountId=? AND w.posted IS NOT NULL'
        )
        .all(a.id)
      for (const w of works) {
        const posted = ms(w.posted)
        const age = now - posted
        if (age < 0 || age > 31 * D) continue
        const seen = Math.max(w.last || 0, attempted)
        for (const [cp, grace] of CHECKPOINTS) {
          if (age >= cp && age <= cp + grace && seen < posted + cp) {
            reasons.add('checkpoint')
            urgency = Math.min(urgency, cp)
          }
        }
        if (age <= 30 * D && now - seen > D) reasons.add('daily')
      }
    }
    const recentJob = db
      .prepare(
        "SELECT 1 FROM jobs WHERE accountId=? AND status IN ('waiting','published','recorded','uncertain') AND due>=?"
      )
      .get(a.id, now - 2 * D)
    if (recentJob && now - attempted >= NEW_POST_GAP) {
      reasons.add('new-post')
      urgency = Math.min(urgency, H)
    }
    if (reasons.size) out.push({ id: a.id, platform: a.platform, reasons: [...reasons], urgency })
  }
  return out.sort((x, y) => x.urgency - y.urgency)
}

function status(db) {
  ensure(db)
  return {
    enabled: enabled(db),
    recent: db
      .prepare('SELECT s.accountId,s.time,s.ok,s.message,a.platform,a.name FROM auto_sample s JOIN accounts a ON a.id=s.accountId ORDER BY s.time DESC LIMIT 8')
      .all()
  }
}

module.exports = { plan, record, enabled, setEnabled, status, CHECKPOINTS, MIN_GAP, FAIL_BACKOFF }
