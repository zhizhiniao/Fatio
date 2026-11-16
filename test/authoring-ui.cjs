const { _electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ja-authoring-'))
  const library = path.join(dir, 'media')
  const project = path.join(dir, 'articles', 'projects', '一期')
  const note = path.join(dir, 'vault', '04_图文工作台', '01_选题', '一期')
  for (const p of [library, project, note])
    await fs.mkdir(p, { recursive: true })
  await fs.copyFile(
    path.join(__dirname, 'fixtures', 'clip.mp4'),
    path.join(library, '镜头练习.mp4')
  )
  await fs.writeFile(
    path.join(project, '小红书发布文案.txt'),
    '标题\n图文测试\n\n正文\n第一段素材文字'
  )
  await fs.writeFile(
    path.join(note, '主稿.md'),
    '---\ntype: content\n---\n# 仓库标题\n\n仓库正文'
  )
  const env = { ...process.env, JASTUDIO_TEST_DATA: path.join(dir, 'profile') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    args: [path.resolve(__dirname, '..')],
    env
  })
  try {
    const p = await app.firstWindow()
    await p.waitForSelector('#overview .desk-metrics')
    async function pickRoot(folder) {
      await app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [folder]
        })
      }, folder)
      await p.locator('[data-desk=bind-source]').click()
    }
    await p.locator('nav [data-nav=write]').click()
    await pickRoot(path.join(dir, 'articles'))
    await p.locator('.source-item').click()
    await p.waitForFunction(
      () => document.querySelector('#title').value === '图文测试'
    )
    await p.locator('[data-desk=source-kind][data-key=vault]').click()
    await pickRoot(path.join(dir, 'vault'))
    await p.locator('.source-item').click()
    await p.waitForFunction(
      () => document.querySelector('#body').value === '仓库正文'
    )
    await p.fill('#body', '工作副本已修改')
    await p.locator('[data-action=save-current]').click()
    assert.match(
      await fs.readFile(path.join(note, '主稿.md'), 'utf8'),
      /仓库正文$/
    )
    await p.locator('nav [data-nav=video]').click()
    await pickRoot(library)
    await p.locator('.source-item').click()
    await p.waitForFunction(
      () => document.getElementById('clip-player').readyState >= 2
    )
    await p.waitForSelector('#cover-frames button')
    await p.locator('#cover-frames button').last().click()
    await p.waitForFunction(
      async () =>
        Object.keys(
          (await studio.snapshot()).drafts.find((d) => d.kind === 'video')
            ?.covers || {}
        ).length === 1
    )
    const a = await p.evaluate(() =>
      studio['add-account']({
        platform: 'douyin',
        mode: 'web',
        identity: 'fixture-user',
        name: '演示账号'
      })
    )
    await p.locator('nav [data-nav=video]').click()
    await p.locator('#targets input[value="' + a.id + '"]').check()
    await p.locator('#enqueue').click()
    await p.waitForFunction(async () =>
      (await studio.snapshot()).jobs.some((j) => j.coverId)
    )
    const snapshot = await p.evaluate(() => studio.snapshot())
    const job = snapshot.jobs.find((j) => j.coverId)
    assert.equal(
      job.coverId,
      snapshot.drafts.find((d) => d.id === job.draftId).coverFormats[job.videoId].wide
    )
    await p.locator('nav [data-nav=video]').click()
    await p.locator('#cover-frames button').first().click()
    await p.locator('[data-desk=assist-body]').click()
    await p.locator('[data-desk=assist-tab][data-key=risk]').click()
    await p.fill('#body', '测试扫码领取文案')
    await p.locator('[data-desk=locate]').click()
    assert.equal(
      await p
        .locator('#body')
        .evaluate((n) => n.value.slice(n.selectionStart, n.selectionEnd)),
      '扫码领取'
    )
    assert.equal(
      (await p.evaluate(() => studio.snapshot())).jobs[0].coverId,
      job.coverId
    )
    await p.fill('#title','新封面测试')
    await p.locator('#cover-title').check()
    await p.locator('[data-desk=make-covers]').click()
    await p.waitForFunction(old => {
      const img = document.querySelector('#cover-formats [data-key=wide] img')
      return img?.complete && !img.src.endsWith(old.coverId)
    },job)
    await p.locator('#toast').filter({hasText:'各平台封面已保存'}).waitFor()
    await p.locator('[data-desk=apply-pending-covers]').click()
    await p.locator('#toast').filter({hasText:'已更新 1 项'}).waitFor()
    const updated = (await p.evaluate(() => studio.snapshot())).jobs
    assert.equal(updated.length,snapshot.jobs.length)
    assert.notEqual(updated.find(j=>j.id===job.id).coverId,job.coverId)
    assert.equal(updated.find(j=>j.id===job.id).title,job.title)
    console.log(
      'PASS directory imports, local copy, streaming video, frame capture, immutable queued cover and risk location'
    )
  } finally {
    await app.close()
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 150
    })
  }
}
run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
