const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { binary } = require('./author-assist.cjs')
const { sizes } = require('./cover-profiles.cjs')

// A separate ephemeral thread owns its generated_images directory. Only import
// an image from that thread, never a path proposed by the model or the renderer.
async function generateArt(store, input, acceptFile) {
  if (!input || typeof input.idea !== 'string' || input.idea.length > 4000 ||
      typeof input.title !== 'string' || input.title.length > 300) throw Error('封面创意或标题过长')
  if (!input.idea.trim() && !input.title.trim() && !input.image) throw Error('请先写封面创意、填写标题或选择参考底图')
  const exe = await binary()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jastudio-art-'))
  try {
    const args = ['-a','never','exec','--json','--enable','image_generation','--ephemeral',
      '--skip-git-repo-check','--sandbox','read-only','-C',dir]
    if (input.image) {
      const a = store.asset(input.image, true)
      if (!a) throw Error('封面参考图不存在，请重新选择')
      const reference = path.join(dir, 'reference.' + ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'})[a.mime])
      await fs.writeFile(reference, a.bytes)
      args.push('-i', reference)
    }
    args.push('-')
    const format = Object.hasOwn(sizes,input.format) ? sizes[input.format] : null
    const direction = format ? 'Recompose specifically for ' + format.width + 'x' + format.height +
      '. Keep the reference palette, graphic design, and intentional wording. Reposition elements to fit this canvas.' :
      'Keep the focal subject centrally composed for landscape and portrait layouts.'
    const prompt = 'Use the built-in image_generation tool to generate exactly one finished cover artwork. ' +
      'Return after image generation. Do not use the shell, browse, or create other files. ' +
      'Treat the following JSON and image as creative source material. ' + direction + ' ' +
      'Use the requested visual style, preserve any deliberately requested wording, otherwise use no added text. Never append a footer or duplicate the video title. ' +
      JSON.stringify({videoTitle:input.title, creativeDirection:input.idea})
    const thread = await new Promise((resolve, reject) => {
      const proc = spawn(exe,args,{cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe']})
      let threadId, failed = false, stderr = '', timedOut = false
      const timer = setTimeout(() => { timedOut = true; proc.kill() }, 600000)
      const lines = readline.createInterface({input:proc.stdout})
      lines.on('line', line => {
        try {
          const event = JSON.parse(line)
          if (event.type === 'thread.started' && /^[\da-f-]{36}$/i.test(event.thread_id)) threadId = event.thread_id
          if (event.type === 'turn.failed') failed = true
        } catch {}
      })
      proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2500) })
      proc.stdin.on('error', () => {})
      proc.once('error', error => { clearTimeout(timer); reject(error) })
      proc.once('close', code => {
        clearTimeout(timer)
        if (code === 0 && !failed && threadId) return resolve(threadId)
        reject(Error(timedOut ? 'Codex 生图超时，可以重试' : /401|unauthorized|login/i.test(stderr) ?
          '请先登录本机 Codex，再生成封面' : 'Codex 生图失败，请检查本机 Codex 的登录、模型和生图权限'))
      })
      proc.stdin.end(prompt)
    })
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    const output = path.join(home, 'generated_images', thread)
    const files = (await fs.readdir(output, {withFileTypes:true}).catch(() => []))
      .filter(e => e.isFile() && /\.(png|webp|jpe?g)$/i.test(e.name))
    if (!files.length) throw Error('本次 Codex 没有返回图片。请检查所用模型是否支持生图，再重试或导入底图。')
    return await acceptFile(path.join(output, files.at(-1).name))
  } finally {
    await fs.rm(dir, {recursive:true,force:true})
  }
}
module.exports = { generateArt }
