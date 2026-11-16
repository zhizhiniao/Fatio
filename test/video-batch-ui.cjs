const { _electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(),'ja-batch-video-'))
  const env = { ...process.env, JASTUDIO_TEST_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const root = path.resolve(__dirname,'..'), exe = env.JASTUDIO_INSTALLED_EXE
  const app = await _electron.launch(exe ? {executablePath:exe,args:[],cwd:profile,env} : {args:[root],env})
  try {
    const p = await app.firstWindow()
    await p.waitForSelector('#overview .desk-metrics')
    const accounts = await p.evaluate(async () => Promise.all(['12345','67890'].map((identity,i) =>
      studio['add-account']({name:'测试账号' + (i + 1),identity,platform:'douyin',mode:'web'}))))
    await app.evaluate(async ({session,dialog}, {accounts,clip}) => {
      dialog.showOpenDialog = async () => ({canceled:false,filePaths:[clip]})
      globalThis.batchUploads = {}
      for (const [i,account] of accounts.entries()) {
        const s = session.fromPartition('persist:ja-' + account.id)
        await s.protocol.handle('https', req => {
          const u = new URL(req.url)
          const json = obj => new Response(JSON.stringify(obj), {headers:{'Content-Type':'application/json'}})
          if (u.pathname.includes('/user/info')) return json({status_code:0,uid:i ? '99999' : account.identity,
            user_profile:{nick_name:account.name,unique_id:i ? 'other' : account.identity}})
          if (u.pathname.includes('work_list')) return json({status_code:0,aweme_list:[],has_more:0})
          if (u.pathname === '/file-selected') {
            globalThis.batchUploads[account.id] = (globalThis.batchUploads[account.id] || 0) + 1
            return json({ok:true})
          }
          return new Response('<input type="file" accept="video/mp4" onchange="fetch(\'/file-selected\')"><input placeholder="标题"><textarea placeholder="简介"></textarea>' +
            '<button type="button" onclick="document.querySelector(\'section\').hidden=false">编辑封面</button><section hidden role="dialog" aria-label="视频封面"><button role="tab" onclick="this.setAttribute(\'aria-selected\',\'true\');document.querySelector(\'#slot\').innerHTML=\'<input type=file accept=image/jpeg aria-label=封面>\'">上传封面</button><div id="slot"></div><button type="button" onclick="this.parentElement.hidden=true;document.querySelector(\'textarea\').value=\'本人已微调\'">确认</button></section>',
            {headers:{'Content-Type':'text/html;charset=utf-8'}})
        })
      }
    }, {accounts,clip:path.join(root,'test/fixtures/clip.mp4')})
    await p.locator('nav [data-nav=video]').click()
    await p.locator('#video-drop').click()
    await p.fill('#title','两个账号的隔离视频')
    await p.fill('#body','平台核对')
    for (const account of accounts) await p.locator('#targets input[value="' + account.id + '"]').check()
    await p.locator('#sync-video').click()
    await p.locator('#jobs .sync-stage[data-phase=ready]').waitFor()
    await p.locator('#jobs .sync-stage[data-phase=partial]').waitFor()
    const state = await p.evaluate(() => studio.snapshot())
    const ok = state.jobs.find(j => j.accountId === accounts[0].id)
    const bad = state.jobs.find(j => j.accountId === accounts[1].id)
    assert.equal(state.jobs.length,2)
    assert.equal(state.videoProgress[ok.id].phase,'ready')
    assert.equal(state.videoProgress[bad.id].phase,'partial')
    assert.deepEqual(await app.evaluate(()=>globalThis.batchUploads),{[accounts[0].id]:1})
    await p.locator('[data-desk=await-receipt][data-key="' + ok.id + '"]').click()
    await p.locator('[data-desk=undo-manual][data-key="' + ok.id + '"]').click()
    await p.locator('#jobs [data-action=open-only][data-id="' + ok.id + '"]').waitFor()
    const result = await p.evaluate(()=>studio.snapshot())
    assert.equal(result.jobs.length,2)
    assert.equal(result.jobs.find(j=>j.id===ok.id).status,'waiting')
    assert.deepEqual(await app.evaluate(()=>globalThis.batchUploads),{[accounts[0].id]:1})
    for (const w of app.windows().filter(w => w.url().includes('/creator-micro/content/upload'))) await w.close()
    await p.locator('nav [data-nav=video]').click()
    await p.locator('#targets input[value="' + accounts[1].id + '"]').uncheck()
    await p.fill('#video-tags','共用')
    await p.locator('#variants summary').click()
    await p.fill('#variant-tags','本平台')
    await p.selectOption('#variant-cover','wide')
    await p.locator('[data-desk=make-covers]').click()
    await p.waitForFunction(() => document.querySelectorAll('#cover-formats img').length === 2)
    await p.locator('#sync-video').click()
    await p.getByText('简介已有其他内容，请在后台核对',{exact:true}).waitFor()
    const window = app.windows().find(w => w.url().includes('/creator-micro/content/upload'))
    assert.equal(await window.locator('#slot input').evaluate(n=>n.files[0].name),'横版封面.jpg')
    assert.equal(await window.locator('textarea').inputValue(),'本人已微调')
    assert.equal(await window.locator('input[type=file][accept="video/mp4"]').evaluate(n=>n.files.length),1)
    await window.locator('textarea').fill('')
    await p.locator('#jobs [data-action=open]').filter({hasText:'重新带入'}).click()
    await p.getByText('视频、文案和封面已带入，待审核',{exact:true}).waitFor()
    assert.equal(await window.locator('textarea').inputValue(),'平台核对\n#本平台')
    assert.equal(await app.evaluate((_,account)=>globalThis.batchUploads[account],accounts[0].id),2)
    console.log('PASS two-account one-click handoff, isolated failure, persistent sync history and undo without resending')
  } finally {
    await app.close()
    await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:120})
  }
}
run().catch(e=>{console.error(e);process.exitCode=1})
