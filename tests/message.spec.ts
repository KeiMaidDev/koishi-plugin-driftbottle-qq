import assert from 'node:assert/strict'
import test from 'node:test'
import { h } from 'koishi'
import type { DiftInfo } from '../src'
import {
  buildCloudBottleMessages,
  buildHistoryBundle,
  buildLocalBottleMessages,
  buildLogBundle,
  buildReportAdminBundle,
  buildMainMenuBundle,
  buildMarkdownImage,
  createBottleKeyboard,
  createMainKeyboard,
  fitMarkdownImageDimensions,
  resolveMarkdownImageDimensions,
} from '../src/message'
import { BottleReportRegistry } from '../src/report'
import { createAdapterDisplayNameResolver, pickAdapterDisplayName, withAdapterDisplayNames, withoutAdapterDisplayNames } from '../src/user-name'

test('QQ markdown image preserves supplied dimensions and oversized images keep their aspect ratio', () => {
  assert.equal(
    buildMarkdownImage('https://assets.example/bottle.jpg', '漂流瓶图片', 800, 600),
    '![漂流瓶图片 #800px #600px](https://assets.example/bottle.jpg)',
  )
  assert.deepEqual(fitMarkdownImageDimensions(800, 600), { width: 800, height: 600 })
  assert.deepEqual(fitMarkdownImageDimensions(2000, 1000), { width: 1024, height: 512 })
  assert.deepEqual(fitMarkdownImageDimensions(500, 2000), { width: 256, height: 1024 })
  assert.throws(
    () => buildMarkdownImage('https://assets.example/bottle.jpg', '漂流瓶图片', 0, 1024),
    RangeError,
  )
})

test('local QQ bottle uses mapped Assets URL and does not resend the embedded image', async () => {
  const bottle: DiftInfo = {
    id: 12,
    style: 0,
    content: {
      creatTime: 1_700_000_000_000,
      text: '图片测试',
      image: ['file:///C:/data/a.jpg'],
      audio: null,
      title: '测试瓶',
    },
    getCount: 1,
    show: true,
    userId: '10001',
    review: [],
  }
  const loadedSources: string[] = []
  let disposed = 0
  const bundle = await buildLocalBottleMessages(bottle, 'qq', {
    async transform(content: string) {
      assert.equal(h.parse(content)[0].attrs.src, 'file:///C:/data/a.jpg')
      return h.image('https://assets.example/bottle.jpg').toString()
    },
  }, {}, {
    async loadImage(source: string) {
      loadedSources.push(source)
      return {
        naturalWidth: 800,
        naturalHeight: 600,
        async dispose() { disposed++ },
      }
    },
  })
  const markdown = bundle.primary.attrs.markdown.content
  assert.equal(markdown.includes('![漂流瓶图片 1 #800px #600px](https://assets.example/bottle.jpg)'), true)
  assert.equal(markdown.includes('file:///'), false)
  assert.equal(bundle.media.some(element => element.type === 'img'), false)
  assert.deepEqual(loadedSources, ['file:///C:/data/a.jpg'])
  assert.equal(disposed, 1)
})

test('Canvas dimension lookup retries the Assets URL and safely falls back when loading fails', async () => {
  const loadedSources: string[] = []
  const dimensions = await resolveMarkdownImageDimensions('file:///missing.jpg', {
    async loadImage(source: string) {
      loadedSources.push(source)
      if (source.startsWith('file:')) throw new Error('local file unavailable')
      return {
        naturalWidth: 500,
        naturalHeight: 2000,
        async dispose() {},
      }
    },
  }, 'https://assets.example/missing.jpg')
  assert.deepEqual(loadedSources, ['file:///missing.jpg', 'https://assets.example/missing.jpg'])
  assert.deepEqual(dimensions, { width: 256, height: 1024 })

  assert.deepEqual(await resolveMarkdownImageDimensions('broken', {
    async loadImage() { throw new Error('broken image') },
  }), { width: 1024, height: 1024 })
})

