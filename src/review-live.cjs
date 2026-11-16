const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
async function findCollector() {
  const ps = path.join(
    process.env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script =
    "$p=Join-Path $env:LOCALAPPDATA 'Programs\\DouyinDataReview\\DouyinDataReview.exe'; $ids=@(Get-Process -Name DouyinDataReview -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $p} | Select-Object -ExpandProperty Id); if($ids.Count){Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.OwningProcess -in $ids -and $_.LocalAddress -eq '127.0.0.1'} | Select-Object -ExpandProperty LocalPort -Unique}"
  const { stdout } = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 12000
  })
  for (const port of stdout
    .trim()
    .split(/\s+/)
    .filter((p) => /^\d{1,5}$/.test(p))) {
    const url = 'http://127.0.0.1:' + port
    try {
      const health = await request(url, '/v1/health')
      if (health.ok === true && health.version === 1) return url
    } catch {}
  }
  throw Error('请先打开 DouyinDataReview 桌面应用，再读取创作者指标。')
}
async function request(origin, route, token, body) {
  const response = await fetch(origin + route, {
    redirect: 'error',
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(route === '/v1/creator/read' ? 30000 : 2500)
  })
  const data = await response.json()
  if (!response.ok)
    throw Error(
      {
        login_required: '请在 DouyinDataReview 登录抖音创作者中心。',
        browser_reconnect_required: '请在 DouyinDataReview 重新连接抖音浏览器，再读取创作者指标。'
      }[data.error] ||
        'DouyinDataReview ' + response.status + ' · ' + String(data.error || '读取失败')
    )
  return data
}
const metricNames = {
  play_cnt: '播放量',
  vv: '播放量',
  digg_cnt: '点赞',
  like: '点赞',
  share: '分享',
  share_count: '分享',
  comment: '评论',
  comment_cnt: '评论',
  net_fans_cnt: '净增粉丝',
  net_follow_fans: '净增粉丝',
  publish_cnt: '投稿',
  publish_count: '投稿'
}
function dashboard(results) {
  const first = results?.[0]
  if (!first?.ok) throw Error('创作者中心没有返回可用指标')
  const list = first.data?.data?.metrics ?? first.data?.metrics
  if (!Array.isArray(list)) throw Error('创作者指标格式未识别')
  const values = new Map()
  for (const item of list) {
    const label = Object.hasOwn(metricNames, item.english_metric_name)
      ? metricNames[item.english_metric_name]
      : null
    const v = item.metric_value
    if (label && v != null && String(v).trim() !== '' && Number.isFinite(Number(v)))
      values.set(label, Number(v))
  }
  return [...values].map(([label, value]) => ({ label, value }))
}
function reviewClient(discover = findCollector, call = request) {
  let session = null
  return async (days = 7) => {
    if (![7, 30].includes(days)) throw Error('时间范围无效')
    const origin = await discover()
    if (!session || session.origin !== origin || session.expires <= Date.now()) {
      const { code } = await call(origin, '/v1/pairing-code')
      const { token, expiresInSeconds } = await call(origin, '/v1/pair', null, { code })
      if (!token) throw Error('采集器配对失败')
      session = {
        origin,
        token,
        expires: Date.now() + Math.max(0, Number(expiresInSeconds) - 10) * 1000
      }
    }
    const token = session.token
    try {
      const before = await call(origin, '/v1/accounts', token)
      const response = await call(origin, '/v1/creator/read', token, {
        requests: [{ key: 'dashboard', params: { recent_days: days } }]
      })
      const after = await call(origin, '/v1/accounts', token)
      const a = before.accounts?.find((a) => a.id === before.activeId)
      const last = after.accounts?.find((a) => a.id === after.activeId)
      if (!a?.uid || a.uid !== last?.uid || before.activeId !== after.activeId)
        throw Error('抖音会话身份未核实或已切换，请重新读取。')
      return {
        account: a.nickname || a.id,
        days,
        metrics: dashboard(response.results),
        time: new Date().toLocaleString('zh-CN')
      }
    } catch (e) {
      if (/401|not_paired/.test(e.message)) session = null
      throw e
    }
  }
}
module.exports = { reviewClient, dashboard }
