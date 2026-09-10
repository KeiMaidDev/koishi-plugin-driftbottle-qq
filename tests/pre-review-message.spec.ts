import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPendingSubmissionReceipt,
  buildPreReviewAdminBundle,
  buildPreReviewNotifyPrompt,
  buildPreReviewResultPush,
  buildPreReviewWithdrawListText,
  buildPreReviewWithdrawSuccess,
  buildQQWithdrawCommandInput,
  buildRejectReasonPrompt,
  buildSubmissionSummary,
  PRE_REVIEW_MUTE_VALUE,
  PRE_REVIEW_NOTIFY_VALUE,
  PRE_REVIEW_WITHDRAW_LIST_LIMIT,
  REJECT_REASON_SKIP_VALUE,
  WITHDRAW_SUBMISSION_BUTTON_VALUE,
  type SubmissionContentLike,
} from '../src/message'

function makeContent(overrides: Partial<SubmissionContentLike> = {}): SubmissionContentLike {
  return {
    text: '测试投稿内容',
    title: null,
    image: null,
    audio: null,
    ...overrides,
  }
}

test('submission summary prefers text and degrades to media markers', () => {
  assert.equal(buildSubmissionSummary(makeContent()), '测试投稿内容')
  assert.equal(
    buildSubmissionSummary(makeContent({ text: '长'.repeat(60) })),
    '长'.repeat(50) + '…',
  )
  assert.equal(buildSubmissionSummary(makeContent({ text: null, title: '标题' })), '标题')
  assert.equal(buildSubmissionSummary(makeContent({ text: null, audio: ['file:///a.silk'] })), '[音频]')
  assert.equal(buildSubmissionSummary(makeContent({ text: null, image: ['file:///a.jpg'] })), '[图片]')
  assert.equal(buildSubmissionSummary(makeContent({ text: null })), '[空投稿]')
})

test('admin push carries full text without ellipsis truncation', () => {
  // 管理员私信推送需要完整内容供预审判断，不能沿用面板摘要的 50 字截断
  const longText = '长'.repeat(80)
  const bundle = buildPreReviewAdminBundle({
    pendingId: 9,
    authorId: 'author9',
    summary: buildSubmissionSummary(makeContent({ text: longText })),
    fullText: longText,
  }, 'qq')
  const markdown = bundle.primary.attrs.markdown.content as string
  assert.equal(markdown.includes('待审编号：9'), true)
  assert.equal(markdown.includes(longText), true, 'QQ markdown 应包含完整 80 字内容')
  assert.equal(markdown.includes('…'), false, '不应出现省略号截断')

  const plain = buildPreReviewAdminBundle({
    pendingId: 9,
    authorId: 'author9',
    summary: buildSubmissionSummary(makeContent({ text: longText })),
    fullText: longText,
  }, 'onebot')
  const fallbackText = String(plain.fallback.children[0].attrs.content)
  assert.equal(fallbackText.includes(longText), true, '纯文本推送应包含完整内容')
})

test('admin push falls back to summary markers when there is no text', () => {
  // 无文本投稿（纯图片/音频）时用媒体标记，且完整内容字段缺省时退回摘要
  const bundle = buildPreReviewAdminBundle({
    pendingId: 11,
    authorId: 'author11',
    summary: buildSubmissionSummary(makeContent({ text: null, image: ['file:///a.jpg'] })),
  }, 'qq')
  const markdown = bundle.primary.attrs.markdown.content as string
  assert.equal(markdown.includes('[图片]'), true)
})

