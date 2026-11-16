const { _electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

async function run() {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatio-postvela-ui-'))
  const root=process.env.FATIO_POSTVELA_ROOT || path.join(dir,'source')
  if(!process.env.FATIO_POSTVELA_ROOT) {
    const folder=path.join(root,'projects','本期','动态导出','演示')
    await fs.mkdir(path.join(folder,'page-002.pvt'),{recursive:true})
    const { createCanvas }=require('@napi-rs/canvas')
    const canvas=createCanvas(108,144),ctx=canvas.getContext('2d')
    ctx.fillStyle='#ef8060';ctx.fillRect(0,0,108,144)
    const png=canvas.toBuffer('image/png')
    for(const name of ['page-001.png','page-002.png'])await fs.writeFile(path.join(folder,name),png)
    await fs.writeFile(path.join(folder,'page-002.pvt/photo.JPG'),canvas.toBuffer('image/jpeg'))
    await fs.copyFile(path.join(__dirname,'fixtures/clip.mp4'),path.join(folder,'page-002.pvt/video.MOV'))
    await fs.copyFile(path.join(__dirname,'fixtures/clip.mp4'),path.join(folder,'page-002-预览.mp4'))
    await fs.writeFile(path.join(folder,'page-002.pvt/metadata.plist'),'fixture')
    await fs.writeFile(path.join(folder,'发布文案.txt'),'完整标题\n\n正文 #标签')
    await fs.writeFile(path.join(folder,'图文索引.md'),'# 图集')
  }
  const env={...process.env,FATIO_TEST_DATA:path.join(dir,'profile')}
  delete env.ELECTRON_RUN_AS_NODE
  const app=await _electron.launch({args:[path.resolve(__dirname,'..')],env})
  try {
    const page=await app.firstWindow()
    await page.waitForSelector('#overview .desk-metrics')
    await page.locator('nav [data-nav=write]').click()
    await page.locator('[data-desk=source-kind][data-key=postvela]').click()
    await app.evaluate(({dialog},root)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]})},root)
    await page.locator('[data-desk=bind-source]').click()
    await page.locator('.source-item').first().click()
    await page.waitForSelector('.postvela-pages video')
    const initial=await page.evaluate(()=>studio.snapshot())
    const media=page.locator('.postvela-pages video').first()
    await media.evaluate(v=>v.play())
    await page.waitForFunction(()=>document.querySelector('.postvela-pages video').currentTime>0.3)
    await page.locator('[data-desk=postvela-title]').click()
    const title=await app.evaluate(({clipboard})=>clipboard.readText())
    assert.equal(title,await page.locator('.postvela-pack h3').textContent())
    for(const width of [390,1200]) {
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width)
      await page.waitForTimeout(150)
      assert.ok(await page.locator('#dialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1))
    }
    assert.equal((await page.evaluate(()=>studio.snapshot())).jobs.length,initial.jobs.length)
    assert.equal((await page.evaluate(()=>studio.snapshot())).drafts.length,initial.drafts.length)
    if(process.env.FATIO_POSTVELA_ROOT) {
      await fs.mkdir(path.join(__dirname,'../docs/验收'),{recursive:true})
      await page.screenshot({path:path.join(__dirname,'../docs/验收/PostVela-Live图集.png')})
    }
    console.log(JSON.stringify({pages:await page.locator('.postvela-pages figure').count(),live:await page.locator('.postvela-pages video').count(),played:true,copyVerified:true,noJobsCreated:true,noDraftsCreated:true,responsive:true}))
  } finally {
    await app.close()
    if(!path.basename(dir).startsWith('fatio-postvela-ui-') || path.dirname(dir)!==os.tmpdir())throw Error('Unexpected test path')
    await fs.rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:150})
  }
}
run().catch(e=>{console.error(e);process.exitCode=1})