test('cloud QQ bottle uses Canvas dimensions for content and comment images', async () => {
  const bundle = await buildCloudBottleMessages({
    id: 'cloud-1',
    content: {
      createTime: 1_700_000_000_000,
      text: '云瓶正文',
      title: '云瓶',
      image: ['https://source.example/content.jpg'],
      userId: 'author',
    },
    review: [{
      createTime: 1_700_000_000_001,
      text: '图片留言',
      userId: 'commenter',
      botId: 'bot',
      platform: 'qq',
      image: ['https://source.example/comment.jpg'],
    }],
    userId: 'author',
    botId: 'bot',
    show: true,
    getCount: 2,
    platform: 'qq',
  }, 'qq', {
    async transform(content: string) {
      const source = h.parse(content)[0].attrs.src as string
      return h.image(source.replace('source.example', 'assets.example')).toString()
    },
  }, {
    async loadImage(source: string) {
      const contentImage = source.endsWith('/content.jpg')
      return {
        naturalWidth: contentImage ? 2000 : 640,
        naturalHeight: contentImage ? 1000 : 480,
        async dispose() {},
      }
    },
  })
  const markdown = bundle.primary.attrs.markdown.content
  assert.equal(markdown.includes('![云漂流瓶图片 1 #1024px #512px](https://assets.example/content.jpg)'), true)
  assert.equal(markdown.includes('![留言图片 1 #640px #480px](https://assets.example/comment.jpg)'), true)
})

test('non-QQ bottles do not invoke Assets or Canvas image services', async () => {
  const bottle: DiftInfo = {
    id: 13,
    style: 0,
    content: {
      creatTime: 1_700_000_000_000,
      text: '普通消息',
      image: ['file:///C:/data/a.jpg'],
      audio: null,
      title: '非 QQ',
    },
    getCount: 0,
    show: true,
    userId: '10001',
    review: [],
  }
  const bundle = await buildLocalBottleMessages(bottle, 'discord', {
    async transform() { throw new Error('Assets should not be called') },
  }, {}, {
    async loadImage() { throw new Error('Canvas should not be called') },
  })
  assert.equal(bundle.primary.type, 'message')
  assert.equal(bundle.media.some(element => element.type === 'img'), true)
})

test('bottle keyboard exposes report and role-based management actions', () => {
  const regular = createBottleKeyboard(12, 'local')
  const admin = createBottleKeyboard(12, 'local', { canBan: true, canDeleteComments: true })
  const author = createBottleKeyboard(12, 'local', { canDeleteComments: true })
  const cloud = createBottleKeyboard('77', 'cloud', { canBan: true, canDeleteComments: true })

  assert.equal(regular.content.rows[1].buttons[0].render_data.label, '举报该瓶')
  assert.equal(regular.content.rows[1].buttons[0].action.data, '举报漂流瓶 12 local')
  assert.equal(regular.content.rows[1].buttons[0].action.enter, true)
  assert.equal(regular.content.rows.length, 2)

  assert.deepEqual(admin.content.rows[2].buttons.map(button => button.render_data.label), ['封禁瓶子', '删除留言'])
  assert.equal(admin.content.rows[2].buttons[0].action.data, '封漂流瓶 12')
  assert.equal(admin.content.rows[2].buttons[1].action.data, '删留言 12')
  assert.deepEqual(author.content.rows[2].buttons.map(button => button.render_data.label), ['删除留言'])
  assert.equal(cloud.content.rows[1].buttons[0].action.data, '举报漂流瓶 77 cloud')
  assert.equal(cloud.content.rows.length, 2)
})

test('local bottle bundle forwards viewer management permissions', async () => {
  const bottle: DiftInfo = {
    id: 18,
    style: 0,
    content: { creatTime: 1_700_000_000_000, text: '正文', image: null, audio: null, title: '作者瓶' },
    getCount: 1,
    show: true,
    userId: 'author',
    review: [],
  }
  const bundle = await buildLocalBottleMessages(bottle, 'qq', undefined, {
    canBan: true,
    canDeleteComments: true,
  })
  assert.deepEqual(
    bundle.primary.attrs.keyboard.content.rows[2].buttons.map(button => button.action.data),
    ['封漂流瓶 18', '删留言 18'],
  )
})

