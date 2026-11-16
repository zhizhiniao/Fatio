// One-time vectorization of the approved artwork. The native SVG is the build source.
const fs = require('node:fs')
const path = require('node:path')
const { createCanvas, loadImage } = require('@napi-rs/canvas')

async function trace() {
  const root = path.resolve(__dirname, '..')
  const input = await loadImage(path.join(root, 'docs/brand/fatiao-v01/fatiao-fatio-logo-concept.png'))
  const canvas = createCanvas(input.width, input.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(input, 0, 0)
  const { data } = ctx.getImageData(0, 0, input.width, input.height)
  const white = (x, y) => {
    if (x < 540 || x >= 960 || y < 160 || y >= 620) return false
    const i = (y * input.width + x) * 4
    return data[i] > 220 && data[i + 1] > 210 && data[i + 2] > 200
  }
  const edges = new Map()
  const edge = (x, y, nx, ny) => edges.set(x + ',' + y, [nx, ny])
  for (let y = 160; y < 620; y++) for (let x = 540; x < 960; x++) {
    if (!white(x, y)) continue
    if (!white(x, y - 1)) edge(x, y, x + 1, y)
    if (!white(x + 1, y)) edge(x + 1, y, x + 1, y + 1)
    if (!white(x, y + 1)) edge(x + 1, y + 1, x, y + 1)
    if (!white(x - 1, y)) edge(x, y + 1, x, y)
  }
  const contours = []
  while (edges.size) {
    const start = edges.keys().next().value
    let key = start
    const points = []
    do {
      points.push(key.split(',').map(Number))
      const next = edges.get(key)
      edges.delete(key)
      if (!next) break
      key = next.join(',')
    } while (key !== start)
    contours.push(points)
  }
  const points = contours.sort((a, b) => b.length - a.length)[0]
  if (!points || points.length < 1000) throw Error('Approved spring silhouette not found')
  const distance = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
  }
  function simplify(pts) {
    if (pts.length <= 2) return pts
    let max = 0, split = 0
    for (let i = 1; i < pts.length - 1; i++) {
      const d = distance(pts[i], pts[0], pts[pts.length - 1])
      if (d > max) { max = d; split = i }
    }
    return max > 1.35
      ? [...simplify(pts.slice(0, split + 1)).slice(0, -1), ...simplify(pts.slice(split))]
      : [pts[0], pts[pts.length - 1]]
  }
  const half = Math.floor(points.length / 2)
  const reduced = [...simplify(points.slice(0, half + 1)).slice(0, -1), ...simplify([...points.slice(half), points[0]]).slice(0, -1)]
  const coords = reduced.map(([x, y]) => [2 + (x - 485) * 60 / 563, 2 + (y - 105) * 60 / 561])
  const point = p => p.map(v => v.toFixed(3)).join(' ')
  let shape = 'M' + point(coords[0])
  for (let i = 0; i < coords.length; i++) {
    const prev = coords[(i - 1 + coords.length) % coords.length], current = coords[i]
    const next = coords[(i + 1) % coords.length], after = coords[(i + 2) % coords.length]
    const a = current.map((v, axis) => v + (next[axis] - prev[axis]) / 6)
    const b = next.map((v, axis) => v - (after[axis] - current[axis]) / 6)
    shape += ' C' + point(a) + ' ' + point(b) + ' ' + point(next)
  }
  fs.writeFileSync(path.join(root, 'ui/fatio.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  <rect x="2" y="2" width="60" height="60" rx="13" fill="#d97757"/>\n  <path fill="#faf9f5" d="${shape}Z"/>\n</svg>\n`)
  console.log('Approved spring traced:', reduced.length, 'points')
}
trace().catch(error => { console.error(error); process.exitCode = 1 })
