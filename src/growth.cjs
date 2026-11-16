// Compare only repeated observations of the same work or account.
const workFields = ['views', 'likes', 'comments']
function dayKey(time) {
  const d = new Date(time)
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
}
function readGrowth(db, now = Date.now()) {
  const today = new Date(now)
  const dates = Array.from({ length: 30 }, (_, i) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29 + i).getTime())
  const windows = [7, 30].map(length => ({
    days: dates.slice(-length).map(dayKey), accounts: {}, start: dates.at(-length)
  }))
  function collect(rows, fields, unpack) {
    let previousId
    let previous
    for (const row of rows) {
      if (row.id !== previousId) {
        previousId = row.id
        previous = windows.map(() => ({}))
      }
      const reading = unpack(row)
      for (let i = 0; i < windows.length; i++) {
        const window = windows[i]
        if (row.time < window.start) continue
        for (const key of fields) {
          const value = reading[key]
          if (!Number.isFinite(value) || (reading._times?.[key] ?? row.time) !== row.time) continue
          const last = previous[i][key]
          if (last) {
            const group = window.accounts[row.accountId] ??= {}
            const metric = group[key] ??= { comparable: 0, change: 0, daily: {} }
            if (!last.paired) metric.comparable++
            const diff = value - last.value
            const date = dayKey(row.time)
            metric.daily[date] = (metric.daily[date] || 0) + diff
            metric.change += diff
          }
          previous[i][key] = { value, paired: Boolean(last) }
        }
      }
    }
  }
  collect(db.prepare(`SELECT w.accountId, s.workId AS id, s.time, s.metrics
    FROM native_samples s JOIN native_works w ON w.id=s.workId
    WHERE s.time BETWEEN ? AND ? ORDER BY s.workId,s.time`).iterate(dates[0], now),
    workFields, row => JSON.parse(row.metrics))
  collect(db.prepare(`SELECT accountId, accountId AS id, time, followers FROM follower_samples
    WHERE time BETWEEN ? AND ? ORDER BY accountId,time`).iterate(dates[0], now), ['followers'], row => row)
  for (const w of windows) {
    const reports = new Map()
    for (const row of db.prepare('SELECT accountId,day,change FROM follower_daily WHERE day BETWEEN ? AND ?').iterate(w.days[0], w.days.at(-1))) {
      if (!reports.has(row.accountId)) reports.set(row.accountId, { comparable: 1, change: 0, daily: {}, official: true })
      const metric = reports.get(row.accountId)
      metric.daily[row.day] = row.change
      metric.change += row.change
    }
    for (const [id, metric] of reports) (w.accounts[id] ??= {}).followers = metric
  }
  return Object.fromEntries(windows.map(w => [w.days.length, { days: w.days, accounts: w.accounts }]))
}
module.exports = { readGrowth }
