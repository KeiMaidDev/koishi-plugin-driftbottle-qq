import assert from 'node:assert/strict'
import test from 'node:test'
import type { DiftInfo } from '../src'
import { ConsoleService, consoleOperator, type ConsoleServiceDeps } from '../src/console-service'
import { BottleReportRegistry, isReportPending } from '../src/report'

function makeBottle(overrides: Partial<DiftInfo> = {}): DiftInfo {
  return {
    id: 1,
    style: 0,
    content: {
      creatTime: 1_700_000_000_000,
      text: '测试瓶子内容',
      image: null,
      audio: null,
      title: null,
    },
    getCount: 0,
    show: true,
    userId: 'author-1',
    review: [],
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

function makeDeps(options: {
  bottles?: DiftInfo[]
  threshold?: number
  registry?: BottleReportRegistry
} = {}) {
  const bottles = options.bottles ?? []
  const registry = options.registry ?? new BottleReportRegistry(makeStorage(), 'reports.json', options.threshold ?? 3)
  const persisted: string[] = []
  const logEntries: Array<{ userId: string; info: any }> = []
  const changes: string[] = []

  const deps: ConsoleServiceDeps = {
    getBottles: () => bottles,
    persistBottle: (userId) => { persisted.push(userId); return Promise.resolve() },
    bottleType: (bottle) => bottle.content.audio ? '语音瓶' : bottle.content.image && bottle.content.text ? '图文瓶' : bottle.content.image ? '图片瓶' : '文本瓶',
    reportRegistry: registry,
    threshold: options.threshold ?? 3,
    addLog: (userId, info) => logEntries.push({ userId, info }),
    logTypes: { ban: 5, unban: 6, reviewDeleted: 7 },
    mediaResolver: (url, kind) => {
      if (!url) return null
      if (url.startsWith('file://')) return `/media/${kind}/` + url.split('/').pop()
      if (url.startsWith('http')) return url
      return null
    },
    notifyChange: (action) => changes.push(action),
    getPendingSubmissions: () => [],
    pendingType: (pending) => pending.content.audio ? '语音瓶' : pending.content.image && pending.content.text ? '图文瓶' : pending.content.image ? '图片瓶' : '文本瓶',
    approvePending: async () => ({ ok: false, reason: 'not_found' }),
    rejectPending: async () => ({ ok: false, reason: 'not_found' }),
  }
  const service = new ConsoleService(deps)
  return { service, deps, registry, bottles, persisted, logEntries, changes }
}

async function makeRegistryWithReports(bottleId: string, reporterIds: string[], threshold = 3) {
  const storage = makeStorage()
  const registry = new BottleReportRegistry(storage, 'reports.json', threshold)
  await registry.init()
  for (const reporter of reporterIds) {
    await registry.submit('local', bottleId, reporter)
  }
  return { registry, storage }
}

test('consoleOperator formats operator identity', () => {
  assert.equal(consoleOperator('alice'), 'console(alice)')
  assert.equal(consoleOperator(''), 'console(unknown)')
})

test('getStats counts total/visible/banned and pending reports by threshold', async () => {
  const { registry } = await makeRegistryWithReports('1', ['u1', 'u2', 'u3'])
  const { service } = makeDeps({
    threshold: 3,
    registry,
    bottles: [
      makeBottle({ id: 1 }),
      makeBottle({ id: 2, show: false }),
      makeBottle({ id: 3 }),
    ],
  })

  const stats = service.getStats()
  assert.deepEqual(
    { total: stats.total, visible: stats.visible, banned: stats.banned },
    { total: 3, visible: 2, banned: 1 },
  )
  // 瓶 1 有 3 条举报且未处理 → 待处理
  assert.equal(stats.pendingReports, 1)
})

test('getStats treats resolved reports as not pending', async () => {
  const { registry } = await makeRegistryWithReports('1', ['u1', 'u2', 'u3'])
  await registry.resolve('local', '1')
  const { service } = makeDeps({ threshold: 3, registry, bottles: [makeBottle({ id: 1 })] })
  assert.equal(service.getStats().pendingReports, 0)
})

test('listBottles paginates in backend slices without missing or duplicating', () => {
  const bottles = Array.from({ length: 7 }, (_, i) => makeBottle({ id: i + 1 }))
  const { service } = makeDeps({ bottles })

  const page1 = service.listBottles({ page: 1, pageSize: 3 })
  assert.equal(page1.total, 7)
  assert.deepEqual(page1.bottles.map((b) => b.id), [7, 6, 5])
  const page2 = service.listBottles({ page: 2, pageSize: 3 })
  assert.deepEqual(page2.bottles.map((b) => b.id), [4, 3, 2])
  const page3 = service.listBottles({ page: 3, pageSize: 3 })
  assert.deepEqual(page3.bottles.map((b) => b.id), [1])
  const overflow = service.listBottles({ page: 4, pageSize: 3 })
  assert.equal(overflow.bottles.length, 0)
})

test('listBottles reported filter includes sub-threshold bottles and sorts by report count desc', async () => {
  const storage = makeStorage()
  const combined = new BottleReportRegistry(storage, 'reports.json', 3)
  await combined.init()
  for (const u of ['a', 'b', 'c']) await combined.submit('local', '2', u)
  for (const u of ['d']) await combined.submit('local', '5', u)
  await combined.submit('local', '9', 'e')

  const { service } = makeDeps({
    threshold: 3,
    registry: combined,
    bottles: [
      makeBottle({ id: 1 }),
      makeBottle({ id: 2, userId: 'author-2' }),
      makeBottle({ id: 5 }),
      makeBottle({ id: 9 }),
      makeBottle({ id: 4, show: false }),
    ],
  })

  const reported = service.listBottles({ filter: 'reported' })
  // 所有有举报的瓶子都列出（含低于阈值的瓶 5、9），按举报数降序，同数按 id 降序
  assert.deepEqual(reported.bottles.map((b) => b.id), [2, 9, 5])
  assert.equal(reported.bottles[0].reportCount, 3)
  assert.equal(reported.bottles[0].reportPending, true)
  assert.equal(reported.bottles[1].reportPending, false)

  const banned = service.listBottles({ filter: 'banned' })
  assert.deepEqual(banned.bottles.map((b) => b.id), [4])

  const all = service.listBottles({})
  assert.equal(all.total, 5)
})

test('listBottles searches by bottle id or author id', () => {
  const { service } = makeDeps({
    bottles: [
      makeBottle({ id: 12, userId: 'author-a' }),
      makeBottle({ id: 13, userId: 'author-b' }),
      makeBottle({ id: 21, userId: 'author-c' }),
    ],
  })
  assert.deepEqual(service.listBottles({ search: '13' }).bottles.map((b) => b.id), [13])
  assert.deepEqual(service.listBottles({ search: '1' }).bottles.map((b) => b.id), [21, 13, 12])
  assert.deepEqual(service.listBottles({ search: 'author-a' }).bottles.map((b) => b.id), [12])
  assert.deepEqual(service.listBottles({ search: 'nomatch' }).bottles, [])
})

test('getBottle maps fields, keeps soft-deleted reviews, and resolves media urls', () => {
  const { service } = makeDeps({
    bottles: [
      makeBottle({
        id: 7,
        userId: 'author-7',
        content: {
          creatTime: 123,
          text: '正文',
          title: '标题',
          image: ['file:///data/image/a.jpg', 'https://cdn.example/b.png', 'broken://x'],
          audio: null,
        },
        review: [
          { creatTime: 124, text: '正常留言', image: ['file:///data/image/c.jpg'], userId: 'u1' },
          { creatTime: 125, text: '被删留言', image: null, userId: 'u2', isDel: true },
        ],
      }),
    ],
  })

  const detail = service.getBottle(7)
  assert.ok(detail)
  assert.equal(detail.authorId, 'author-7')
  assert.equal(detail.type, '图文瓶')
  assert.deepEqual(detail.images, ['/media/image/a.jpg', 'https://cdn.example/b.png', null])
  assert.equal(detail.audio, null)
  assert.equal(detail.reviews.length, 2)
  assert.equal(detail.reviews[0].isDel, false)
  assert.deepEqual(detail.reviews[0].images, ['/media/image/c.jpg'])
  assert.equal(detail.reviews[1].isDel, true)
  assert.equal(detail.reviews[1].index, 1)
  assert.equal(service.getBottle(999), null)
})

test('getBottle resolves first audio url', () => {
  const { service } = makeDeps({
    bottles: [makeBottle({
      id: 8,
      content: { creatTime: 1, text: null, title: null, image: null, audio: ['file:///data/audio/a.silk', 'file:///data/audio/b.silk'] },
    })],
  })
  assert.equal(service.getBottle(8)?.audio, '/media/audio/a.silk')
})

test('banBottle flips show, persists, logs with operator, resolves reports and notifies', async () => {
  const { registry } = await makeRegistryWithReports('1', ['u1', 'u2', 'u3'])
  const { service, bottles, persisted, logEntries, changes } = makeDeps({
    threshold: 3,
    registry,
    bottles: [makeBottle({ id: 1 })],
  })

  const result = await service.banBottle(1, consoleOperator('alice'))
  assert.deepEqual(result, { ok: true })
  assert.equal(bottles[0].show, false)
  assert.deepEqual(persisted, ['author-1'])
  assert.equal(logEntries.length, 1)
  assert.equal(logEntries[0].userId, 'author-1')
  assert.equal(logEntries[0].info.type, 5)
  assert.equal(logEntries[0].info.userId, 'console(alice)')
  assert.equal(registry.get('local', '1')?.resolvedAt != null, true)
  assert.deepEqual(changes, ['ban'])

  // 已封禁的瓶子再次封禁报错
  const again = await service.banBottle(1, consoleOperator('alice'))
  assert.deepEqual(again, { ok: false, reason: 'already_banned' })
  const missing = await service.banBottle(99, consoleOperator('alice'))
  assert.deepEqual(missing, { ok: false, reason: 'not_found' })
})

test('unbanBottle restores visibility without resolving reports', async () => {
  const { registry } = await makeRegistryWithReports('1', ['u1', 'u2', 'u3'])
  const { service, bottles, logEntries, changes } = makeDeps({
    threshold: 3,
    registry,
    bottles: [makeBottle({ id: 1 })],
  })
  bottles[0].show = false

  const result = await service.unbanBottle(1, consoleOperator('bob'))
  assert.deepEqual(result, { ok: true })
  assert.equal(bottles[0].show, true)
  assert.equal(logEntries[0].info.type, 6)
  assert.equal(logEntries[0].info.userId, 'console(bob)')
  assert.equal(registry.get('local', '1')?.resolvedAt, undefined)
  assert.deepEqual(changes, ['unban'])

  const again = await service.unbanBottle(1, consoleOperator('bob'))
  assert.deepEqual(again, { ok: false, reason: 'already_visible' })
})

test('deleteReview soft-deletes by original index and logs to reviewer', async () => {
  const { service, bottles, logEntries, changes } = makeDeps({
    bottles: [makeBottle({
      id: 3,
      review: [
        { creatTime: 1, text: 'a', image: null, userId: 'u1' },
        { creatTime: 2, text: 'b', image: null, userId: 'u2', isDel: true },
        { creatTime: 3, text: 'c', image: null, userId: 'u3' },
      ],
    })],
  })

  const result = await service.deleteReview(3, 2, consoleOperator('carol'))
  assert.deepEqual(result, { ok: true })
  assert.equal(bottles[0].review[2].isDel, true)
  assert.notEqual(bottles[0].review[0].isDel, true)
  assert.equal(logEntries[0].userId, 'u3')
  assert.equal(logEntries[0].info.type, 7)
  assert.deepEqual(changes, ['delete-review'])

  assert.deepEqual(await service.deleteReview(3, 2, consoleOperator('carol')), { ok: false, reason: 'already_deleted' })
  assert.deepEqual(await service.deleteReview(3, 9, consoleOperator('carol')), { ok: false, reason: 'invalid_review' })
  assert.deepEqual(await service.deleteReview(99, 0, consoleOperator('carol')), { ok: false, reason: 'not_found' })
})

test('dismissReport resolves the record without touching visibility', async () => {
  const { registry } = await makeRegistryWithReports('1', ['u1', 'u2', 'u3'])
  const { service, bottles, changes } = makeDeps({
    threshold: 3,
    registry,
    bottles: [makeBottle({ id: 1 })],
  })

  const result = await service.dismissReport(1, consoleOperator('dave'))
  assert.deepEqual(result, { ok: true })
  assert.equal(bottles[0].show, true)
  assert.equal(registry.get('local', '1')?.resolvedAt != null, true)
  assert.deepEqual(changes, ['dismiss-report'])

  assert.deepEqual(await service.dismissReport(1, consoleOperator('dave')), { ok: true })
  assert.deepEqual(await service.dismissReport(99, consoleOperator('dave')), { ok: false, reason: 'not_found' })
})

test('dismissReport fails when the bottle has no report record', async () => {
  const { service } = makeDeps({ bottles: [makeBottle({ id: 1 })] })
  assert.deepEqual(await service.dismissReport(1, consoleOperator('dave')), { ok: false, reason: 'no_report' })
})

test('isReportPending matches threshold semantics', () => {
  assert.equal(isReportPending(undefined, 3), false)
  assert.equal(isReportPending({ reporterIds: ['a'], resolvedAt: undefined }, 1), true)
  assert.equal(isReportPending({ reporterIds: ['a'], resolvedAt: 1 }, 1), false)
  assert.equal(isReportPending({ reporterIds: ['a', 'b'], resolvedAt: undefined }, 3), false)
})

function makePending(overrides: Partial<import('../src/pre-review').PendingSubmissionRecord> = {}): import('../src/pre-review').PendingSubmissionRecord {
  return {
    pendingId: 1,
    userId: 'author-1',
    content: {
      creatTime: 1_700_000_000_000,
      text: '待审投稿内容',
      title: null,
      image: ['file:///data/image/a.jpg'],
      audio: null,
    },
    style: 0,
    notifyAuthor: false,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function makeDepsWithPending(options: {
  pendings?: import('../src/pre-review').PendingSubmissionRecord[]
} = {}) {
  const pendings = options.pendings ?? []
  const base = makeDeps({})
  const approveCalls: Array<{ pendingId: number; operator: string }> = []
  const rejectCalls: Array<{ pendingId: number; operator: string; reason: string }> = []
  const deps: ConsoleServiceDeps = {
    ...base.deps,
    getPendingSubmissions: () => pendings,
    pendingType: (pending) => pending.content.audio ? '语音瓶' : pending.content.image && pending.content.text ? '图文瓶' : pending.content.image ? '图片瓶' : '文本瓶',
    approvePending: async (pendingId, operator) => {
      const found = pendings.find((item) => item.pendingId === pendingId)
      if (!found) return { ok: false, reason: 'not_found' }
      approveCalls.push({ pendingId, operator })
      pendings.splice(pendings.indexOf(found), 1)
      return { ok: true }
    },
    rejectPending: async (pendingId, operator, reason) => {
      const found = pendings.find((item) => item.pendingId === pendingId)
      if (!found) return { ok: false, reason: 'not_found' }
      rejectCalls.push({ pendingId, operator, reason })
      pendings.splice(pendings.indexOf(found), 1)
      return { ok: true }
    },
  }
  const service = new ConsoleService(deps)
  return { service, deps, pendings, approveCalls, rejectCalls, changes: base.changes }
}

test('getStats exposes pending submission count', async () => {
  const { service } = makeDepsWithPending({
    pendings: [makePending(), makePending({ pendingId: 2 })],
  })
  assert.equal(service.getStats().pendingSubmissions, 2)
})

test('listPending sorts by pending number desc with summaries', async () => {
  const { service } = makeDepsWithPending({
    pendings: [
      makePending({ pendingId: 1, content: { creatTime: 1, text: '第一条', title: null, image: null, audio: null } }),
      makePending({ pendingId: 2, userId: 'author-2', notifyAuthor: true, content: { creatTime: 2, text: null, title: '标题投稿', image: null, audio: null } }),
    ],
  })
  const result = service.listPending()
  assert.equal(result.total, 2)
  assert.deepEqual(result.pendings.map((item) => item.pendingId), [2, 1])
  assert.equal(result.pendings[0].authorId, 'author-2')
  assert.equal(result.pendings[0].preview, '标题投稿')
  assert.equal(result.pendings[0].notifyAuthor, true)
  assert.equal(result.pendings[0].type, '文本瓶')
})

test('getPending resolves media urls and returns null for unknown id', async () => {
  const { service } = makeDepsWithPending({ pendings: [makePending()] })
  const detail = service.getPending(1)
  assert.ok(detail)
  assert.equal(detail.type, '图文瓶')
  assert.deepEqual(detail.images, ['/media/image/a.jpg'])
  assert.equal(detail.text, '待审投稿内容')
  assert.equal(service.getPending(99), null)
})

test('approvePending delegates to glue and leaves the panel broadcast to it', async () => {
  const { service, approveCalls, changes, pendings } = makeDepsWithPending({ pendings: [makePending()] })

  assert.deepEqual(await service.approvePending(1, consoleOperator('alice')), { ok: true })
  assert.deepEqual(approveCalls, [{ pendingId: 1, operator: 'console(alice)' }])
  // 面板广播由主入口 glue 统一负责（QQ 端与面板共用同一条路径），服务层不再重复广播
  assert.deepEqual(changes, [])
  assert.equal(pendings.length, 0)

  assert.deepEqual(await service.approvePending(1, consoleOperator('alice')), { ok: false, reason: 'not_found' })
  assert.deepEqual(changes, [])
})

test('rejectPending delegates with reason and leaves the panel broadcast to glue', async () => {
  const { service, rejectCalls, changes } = makeDepsWithPending({ pendings: [makePending()] })

  assert.deepEqual(await service.rejectPending(1, consoleOperator('bob'), '内容不合适'), { ok: true })
  assert.deepEqual(rejectCalls, [{ pendingId: 1, operator: 'console(bob)', reason: '内容不合适' }])
  assert.deepEqual(changes, [])

  assert.deepEqual(await service.rejectPending(404, consoleOperator('bob'), ''), { ok: false, reason: 'not_found' })
  assert.deepEqual(changes, [])
})