test('pending receipt includes pending number and withdraw button but never a bottle id', async () => {
  for (const platform of ['qq', 'onebot']) {
    const bundle = buildPendingSubmissionReceipt(3, '图文瓶', platform)
    const fallbackText = bundle.fallback.children[0].attrs.content as string
    assert.equal(fallbackText.includes('待审编号：3'), true)
    assert.equal(fallbackText.includes('瓶子ID'), false)
    assert.equal(fallbackText.includes('ID为'), false)

    if (platform === 'qq') {
      const markdown = bundle.primary.attrs.markdown.content as string
      assert.equal(markdown.includes('待审编号：3'), true)
      assert.equal(markdown.includes('瓶子ID'), false)
      const rows = bundle.primary.attrs.keyboard.content.rows
      assert.equal(
        rows.some((row: any) => row.buttons.some((button: any) => button.action.data === WITHDRAW_SUBMISSION_BUTTON_VALUE)),
        true,
      )
    } else {
      const fallbackText = String(bundle.fallback.children[0].attrs.content)
      assert.equal(fallbackText.includes('撤回投稿'), true)
    }
  }
})

test('notify prompt exposes subscribe and mute buttons', () => {
  const prompt = buildPreReviewNotifyPrompt('qq')
  const rows = prompt.attrs.keyboard.content.rows
  const values = rows.flatMap((row: any) => row.buttons.map((button: any) => button.action.data))
  assert.deepEqual(values, [PRE_REVIEW_NOTIFY_VALUE, PRE_REVIEW_MUTE_VALUE])

  const fallback = buildPreReviewNotifyPrompt('onebot')
  assert.equal(String(fallback.attrs.content).includes('预审结果'), true)
})

test('admin notice carries pending number, summary and approve/reject buttons', () => {
  const bundle = buildPreReviewAdminBundle({
    pendingId: 7,
    authorId: 'author7',
    summary: '不良内容测试',
  }, 'qq')
  const markdown = bundle.primary.attrs.markdown.content as string
  assert.equal(markdown.includes('待审编号：7'), true)
  assert.equal(markdown.includes('author7'), true)
  assert.equal(markdown.includes('不良内容测试'), true)

  const rows = bundle.primary.attrs.keyboard.content.rows
  const values = rows.flatMap((row: any) => row.buttons.map((button: any) => button.action.data))
  assert.deepEqual(values, ['通过投稿 7', '驳回投稿 7'])

  const plain = buildPreReviewAdminBundle({ pendingId: 7, authorId: 'author7', summary: '摘要' }, 'onebot')
  const fallbackText = String(plain.fallback.children[0].attrs.content)
  assert.equal(fallbackText.includes('待审编号：7'), true)
})

test('reject reason prompt provides a skip button', () => {
  const prompt = buildRejectReasonPrompt(9, 'qq')
  const rows = prompt.attrs.keyboard.content.rows
  const values = rows.flatMap((row: any) => row.buttons.map((button: any) => button.action.data))
  assert.deepEqual(values, [REJECT_REASON_SKIP_VALUE])
  assert.equal(String(prompt.attrs.markdown.content).includes('9'), true)
})

test('withdraw list renders pending numbers with summaries and per-item command inputs', () => {
  const records = [
    { pendingId: 2, content: makeContent({ text: '第二条' }) },
    { pendingId: 5, content: makeContent({ text: null, image: ['file:///a.jpg'] }) },
  ]
  const markdownText = buildPreReviewWithdrawListText(records, true)
  assert.equal(markdownText.includes('# 📥 你的待审投稿'), true)
  assert.equal(markdownText.includes('编号 2：第二条'), true)
  assert.equal(markdownText.includes('编号 5：\\[图片\\]'), true)
  assert.equal(markdownText.includes(buildQQWithdrawCommandInput(2)), true)
  assert.equal(markdownText.includes(buildQQWithdrawCommandInput(5)), true)
  // 回填指令保持可读：show 文本与待审编号一致
  assert.equal(markdownText.includes(encodeURIComponent('撤回投稿 5')), true)
  assert.equal(markdownText.includes('请发送需要撤回的投稿编号'), true)

  const plainText = buildPreReviewWithdrawListText(records, false)
  assert.equal(plainText.includes('编号 2：第二条'), true)
  assert.equal(plainText.includes('qqbot-cmd-input'), false)
  assert.equal(plainText.includes('请发送需要撤回的投稿编号'), true)

  const emptyText = buildPreReviewWithdrawListText([], false)
  assert.equal(emptyText.includes('当前没有待审投稿'), true)
})

