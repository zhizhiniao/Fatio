'use strict'
/* 发布设置里的平台规则预检与入队前确认（规则见 rules.js）。依赖 app.js 的全局状态。 */
function precheckInput(v) {
  const assetRows = data.assets || []
  return {
    kind: v.kind,
    title: v.title,
    body: v.body,
    xText: v.xText,
    variants: v.variants,
    videoTags: v.videoTags,
    images: v.assets.map((id) => assetRows.find((a) => a.id === id)).filter(Boolean),
    videos: v.videos.map((id) => data.videos?.find((x) => x.id === id)).filter(Boolean)
  }
}
function precheckResults(v = localValues()) {
  const targets = v.targets.map(accountById).filter(Boolean)
  return FatioRules.check(precheckInput(v), targets.map((a) => a.platform))
}
function precheckList(results) {
  return results
    .map(
      (r) =>
        '<div class="precheck-platform">' +
        badge(r.platform) +
        '<div><b>' +
        escape(platforms[r.platform] || r.platform) +
        '</b>' +
        r.issues
          .map(
            (i) =>
              '<p class="precheck-' +
              i.level +
              '"><span>' +
              (i.level === 'error' ? '超限' : '注意') +
              '</span>' +
              escape(i.message) +
              '</p>'
          )
          .join('') +
        '</div></div>'
    )
    .join('')
}
function renderPrecheck(v) {
  const host = $('precheck')
  if (!host) return
  const targets = v.targets.map(accountById).filter(Boolean)
  const checked = [...new Set(targets.map((a) => a.platform))].filter((p) => FatioRules.RULES[p])
  if (!checked.length) {
    host.hidden = true
    return
  }
  const results = precheckResults(v)
  const errors = results.reduce((n, r) => n + r.issues.filter((i) => i.level === 'error').length, 0)
  const warns = results.reduce((n, r) => n + r.issues.filter((i) => i.level === 'warn').length, 0)
  host.hidden = false
  host.className = 'precheck ' + (errors ? 'has-error' : warns ? 'has-warn' : 'is-ok')
  host.innerHTML =
    '<div class="precheck-head">' +
    icon(errors ? 'circle-alert' : warns ? 'triangle-alert' : 'circle-check') +
    '<strong>平台规则预检</strong><small>' +
    (errors || warns
      ? [errors && errors + ' 项超限', warns && warns + ' 项注意'].filter(Boolean).join(' · ')
      : '已按 ' + checked.map((p) => platforms[p]).join('、') + ' 规则检查') +
    '</small></div>' +
    precheckList(results)
}
function precheckGate() {
  const results = precheckResults()
  const errors = results
    .map((r) => ({ ...r, issues: r.issues.filter((i) => i.level === 'error') }))
    .filter((r) => r.issues.length)
  if (!errors.length) return Promise.resolve(true)
  return new Promise((resolve) => {
    let answered = false
    const done = (value) => {
      if (answered) return
      answered = true
      resolve(value)
    }
    modal(
      '有内容超出平台上限',
      '<p class="hint">网页渠道最终在官方页面发表，可以先入队再到平台页修改；API 直发的账号会按原文发送。</p>' +
        '<div class="precheck in-dialog">' +
        precheckList(errors) +
        '</div><div class="modal-foot"><button id="precheck-back" class="outline">返回修改</button><button id="precheck-go" class="primary">仍然加入队列</button></div>'
    )
    // 入队期间全局按钮处理处于忙碌状态，这里单独接管右上角关闭
    const closer = $('dialog-inner').querySelector('[data-action=close]')
    if (closer) closer.onclick = () => dialog.close()
    $('precheck-back').onclick = () => {
      done(false)
      dialog.close()
    }
    $('precheck-go').onclick = () => {
      done(true)
      dialog.close()
    }
    dialog.addEventListener('close', () => done(false), { once: true })
  })
}
