import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAutoExamineAvailable,
  isPreReviewRequired,
  PendingSubmissionRegistry,
  type PendingSubmissionContent,
} from '../src/pre-review'

function makeContent(overrides: Partial<PendingSubmissionContent> = {}): PendingSubmissionContent {
  return {
    creatTime: 1_700_000_000_000,
    text: '测试投稿内容',
    title: null,
    image: null,
    audio: null,
    ...overrides,
  }
}

function makeStorage(initial: Record<string, string> = {}) {
  const store = { ...initial }
  return {
    async getItem(key: string) { return store[key] ?? null },
    async setItem(key: string, value: string) { store[key] = value },
    dump() { return store },
  }
}

async function makeRegistry(storage = makeStorage(), removed: PendingSubmissionRecordSpy[] = []) {
  const registry = new PendingSubmissionRegistry(storage, 'pending.json', async (record) => {
    removed.push(record)
  })
  await registry.init()
  return { registry, storage, removed }
}

type PendingSubmissionRecordSpy = { pendingId: number; userId: string }

test('isAutoExamineAvailable truth table matches delSetu release condition', () => {
  // isExamine 关闭 → 审核不可用
  assert.equal(isAutoExamineAvailable({ isExamine: false, Appid: 'a', key: 'k' }), false)
  // 开启但缺密钥 → 实际不可用
  assert.equal(isAutoExamineAvailable({ isExamine: true, Appid: 'a', key: '' }), false)
  assert.equal(isAutoExamineAvailable({ isExamine: true, Appid: '', key: 'k' }), false)
  assert.equal(isAutoExamineAvailable({ isExamine: true, Appid: '', key: '' }), false)
  // 开启且密钥齐全 → 可用
  assert.equal(isAutoExamineAvailable({ isExamine: true, Appid: 'a', key: 'k' }), true)
})

test('isPreReviewRequired is the exact complement of examine availability', () => {
  assert.equal(isPreReviewRequired({ isExamine: false, Appid: 'a', key: 'k' }), true)
  assert.equal(isPreReviewRequired({ isExamine: true, Appid: 'a', key: '' }), true)
  assert.equal(isPreReviewRequired({ isExamine: true, Appid: 'a', key: 'k' }), false)
})

test('submit assigns globally incrementing pending numbers that are never reused', async () => {
  const { registry } = await makeRegistry()

  const first = await registry.submit({ userId: 'u1', content: makeContent(), notifyAuthor: false })
  const second = await registry.submit({ userId: 'u2', content: makeContent(), notifyAuthor: true })

  assert.equal(first.pendingId, 1)
  assert.equal(second.pendingId, 2)
  assert.equal(registry.count(), 2)
  assert.equal(registry.get(2)?.notifyAuthor, true)
})

test('approve returns promotion data, invalidates the number and keeps the counter', async () => {
  const { registry } = await makeRegistry()
  const first = await registry.submit({ userId: 'u1', content: makeContent(), notifyAuthor: false })

  const promoted = await registry.approve(first.pendingId)
  assert.equal(promoted?.pendingId, first.pendingId)
  assert.equal(promoted?.userId, 'u1')
  assert.equal(promoted?.content.text, '测试投稿内容')
  assert.equal(registry.get(first.pendingId), undefined)
  assert.equal(registry.count(), 0)

  // 编号不复用：通过后再提交得到递增的新编号
  const next = await registry.submit({ userId: 'u1', content: makeContent(), notifyAuthor: false })
  assert.equal(next.pendingId, first.pendingId + 1)
})

test('reject clears the record and removes downloaded media', async () => {
  const { registry, removed } = await makeRegistry()
  const record = await registry.submit({
    userId: 'u1',
    content: makeContent({ image: ['file:///data/image/a.jpg'] }),
    notifyAuthor: false,
  })

  const rejected = await registry.reject(record.pendingId)
  assert.equal(rejected?.pendingId, record.pendingId)
  assert.equal(registry.get(record.pendingId), undefined)
  assert.deepEqual(removed.map((r) => ({ pendingId: r.pendingId, userId: r.userId })), [{ pendingId: record.pendingId, userId: "u1" }])
})