test('admin report notice provides QQ review and local ban buttons', () => {
  const bundle = buildReportAdminBundle({
    scope: 'local',
    bottleId: '12',
    reportCount: 3,
    threshold: 3,
    reporterId: 'reporter',
    title: '需要审核',
    authorId: 'author',
  }, 'qq')
  assert.equal(bundle.primary.type, 'qq:rawmarkdown')
  assert.equal(bundle.primary.attrs.markdown.content.includes('3 / 3'), true)
  assert.equal(bundle.primary.attrs.keyboard.content.rows[0].buttons[0].action.data, '捞漂流瓶 12')
  assert.equal(bundle.primary.attrs.keyboard.content.rows[0].buttons[1].action.data, '封漂流瓶 12')
  assert.equal(buildReportAdminBundle({
    scope: 'cloud', bottleId: '77', reportCount: 3, threshold: 3, reporterId: 'reporter',
  }, 'onebot').primary.type, 'message')
})

test('report registry deduplicates users and retries a failed threshold notification', async () => {
  let stored = ''
  const registry = new BottleReportRegistry({
    async getItem() { return stored },
    async setItem(_key, value) { stored = value },
  }, 'reports.json', 2)
  await registry.init()
  const first = await registry.submit('local', '12', 'user-1')
  assert.equal(first.shouldNotify, false)
  assert.equal((await registry.submit('local', '12', 'user-1')).duplicate, true)
  const second = await registry.submit('local', '12', 'user-2')
  assert.equal(second.shouldNotify, true)
  assert.equal(second.record.reporterIds.length, 2)
  await registry.completeNotification('local', '12', false)
  const retry = await registry.submit('local', '12', 'user-3')
  assert.equal(retry.shouldNotify, true)
  await registry.completeNotification('local', '12', true)
  const afterNotice = await registry.submit('local', '12', 'user-4')
  assert.equal(afterNotice.shouldNotify, false)
  assert.equal(Boolean(registry.get('local', '12')?.notifiedAt), true)
})

test('adapter display name resolver prefers member names and keeps stored IDs unchanged', async () => {
  assert.equal(pickAdapterDisplayName({ nick: '群昵称', name: '账号名称' }), '群昵称')
  assert.equal(pickAdapterDisplayName({ name: '<b>适配器名称</b>' }), '适配器名称')

  const memberCalls: string[] = []
  const session = {
    platform: 'qq',
    guildId: 'guild-1',
    userId: 'viewer',
    author: { name: '当前查看者' },
    bot: {
      async getGuildMember(_guildId: string, userId: string) {
        memberCalls.push(userId)
        return { nick: userId === 'author' ? '瓶子作者名称' : '留言用户名称' }
      },
      async getUser(userId: string) {
        return { id: userId, name: '用户-' + userId }
      },
    },
  }
  const storedBottle: DiftInfo = {
    id: 25,
    style: 0,
    content: { creatTime: 1_700_000_000_000, text: '正文', image: null, audio: null, title: null },
    getCount: 0,
    show: true,
    userId: 'author',
    review: [{ creatTime: 1_700_000_000_001, text: '留言', image: null, userId: 'commenter' }],
  }
  const displayBottle = await withAdapterDisplayNames(session as never, storedBottle)
  assert.equal(displayBottle.username, '瓶子作者名称')
  assert.equal(displayBottle.review[0].username, '留言用户名称')
  assert.equal(displayBottle.userId, 'author')
  assert.equal(displayBottle.review[0].userId, 'commenter')
  assert.equal(storedBottle.username, undefined)
  assert.equal(storedBottle.review[0].username, undefined)
  assert.deepEqual(memberCalls.sort(), ['author', 'commenter'])

  const legacyBottle: DiftInfo = {
    ...storedBottle,
    username: '旧作者名称',
    content: { ...storedBottle.content, username: '旧内容名称' },
    review: [{ ...storedBottle.review[0], username: '旧留言名称' }],
  }
  const stripped = withoutAdapterDisplayNames(legacyBottle)
  assert.equal(stripped.username, undefined)
  assert.equal(stripped.content.username, undefined)
  assert.equal(stripped.review[0].username, undefined)
  assert.equal(stripped.userId, 'author')
  assert.equal(stripped.review[0].userId, 'commenter')

  const resolveName = createAdapterDisplayNameResolver(session as never)
  assert.equal(await resolveName('viewer'), '当前查看者')
})

