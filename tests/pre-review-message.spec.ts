import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPendingSubmissionReceipt,
  buildPreReviewAdminBundle,
  buildPreReviewNotifyPrompt,
  buildPreReviewResultPush,
  buildPreReviewWithdrawListText,
  buildRejectReasonPrompt,
  buildSubmissionSummary,
  PRE_REVIEW_MUTE_VALUE,
  PRE_REVIEW_NOTIFY_VALUE,
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

test('withdraw list renders pending numbers with summaries and a selection hint', () => {
  const records = [
    { pendingId: 2, content: makeContent({ text: '第二条' }) },
    { pendingId: 5, content: makeContent({ text: null, image: ['file:///a.jpg'] }) },
  ]
  const markdownText = buildPreReviewWithdrawListText(records, true)
  assert.equal(markdownText.includes('编号 2：第二条'), true)
  assert.equal(markdownText.includes('编号 5：\\[图片\\]'), true)
  assert.equal(markdownText.includes('请发送需要撤回的投稿编号'), true)

  const plainText = buildPreReviewWithdrawListText([], false)
  assert.equal(plainText.includes('当前没有待审投稿'), true)
})

test('result push messages carry approval id or rejection reason', () => {
  const approved = buildPreReviewResultPush({ pendingId: 4, approved: true, bottleId: 88 }, 'qq')
  assert.equal(approved.type === 'qq:rawmarkdown-without-keyboard', true)
  const approvedText = String(approved.attrs.content)
  assert.equal(approvedText.includes('4'), true)
  assert.equal(approvedText.includes('88'), true)
  assert.equal(approvedText.includes('通过'), true)

  const rejected = buildPreReviewResultPush({ pendingId: 4, approved: false, reason: '内容不合适' }, 'onebot')
  const rejectedText = String(rejected.attrs.content)
  assert.equal(rejectedText.includes('4'), true)
  assert.equal(rejectedText.includes('内容不合适'), true)

  const rejectedNoReason = buildPreReviewResultPush({ pendingId: 4, approved: false }, 'onebot')
  assert.equal(String(rejectedNoReason.attrs.content).includes('未通过预审'), true)
})
