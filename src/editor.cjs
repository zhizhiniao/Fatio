// Runs only inside the expected official editor. Keep all dependencies inside this function.
function prepareEditor({ account, job }) {
  const text = (node) => (node?.innerText ?? '').replace(/\r\n/g, '\n').trim()
  if (account.platform === 'xiaobot') {
    const expected = '/creator/' + account.identity + '/edit'
    if (
      location.origin !== 'https://xiaobot.net' ||
      location.pathname.replace(/\/$/, '') !== expected
    ) {
      return '请先登录并进入目标专栏的新内容页，再点「填入编辑器」。'
    }
    const title = document.querySelector('textarea[placeholder*="标题"],input[placeholder*="标题"]')
    const body = document.querySelector('.ProseMirror[contenteditable="true"]')
    if (!title || !body) return '未找到小报童标题或正文，可复制文案后手动粘贴。'
    // Refuse to overwrite media-only, structured or partially edited documents.
    const occupied = [...body.children].some(
      (el) => el.tagName !== 'P' || el.querySelector(':not(br)')
    )
    if (text(body) === job.body && title.value === job.title)
      return '文案已在编辑器中，请核对后发表。'
    if (text(body) || occupied || title.value) return '编辑器已有内容，已保留原稿。'
    body.focus()
    if (!document.execCommand('insertText', false, job.body)) return '正文填入失败，请手动粘贴。'
    const proto =
      title.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(title, job.title)
    title.dispatchEvent(new Event('input', { bubbles: true }))
    if (
      text(body).replace(/\n+/g, '\n') !== job.body.replace(/\n+/g, '\n') ||
      title.value !== job.title
    )
      return '请核对编辑器，正文或标题未完整回读。'
    return '已填入目标专栏，请在小报童确认发表。'
  }
  if (account.platform === 'x') {
    if (
      location.origin !== 'https://x.com' ||
      location.pathname !== '/compose/post' ||
      location.search
    )
      return '请进入 X 的空白新帖编辑器。'
    const handle = [
      ...document.querySelectorAll('[data-testid="SideNav_AccountSwitcher_Button"] span')
    ]
      .map((el) => el.textContent?.trim().toLowerCase())
      .find((s) => /^@[\w]+$/.test(s || ''))
    if (handle !== '@' + account.identity) return '当前 X 登录身份与目标账号不符或尚未识别。'
    const visible = (el) =>
      el.getClientRects().length &&
      getComputedStyle(el).visibility !== 'hidden' &&
      !el.closest('[aria-hidden="true"]')
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible)
    if (dialogs.length !== 1) return '未找到唯一的 X 新帖弹窗，请打开新帖后重试。'
    const scope = dialogs[0]
    const editors = [...scope.querySelectorAll('[contenteditable=true]')].filter(visible)
    if (editors.length !== 1 || !editors[0].closest('[data-testid="tweetTextarea_0"]'))
      return '当前编辑器不是唯一的新帖正文。'
    const editor = editors[0]
    if (
      scope.querySelector(
        '[data-testid="attachments"], [data-testid="pollOption_0"], [data-testid="tweetPhoto"]'
      )
    )
      return '编辑器已有附件，已保留原稿。'
    if (text(editor) === job.body) return '文案已在编辑器中，请核对后发表。'
    if (text(editor)) return '编辑器已有内容，已保留原稿。'
    editor.focus()
    document.execCommand('insertText', false, job.body)
    return text(editor) === job.body ? '已填入 X，请确认发表。' : 'X 正文未完整回读，请核对编辑器。'
  }
  return '请复制文案，在微博核对登录账号后发表。'
}
module.exports = { prepareEditor }
