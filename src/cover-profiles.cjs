const sizes = {
  wide: {width:1600,height:900,label:'横屏 16:9'},
  portrait: {width:1080,height:1920,label:'全屏 9:16'},
  feed: {width:1440,height:1080,label:'横卡 4:3'},
  card: {width:1080,height:1440,label:'竖卡 3:4'},
  bili: {width:1600,height:1000,label:'横卡 16:10'}
}
// These are JAStudio's production presets. Slot availability is verified in the editor.
const profiles = {
  channels:{wide:'feed',portrait:'card'}, douyin:{wide:'wide',portrait:'card'},
  xhs:{portrait:'card'}, kuaishou:{portrait:'card'},
  bilibili:{wide:'bili'}, tiktok:{portrait:'portrait'}
}
function submissionCovers(all, platform, preference) {
  const slots = profiles[platform] || {}
  const chosen = {}
  for (const [slot, key] of Object.entries(slots)) {
    if (all[key] || all[slot]) chosen[slot] = all[key] || all[slot]
  }
  if (preference && !slots[preference] && all[preference]) {
    return {[preference]:all[preference]}
  }
  if (!Object.keys(chosen).length) {
    if (all.wide) chosen.wide = all.wide
    else if (all.portrait || all.card) chosen.portrait = all.portrait || all.card
  }
  return chosen
}
module.exports = { sizes, profiles, submissionCovers }