test('history query uses formatted QQ markdown and navigation keyboard', () => {
  const bundle = buildHistoryBundle([
    { id: 12, userId: 'author-1', username: '作者名称', type: '图文瓶' },
    { id: 8, userId: 'author-2', type: '语音瓶' },
  ], 9, 'qq')
  assert.equal(bundle.primary.type, 'qq:rawmarkdown')
  assert.equal(bundle.primary.attrs.markdown.content.includes('# 捞瓶记录'), true)
  assert.equal(bundle.primary.attrs.markdown.content.includes('📚 图文瓶 #12'), true)
  assert.equal(bundle.primary.attrs.markdown.content.includes('已记录 9 条'), true)
  assert.equal(bundle.primary.attrs.markdown.content.includes('发布者：作者名称'), true)
  assert.equal(bundle.primary.attrs.keyboard.content.rows[0].buttons[0].action.data, '捞漂流瓶 ')
  assert.equal(bundle.primary.attrs.keyboard.content.rows[0].buttons[0].action.enter, false)
  assert.equal(bundle.primary.attrs.keyboard.content.rows[1].buttons[0].action.data, '漂流瓶日志')
  assert.equal(buildHistoryBundle([], 0, 'onebot').primary.type, 'message')
})

test('log query uses card-style QQ markdown and navigation keyboard', () => {
  const bundle = buildLogBundle([
    { time: 1_700_000_000_000, info: '你捞到了 #12 漂流瓶', isNew: true },
    { time: 1_699_999_000_000, info: '你发布了一个图片瓶', isNew: false },
  ], 'qq')
  assert.equal(bundle.primary.type, 'qq:rawmarkdown')
  assert.equal(bundle.primary.attrs.markdown.content.includes('# 漂流瓶日志'), true)
  assert.equal(bundle.primary.attrs.markdown.content.includes('🆕 新消息'), true)
  assert.equal(bundle.primary.attrs.markdown.content.includes('✅ 已读'), true)
  assert.equal(bundle.primary.attrs.keyboard.content.rows[0].buttons[0].action.data, '查看瓶子记录')
  assert.equal(bundle.primary.attrs.keyboard.content.rows[1].buttons[1].action.data, '漂流瓶')
  assert.equal(buildLogBundle([], 'discord').primary.type, 'message')
})

test('main command uses QQ markdown with a six-button keyboard', () => {
  const keyboard = createMainKeyboard()
  assert.deepEqual(keyboard.content.rows.flatMap(row => row.buttons).map(button => button.render_data.label), [
    '捞漂流瓶', '扔漂流瓶', '捞云漂流瓶', '扔云漂流瓶', '查看记录', '查看日志',
  ])
  assert.equal(keyboard.content.rows[0].buttons[1].action.data, '扔漂流瓶 ')
  assert.equal(keyboard.content.rows[0].buttons[1].action.enter, false)
  assert.equal(keyboard.content.rows[1].buttons[1].action.data, '扔云漂流瓶 ')
  assert.equal(keyboard.content.rows[1].buttons[1].action.enter, false)
  assert.equal(buildMainMenuBundle('qq').primary.type, 'qq:rawmarkdown')
  assert.equal(buildMainMenuBundle('onebot').primary.type, 'message')
})
