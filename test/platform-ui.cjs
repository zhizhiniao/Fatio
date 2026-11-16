const { _electron } = require('playwright')
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ja-platform-')),
    exe = process.env.JASTUDIO_INSTALLED_EXE
  const env = { ...process.env, JASTUDIO_TEST_DATA: dir }
  delete env.ELECTRON_RUN_AS_NODE
  if (exe) env.PATH = path.join(process.env.SystemRoot, 'System32')
  const app = await _electron.launch(
    exe ? { executablePath: exe, args: [], cwd: dir, env } : { args: [root], env }
  )
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('#overview .metrics')
    for (const [platform, url] of [
      ['tiktok', 'https://www.tiktok.com/@studio/video/7333333333333333333'],
      ['kuaishou', 'https://www.kuaishou.com/short-video/ksitem'],
      ['xhs', 'https://www.xiaohongshu.com/explore/aabbcc']
    ]) {
      const a = await page.evaluate(
        (p) => studio['add-account']({ platform: p, identity: 'studio', mode: 'web', name: p }),
        platform
      )
      await app.evaluate(
        ({ session }, { id, platform }) => {
          const s = session.fromPartition('persist:ja-' + id)
          s.protocol.handle('https', async (req) => {
            const fixtures = {
              tiktok:
                '<script type="application/json" id="__UNIVERSAL_DATA_FOR_REHYDRATION__">' +
                JSON.stringify({
                  __DEFAULT_SCOPE__: {
                    'webapp.video-detail': {
                      itemInfo: {
                        itemStruct: {
                          id: '7333333333333333333',
                          desc: 'TikTok 作品',
                          author: { uniqueId: 'studio' },
                          stats: { playCount: 35, diggCount: 1 }
                        }
                      }
                    }
                  }
                }) +
                '</script>',
              xhs: '<script>window.__INITIAL_STATE__={note:{noteDetailMap:{aabbcc:{note:{noteId:"aabbcc",title:"笔记",user:{userId:"studio"},interactInfo:{likedCount:35,collectedCount:0}}}}}}</script>',
              kuaishou:
                '<script>window.__APOLLO_STATE__={defaultClient:{ROOT_QUERY:{visionVideoDetail:{photo:{id:"ksitem",caption:"快手作品",viewCount:35},author:{id:"studio"}}}}}</script>'
            }
            return new Response(fixtures[platform], {
              headers: { 'Content-Type': 'text/html;charset=utf-8' }
            })
          })
        },
        { id: a.id, platform }
      )
      await page.evaluate(([id, url]) => studio['lookup-work'](id, url), [a.id, url])
      const w = await page.evaluate(
        async (id) => (await studio.insights()).native.find((w) => w.accountId === id),
        a.id
      )
      assert.equal(platform === 'xhs' ? w.likes : w.views, 35)
      assert.equal(w.shares, null)
      console.log(
        'PASS embedded ' +
          platform +
          ' authorized identity/work shape → independent library (fixture)'
      )
    }
  } catch (e) {
    console.error('Platform test failed:', e.message)
    throw e
  } finally {
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((w) => !w.webContents.getURL().startsWith('file:'))
          .forEach((w) => w.destroy())
      )
      .catch(() => {})
    await app.close()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
run().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