test('withdraw command input urlencodes the command and keeps reference disabled', () => {
  const tag = buildQQWithdrawCommandInput(12)
  assert.equal(tag.includes('text="' + encodeURIComponent('漂流瓶/撤回投稿 12') + '"'), true)
  assert.equal(tag.includes('show="' + encodeURIComponent('撤回投稿 12') + '"'), true)
  assert.equal(tag.includes('reference="false"'), true)
})

test('withdraw list caps at the limit keeping the most recent records', () => {
  const records = Array.from({ length: PRE_REVIEW_WITHDRAW_LIST_LIMIT + 5 }, (_, index) => ({
    pendingId: index + 1,
    content: makeContent(),
  }))
  const markdownText = buildPreReviewWithdrawListText(records, true)
  assert.equal(markdownText.includes('编号 ' + PRE_REVIEW_WITHDRAW_LIST_LIMIT + '：'), true)
  assert.equal(markdownText.includes('编号 ' + (PRE_REVIEW_WITHDRAW_LIST_LIMIT + 5) + '：'), true)
  assert.equal(markdownText.includes('编号 1：'), false)
  assert.equal(markdownText.includes('编号 5：'), false)
  assert.equal(markdownText.includes('仅展示最近 ' + PRE_REVIEW_WITHDRAW_LIST_LIMIT + ' 条'), true)
})

test('withdraw success receipt uses markdown on qq and plain text elsewhere', () => {
  const qq = buildPreReviewWithdrawSuccess(3, 'qq')
  assert.equal(qq.type === 'qq:rawmarkdown-without-keyboard', true)
  const qqContent = String(qq.attrs.content)
  assert.equal(qqContent.includes('# 📌 已撤回'), true)
  assert.equal(qqContent.includes('编号 3 的待审投稿已丢弃'), true)

  const plain = buildPreReviewWithdrawSuccess(3, 'onebot')
  assert.equal(String(plain.attrs.content).includes('已撤回编号 3'), true)
})

test('result push messages carry approval id or rejection reason', () => {
  const approved = buildPreReviewResultPush({ pendingId: 4, approved: true, bottleId: 88 }, 'qq')
  assert.equal(approved.type === 'qq:rawmarkdown-without-keyboard', true)
  const approvedContent = String(approved.attrs.content)
  assert.equal(approvedContent.includes('# ✅ 投稿已入海'), true)
  assert.equal(approvedContent.includes('待审编号 4 → 瓶子 ID 88'), true)

  const rejected = buildPreReviewResultPush({ pendingId: 4, approved: false, reason: '内容不合适' }, 'qq')
  const rejectedContent = String(rejected.attrs.content)
  assert.equal(rejectedContent.includes('# ❌ 未通过预审'), true)
  assert.equal(rejectedContent.includes('待审编号：4'), true)
  assert.equal(rejectedContent.includes('驳回理由：内容不合适'), true)

  // 驳回理由经过 markdown 转义
  const escaped = buildPreReviewResultPush({ pendingId: 4, approved: false, reason: '理由 *加粗*' }, 'qq')
  assert.equal(String(escaped.attrs.content).includes('理由 \\*加粗\\*'), true)

  const rejectedNoReason = buildPreReviewResultPush({ pendingId: 4, approved: false }, 'qq')
  assert.equal(String(rejectedNoReason.attrs.content).includes('驳回理由'), false)

  // 非 QQ 平台维持纯文本且文案一致
  const plainApproved = buildPreReviewResultPush({ pendingId: 4, approved: true, bottleId: 88 }, 'onebot')
  assert.equal(String(plainApproved.attrs.content).includes('瓶子已入海，ID 为：88'), true)

  const plainRejected = buildPreReviewResultPush({ pendingId: 4, approved: false, reason: '内容不合适' }, 'onebot')
  const plainRejectedText = String(plainRejected.attrs.content)
  assert.equal(plainRejectedText.includes('4'), true)
  assert.equal(plainRejectedText.includes('内容不合适'), true)
})
