const fs = require('node:fs')
const path = require('node:path')
const { createCanvas, loadImage } = require('@napi-rs/canvas')

async function buildBrand() {
  const ui = path.resolve(__dirname, '../ui')
  const svg = await loadImage(fs.readFileSync(path.join(ui, 'fatio.svg')))
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = []
  for (const size of [...sizes, 512]) {
    const canvas = createCanvas(size, size)
    canvas.getContext('2d').drawImage(svg, 0, 0, size, size)
    const png = canvas.toBuffer('image/png')
    if (size === 512) fs.writeFileSync(path.join(ui, 'fatio.png'), png)
    else images.push(png)
  }
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  for (let i = 0; i < sizes.length; i++) {
    const at = 6 + i * 16
    header[at] = header[at + 1] = sizes[i] === 256 ? 0 : sizes[i]
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(images[i].length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += images[i].length
  }
  fs.writeFileSync(path.join(ui, 'fatio.ico'), Buffer.concat([header, ...images]))
  console.log('Fatio icons generated: SVG, PNG 512, ICO ' + sizes.join('/'))
}
if (require.main === module) buildBrand().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { buildBrand }