test('reject returns null for unknown or already processed submissions', async () => {
  const { registry } = await makeRegistry()
  assert.equal(await registry.reject(404), null)

  const record = await registry.submit({ userId: 'u1', content: makeContent(), notifyAuthor: false })
  await registry.reject(record.pendingId)
  assert.equal(await registry.reject(record.pendingId), null)
})

test('withdraw only works for the owner and removes media', async () => {
  const { registry, removed } = await makeRegistry()
  const record = await registry.submit({ userId: 'u1', content: makeContent(), notifyAuthor: true })

  // 非作者撤回失败
  assert.equal(await registry.withdraw(record.pendingId, 'u2'), null)
  assert.equal(registry.count(), 1)

  const withdrawn = await registry.withdraw(record.pendingId, 'u1')
  assert.equal(withdrawn?.pendingId, record.pendingId)
  assert.equal(registry.count(), 0)
  assert.deepEqual(removed.map((r) => ({ pendingId: r.pendingId, userId: r.userId })), [{ pendingId: record.pendingId, userId: "u1" }])

  // 已处理（此处为撤回）的投稿再次撤回失败
  assert.equal(await registry.withdraw(record.pendingId, 'u1'), null)
})

test('approve does not remove media: promotion reuses the downloaded files', async () => {
  const { registry, removed } = await makeRegistry()
  const record = await registry.submit({
    userId: 'u1',
    content: makeContent({ image: ['file:///data/image/a.jpg'] }),
    notifyAuthor: false,
  })
  await registry.approve(record.pendingId)
  assert.deepEqual(removed, [])
})

test('registry survives restart: counter and pending list are restored', async () => {
  const storage = makeStorage()
  const first = new PendingSubmissionRegistry(storage, 'pending.json', async () => {})
  await first.init()
  const a = await first.submit({ userId: 'u1', content: makeContent(), notifyAuthor: false })
  await first.submit({ userId: 'u2', content: makeContent(), notifyAuthor: true })
  await first.reject(a.pendingId)

  // 用同一存储重建注册表模拟重启
  const revived = new PendingSubmissionRegistry(storage, 'pending.json', async () => {})
  await revived.init()

  assert.equal(revived.count(), 1)
  const remaining = revived.listByUser('u2')
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].pendingId, 2)
  assert.equal(remaining[0].notifyAuthor, true)

  // 重启后编号继续递增，不复用已被驳回的 1
  const next = await revived.submit({ userId: 'u3', content: makeContent(), notifyAuthor: false })
  assert.equal(next.pendingId, 3)
})

test('listByUser and listAll return copies sorted by pending number', async () => {
  const { registry } = await makeRegistry()
  await registry.submit({ userId: 'u1', content: makeContent(), notifyAuthor: false })
  await registry.submit({ userId: 'u2', content: makeContent(), notifyAuthor: false })
  await registry.submit({ userId: 'u1', content: makeContent(), notifyAuthor: true })

  const mine = registry.listByUser('u1')
  assert.deepEqual(mine.map((item) => item.pendingId), [1, 3])
  // 返回的是副本，外部修改不影响注册表
  mine[0].content.text = '篡改'
  assert.equal(registry.get(1)?.content.text, '测试投稿内容')

  assert.deepEqual(registry.listAll().map((item) => item.pendingId), [1, 2, 3])
})

test('init tolerates corrupt storage and starts empty', async () => {
  const storage = makeStorage({ 'pending.json': '{not json' })
  const registry = new PendingSubmissionRegistry(storage, 'pending.json', async () => {})
  await registry.init()
  assert.equal(registry.count(), 0)
  const record = await registry.submit({ userId: 'u1', content: makeContent(), notifyAuthor: false })
  assert.equal(record.pendingId, 1)
})
