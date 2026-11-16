'use strict'
/*
 * 平台规则预检。
 * 文本长度、图片张数、话题数量和图片格式上限参考 AiToEarn（MIT）各平台 contentLimits / mediaRules，
 * 再按本机网页投稿的实测结论修正：小红书与抖音网页不接受 GIF，小红书图文最多 18 张，抖音图文按网页 35 张，B站简介按网页 2000 字。
 * error：平台会拒收或截断，入队前提醒；warn：可能需要在官方页面调整。
 */
;(function (root) {
  const MB = 1024 * 1024
  const RULES = {
    douyin: { title: 30, body: 1000, total: 1000, images: 35, needImage: 'warn', topics: 5, imageFormats: ['jpeg', 'png', 'bmp'], noGif: true, imageSize: 20 * MB },
    xhs: { title: 20, body: 1000, images: 18, needImage: 'error', topics: 10, imageFormats: ['jpeg', 'png', 'webp', 'bmp'], noGif: true, imageSize: 20 * MB },
    kuaishou: { total: 1000, joinTitle: true, topics: 4, imageSize: 20 * MB },
    tiktok: { body: 2200, total: 2200, images: 35, imageFormats: ['jpeg', 'webp'], imageSize: 20 * MB },
    bilibili: { title: 80, body: 2000, topics: 10 },
    channels: { title: 16, titleMin: 6, body: 1000, images: 9, imageSize: 20 * MB },
    wechat: { title: 64, body: 20000, images: 20, imageSize: 10 * MB },
    x: { images: 4, imageFormats: ['jpeg', 'png', 'gif', 'webp'], imageSize: 5 * MB }
  }
  const len = (s) => Array.from(String(s || '').trim()).length
  const ext = (mime, name) => {
    const m = String(mime || '').toLowerCase().match(/^image\/(?:x-)?([a-z0-9+.-]+)/)
    const e = m ? m[1] : (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || ''
    return e === 'jpg' ? 'jpeg' : e
  }
  const label = (e) => (e === 'jpeg' ? 'JPG' : e.toUpperCase())
  function splitTags(raw) {
    return String(raw || '')
      .split(/[\s,#，＃、]+/u)
      .map((t) => t.trim())
      .filter(Boolean)
  }
  function bodyTopics(body) {
    return [...String(body || '').matchAll(/[#＃]([\p{L}\p{N}_]+)/gu)].map((m) => m[1])
  }
  function topicIssues(rule, topics, out) {
    if (!rule.topics || !topics.length) return
    const keys = topics.map((t) => t.toLowerCase())
    if (new Set(keys).size !== keys.length) out.push(['warn', '话题', '话题有重复，平台通常只保留一次'])
    const unique = new Set(keys).size
    if (rule.topics && unique > rule.topics)
      out.push(['warn', '话题', '话题 ' + unique + ' 个，建议不超过 ' + rule.topics + ' 个'])
  }
  /**
   * @param {object} d   稿件：kind,title,body,xText,variants,videoTags,images[{mime,size,name}],videos[{name,size}]
   * @param {string} platform
   * @returns {Array<{level,field,message}>}
   */
  function checkPlatform(d, platform) {
    const rule = RULES[platform]
    if (!rule) return []
    const out = []
    const v = (d.variants && d.variants[platform]) || {}
    const kind = d.kind || 'article'
    const title = platform === 'x' ? '' : String(v.title || '').trim() || String(d.title || '').trim()
    const body = platform === 'x' ? String(d.xText || '').trim() || String(d.body || '').trim() : String(v.body || '').trim() || String(d.body || '').trim()
    const titles = title
      ? [title]
      : kind === 'video'
        ? (d.videos || []).map((x) => String(x.name || '').replace(/\.[^.]+$/, ''))
        : []
    for (const t of titles) {
      const n = len(t)
      const from = title ? '标题' : '标题（未填，沿用文件名）'
      if (rule.joinTitle) continue
      if (rule.title && n > rule.title) out.push(['error', '标题', from + ' ' + n + ' 字，上限 ' + rule.title + ' 字'])
      else if (rule.titleMin && n && n < rule.titleMin) out.push(['warn', '标题', from + ' ' + n + ' 字，短标题建议 ' + rule.titleMin + '–' + rule.title + ' 字'])
    }
    const bodyLen = len(body)
    if (rule.body && bodyLen > rule.body) out.push(['error', '正文', (kind === 'video' ? '简介 ' : '正文 ') + bodyLen + ' 字，上限 ' + rule.body + ' 字'])
    if (rule.total) {
      const total = rule.joinTitle ? len([titles[0] || '', body].filter(Boolean).join('\n')) : len(titles[0]) + bodyLen
      if (total > rule.total && !(rule.body && bodyLen > rule.body))
        out.push(['error', '正文', (rule.joinTitle ? '作品描述（标题 + 正文）' : '标题与正文合计') + ' ' + total + ' 字，上限 ' + rule.total + ' 字'])
    }
    const topics = kind === 'video' ? splitTags(v.tags || d.videoTags) : bodyTopics(body)
    topicIssues(rule, topics, out)
    if (kind !== 'video') {
      const images = d.images || []
      if (rule.needImage && !images.length) out.push([rule.needImage, '配图', '图文需要至少 1 张配图'])
      if (rule.images && images.length > rule.images) out.push(['error', '配图', '配图 ' + images.length + ' 张，上限 ' + rule.images + ' 张'])
      const gifs = images.filter((i) => ext(i.mime, i.name) === 'gif').length
      if (rule.noGif && gifs) out.push(['error', '配图', gifs + ' 张 GIF，网页端不支持动图，请换成静态图或走手机端'])
      if (rule.imageFormats) {
        const bad = [...new Set(images.map((i) => ext(i.mime, i.name)).filter((e) => e && e !== 'gif' && !rule.imageFormats.includes(e)))]
        if (bad.length) out.push(['warn', '配图', bad.map(label).join('、') + ' 可能不被接受，支持 ' + rule.imageFormats.map(label).join('、')])
      }
      if (rule.imageSize) {
        const big = images.filter((i) => i.size > rule.imageSize).length
        if (big) out.push(['error', '配图', big + ' 张超过 ' + rule.imageSize / MB + ' MB'])
      }
    }
    return out.map(([level, field, message]) => ({ level, field, message }))
  }
  function check(d, platformIds) {
    return [...new Set(platformIds)]
      .map((platform) => ({ platform, issues: checkPlatform(d, platform) }))
      .filter((r) => r.issues.length)
  }
  const api = { RULES, check, checkPlatform, splitTags, bodyTopics }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.FatioRules = api
})(typeof window !== 'undefined' ? window : globalThis)
