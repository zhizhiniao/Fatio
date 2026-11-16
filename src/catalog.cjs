const platforms = {
  douyin: {
    label: '抖音',
    mark: '抖',
    hint: '抖音号',
    home: 'https://creator.douyin.com/',
    domains: ['douyin.com'],
    article: 'https://creator.douyin.com/creator-micro/content/upload?default-tab=3',
    video: 'https://creator.douyin.com/creator-micro/content/upload'
  },
  kuaishou: {
    label: '快手',
    mark: '快',
    hint: '快手号',
    home: 'https://cp.kuaishou.com/',
    domains: ['kuaishou.com'],
    article: 'https://cp.kuaishou.com/article/publish/video?tabType=2',
    video: 'https://cp.kuaishou.com/article/publish/video?tabType=1'
  },
  tiktok: {
    label: 'TikTok',
    mark: 'Tk',
    hint: 'TikTok 用户名',
    home: 'https://www.tiktok.com/tiktokstudio',
    domains: ['tiktok.com'],
    video: 'https://www.tiktok.com/tiktokstudio/upload'
  },
  bilibili: {
    label: 'B站',
    mark: 'B',
    hint: '个人主页数字 UID',
    home: 'https://member.bilibili.com/platform/home',
    domains: ['bilibili.com'],
    article: 'https://member.bilibili.com/york/read-editor',
    video: 'https://member.bilibili.com/platform/upload/video/frame'
  },
  xhs: {
    label: '小红书',
    mark: '红',
    hint: '小红书号',
    home: 'https://creator.xiaohongshu.com/',
    domains: ['xiaohongshu.com'],
    article: 'https://creator.xiaohongshu.com/publish/publish?target=image',
    video: 'https://creator.xiaohongshu.com/publish/publish?target=video'
  },
  channels: {
    label: '微信视频号',
    mark: '视',
    hint: '视频号帐号或唯一标识',
    home: 'https://channels.weixin.qq.com/platform',
    domains: ['channels.weixin.qq.com', 'weixin.qq.com'],
    video: 'https://channels.weixin.qq.com/platform/post/create'
  },
  wechat: {
    label: '微信公众号',
    mark: '公',
    hint: '公众号原始 ID 或微信号',
    home: 'https://mp.weixin.qq.com/',
    domains: ['mp.weixin.qq.com'],
    externalOrigins: ['https://developers.weixin.qq.com'],
    article: 'https://mp.weixin.qq.com/'
  },
  toutiao: {
    label: '今日头条',
    mark: '头',
    hint: '头条号 ID',
    home: 'https://mp.toutiao.com/',
    domains: ['toutiao.com'],
    article: 'https://mp.toutiao.com/profile_v4/graphic/publish'
  },
  zhihu: {
    label: '知乎',
    mark: '知',
    hint: '个人主页标识',
    home: 'https://www.zhihu.com/creator',
    domains: ['zhihu.com'],
    article: 'https://zhuanlan.zhihu.com/write'
  },
  x: {
    label: 'X',
    mark: '𝕏',
    hint: 'X 用户名',
    home: 'https://x.com/',
    domains: ['x.com', 'twitter.com'],
    article: 'https://x.com/compose/post'
  },
  xiaobot: {
    label: '小报童',
    mark: '报',
    hint: '专栏链接或 ID',
    home: 'https://xiaobot.net/creator',
    domains: ['xiaobot.net'],
    article: 'https://xiaobot.net/creator'
  },
  weibo: {
    label: '微博',
    mark: '微',
    hint: '微博数字 UID',
    home: 'https://weibo.com/',
    domains: ['weibo.com', 'weibo.cn', 'sina.com.cn'],
    article: 'https://weibo.com/'
  }
}
function publicCatalog() {
  return Object.fromEntries(
    Object.entries(platforms).map(([key, p]) => [
      key,
      {
        label: p.label,
        mark: p.mark,
        hint: p.hint,
        article: !!p.article,
        video: !!p.video,
        coverSlots: require('./cover-profiles.cjs').profiles[key],
        login: ['douyin', 'xhs', 'kuaishou', 'bilibili', 'tiktok', 'wechat', 'channels'].includes(
          key
        ),
        syncWorks: [
          'douyin',
          'xhs',
          'kuaishou',
          'bilibili',
          'tiktok',
          'wechat',
          'channels'
        ].includes(key)
      }
    ])
  )
}
module.exports = { platforms, publicCatalog }
