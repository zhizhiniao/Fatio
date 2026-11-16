const { test } = require('node:test')
const assert = require('node:assert/strict')
const { QueueReconciler, publicationMatches } = require('../src/queue-reconcile.cjs')
const { Store } = require('../src/store.cjs')
const { Library } = require('../src/library.cjs')

const now = Date.now(), posted = Math.floor(now / 1000)
const job = { id: 'j', title: '6种图文类型，用对了才事半功倍！', body: '做事要有方式方法~\n做自媒体也是如此！', created: now - 3600000, due: now - 3600000 }
const work = { itemId: '123', title: job.title, publishedAt: posted, status: '已发布', url: 'https://www.example.com/post' }
const find = (jobs, items) => publicationMatches(jobs, items, now)
test('official publication matches use exact copy, including platform caption formatting and appended topics', () => {
  for (const title of [job.title, job.title+'。'+job.body+' #自媒体启动 #自媒体', job.title+'\n'+job.body, job.body]) {
    assert.equal(find([job],[{...work,title}]).length,1)
  }
  assert.equal(find([job],[{...work,title:job.title+'的另一篇文章'}]).length,0)
})
test('ambiguous tasks or posts, old publications, missing times, pending review and wrong receipts remain unlinked', () => {
  assert.equal(find([job,{...job,id:'other'}],[work]).length,0)
  assert.equal(find([job],[work,{...work,itemId:'456'}]).length,0)
  for (const row of [{publishedAt:posted-3601},{publishedAt:null},{status:'审核中'},{status:'草稿'}])
    assert.equal(find([job],[{...work,...row}]).length,0)
  assert.equal(find([{...job,receipt:'456'}],[work]).length,0)
  assert.equal(find([{...job,title:'测试',body:''}],[{...work,title:'测试'}]).length,0)
  assert.equal(find([{...job,receipt:'123'}],[{...work,title:'官方修改后的标题'}]).length,1)
})

test('queue check joins concurrent reads, scans later pages, leaves a failed account pending and never creates a task', async () => {
  const store = new Store(':memory:'), library = new Library(store)
  const wx = store.addAccount({ platform: 'wechat', identity: '123', name: '甲', mode: 'web' })
  const ks = store.addAccount({ platform: 'kuaishou', identity: '456', name: '乙', mode: 'web' })
  const draft = store.save({ title: job.title, body: job.body, targets: [wx.id, ks.id], assets: [], xText: '' })
  const ids = store.queue(draft.id, draft.revision, null, now - 3600000)
  for (const id of ids) store.transition(id, ['queued'], 'waiting')
  const official = { ...work, status: '已发表', url: 'https://mp.weixin.qq.com/s/example', itemId: 'https://mp.weixin.qq.com/s/example' }
  const reads = []
  const reconciler = new QueueReconciler(store, library, async (account, cursor) => {
    reads.push([account.id, cursor])
    if (account.id === ks.id) throw Error('请重新登录')
    return cursor === '0' ? { items: [], next: '10' } : { items: [official], next: null }
  }, () => {})
  const check = reconciler.check(true)
  assert.equal(reconciler.check(true), check)
  const result = await check
  assert.equal(result.linked, 1)
  assert.equal(result.remaining, 1)
  assert.deepEqual(result.errors, ['快手：请重新登录'])
  assert.equal(store.job(ids[0]).status, 'published')
  assert.equal(store.job(ids[0]).url, official.url)
  assert.equal(store.job(ids[1]).status, 'waiting')
  assert.equal(library.works(wx.id)[0].linkSource, '官方后台自动核对')
  assert.equal(library.works(wx.id)[0].draftId, draft.id)
  await reconciler.check()
  assert.equal(reads.length, 3)
  assert.equal(store.snapshot().jobs.length, 2)
  store.db.close()
})

test('automatic video checks reject a TikTok photo or B站 article with the same caption', () => {
  const now=Date.now(), created=now-10000, title='这是一条视频测试稿'
  const job={id:'pending',videoId:'clip',platform:'tiktok',created,due:created,title,body:''}
  const item={itemId:'123',status:'已发布',title,publishedAt:Math.floor(now/1000),url:'https://www.tiktok.com/@creator/photo/123'}
  assert.equal(publicationMatches([job],[item],now).length,0)
  assert.equal(publicationMatches([job],[{...item,url:'https://www.tiktok.com/@creator/video/123'}],now).length,1)
  assert.equal(publicationMatches([{...job,platform:'bilibili'}],[{...item,url:'https://www.bilibili.com/read/cv123'}],now).length,0)
  assert.equal(publicationMatches([{...job,platform:'bilibili'}],[{...item,url:'https://www.bilibili.com/video/BV123'}],now).length,1)
})

test('a manual mark from an older installation can be undone on the same job, but a native submit cannot', () => {
  const store = new Store(':memory:'), library = new Library(store)
  const account = store.addAccount({ platform:'douyin',name:'测试',identity:'1234',mode:'web' })
  const draft = store.save({title:'原任务',body:'稿件',targets:[account.id],assets:[],xText:''})
  const [id] = store.queue(draft.id,draft.revision,null)
  const mark = () => store.transition(id,['waiting'],'uncertain','本人已在平台手动发表，等待官方回执')
  store.transition(id,['queued'],'waiting')
  mark()
  assert.deepEqual(library.manualMarks(),[id])
  library.undoManualMark(id)
  assert.equal(store.job(id).status,'waiting')
  assert.deepEqual(store.queue(draft.id,draft.revision,null),[id])
  mark()
  store.db.prepare('INSERT INTO native_submits VALUES(?,?,?)').run(id,'1234',Date.now())
  assert.deepEqual(library.manualMarks(),[])
  assert.throws(() => library.undoManualMark(id),/提交记录/)
  assert.equal(store.job(id).status,'uncertain')
  store.db.close()
})
