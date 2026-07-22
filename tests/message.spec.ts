import assert from 'node:assert/strict'
import test from 'node:test'
import { h, Universal } from 'koishi'
import type { DiftInfo } from '../src'
import {
  buildCloudBottleMessages,
  buildCommentSelectionText,
  buildHistoryBundle,
  buildLocalBottleMessages,
  buildLogBundle,
  buildReportAdminBundle,
  buildMainMenuBundle,
  buildStatisticsBundle,
  buildThrowBottlePrompt,
  buildThrowBottleResultMessage,
  buildMarkdownImage,
  createBottleKeyboard,
  createMainKeyboard,
  escapeQQMarkdownWithLinks,
  fitMarkdownImageDimensions,
  resolveMarkdownImageDimensions,
  THROW_BOTTLE_CANCEL_VALUE,
  THROW_BOTTLE_SKIP_IMAGE_VALUE,
  THROW_BOTTLE_SKIP_TITLE_VALUE,
} from '../src/message'
import { BottleReportRegistry } from '../src/report'
import { sendProactivePrivateMessage } from '../src/proactive-message'
import { createAdapterDisplayNameResolver, fetchQqNicknameFromUapis, isNumericQqUserId, pickAdapterDisplayName, withAdapterDisplayNames, withoutAdapterDisplayNames } from '../src/user-name'

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

test('bottle markdown keeps HTTP links unescaped while escaping surrounding markdown', async () => {
  assert.equal(
    escapeQQMarkdownWithLinks('*链接* https://example.com/a_(b)?x=1&y=2。'),
    '\\*链接\\* https://example.com/a_(b)?x=1&y=2。',
  )

  const localBottle: DiftInfo = {
    id: 19,
    style: 0,
    content: {
      creatTime: 1_700_000_000_000,
      text: '正文 https://example.com/path?a=1&b=2。',
      image: null,
      audio: null,
      title: '链接测试',
    },
    getCount: 0,
    show: true,
    userId: 'author',
    review: [{
      creatTime: 1_700_000_000_001,
      text: '留言 https://comment.example/path.',
      image: null,
      userId: 'commenter',
    }],
  }
  const localMarkdown = (await buildLocalBottleMessages(localBottle, 'qq')).primary.attrs.markdown.content
  assert.equal(localMarkdown.includes('https://example.com/path?a=1&b=2。'), true)
  assert.equal(localMarkdown.includes('https://comment.example/path.'), true)
  assert.equal(localMarkdown.includes('https://example\\.com'), false)
  assert.equal(localMarkdown.includes('https://comment\\.example'), false)

  const cloudMarkdown = (await buildCloudBottleMessages({
    id: 'cloud-link',
    content: {
      createTime: 1_700_000_000_000,
      text: '云瓶 https://cloud.example/content',
      title: '云瓶链接',
      image: null,
      userId: 'author',
    },
    review: [{
      createTime: 1_700_000_000_001,
      text: '云留言 https://cloud.example/comment',
      userId: 'commenter',
      botId: 'bot',
      platform: 'qq',
      image: null,
    }],
    userId: 'author',
    botId: 'bot',
    show: true,
    getCount: 0,
    platform: 'qq',
  }, 'qq')).primary.attrs.markdown.content
  assert.equal(cloudMarkdown.includes('https://cloud.example/content'), true)
  assert.equal(cloudMarkdown.includes('https://cloud.example/comment'), true)
  assert.equal(cloudMarkdown.includes('https://cloud\\.example'), false)
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

test('local bottle hides deleted comments and caps comment images at 600 by 600', async () => {
  const transformedSources: string[] = []
  const bottle: DiftInfo = {
    id: 14,
    style: 0,
    content: {
      creatTime: 1_700_000_000_000,
      text: '本地瓶',
      image: null,
      audio: null,
      title: '留言图片测试',
    },
    getCount: 1,
    show: true,
    userId: 'author',
    review: [
      {
        creatTime: 1_700_000_000_001,
        text: '已删除留言',
        image: ['file:///C:/data/deleted.jpg'],
        userId: 'deleted-user',
        isDel: true,
      },
      {
        creatTime: 1_700_000_000_002,
        text: '有图留言',
        image: ['file:///C:/data/comment.jpg'],
        userId: 'commenter',
      },
    ],
  }
  const bundle = await buildLocalBottleMessages(bottle, 'qq', {
    async transform(content: string) {
      const source = h.parse(content)[0].attrs.src as string
      transformedSources.push(source)
      return h.image('https://assets.example/' + source.split('/').at(-1)).toString()
    },
  }, {}, {
    async loadImage() {
      return { naturalWidth: 1200, naturalHeight: 900, async dispose() {} }
    },
  })
  const markdown = bundle.primary.attrs.markdown.content
  assert.equal(markdown.includes('![留言 1 图片 1 #600px #450px](https://assets.example/comment.jpg)'), true)
  assert.equal(markdown.includes('管理员已删除该条评论'), false)
  assert.equal(markdown.includes('已删除留言'), false)
  assert.equal(markdown.includes('deleted-user'), false)
  assert.equal(markdown.includes('deleted.jpg'), false)
  assert.deepEqual(transformedSources, ['file:///C:/data/comment.jpg'])
  assert.deepEqual(
    bundle.fallbackMedia.filter(element => element.type === 'img').map(element => element.attrs.src),
    ['file:///C:/data/comment.jpg'],
  )
  const selection = buildCommentSelectionText(bottle, true)
  assert.equal(selection.includes('已删除留言'), false)
  assert.equal(selection.includes('deleted-user'), false)
  assert.equal(selection.includes('1. commenter：有图留言'), true)
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
  assert.deepEqual(
    await resolveMarkdownImageDimensions('comment-without-canvas', undefined, undefined, 600, 600),
    { width: 600, height: 600 },
  )
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
  assert.equal(markdown.includes('![留言 1 图片 1 #600px #450px](https://assets.example/comment.jpg)'), true)
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
    review: [{
      creatTime: 1_700_000_000_001,
      text: '图片留言',
      image: ['file:///C:/data/comment.jpg'],
      userId: 'commenter',
    }],
  }
  const bundle = await buildLocalBottleMessages(bottle, 'discord', {
    async transform() { throw new Error('Assets should not be called') },
  }, {}, {
    async loadImage() { throw new Error('Canvas should not be called') },
  })
  assert.equal(bundle.primary.type, 'message')
  assert.deepEqual(
    bundle.media.filter(element => element.type === 'img').map(element => element.attrs.src),
    ['file:///C:/data/a.jpg', 'file:///C:/data/comment.jpg'],
  )
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

test('proactive private message preserves adapter direct-channel metadata', async () => {
  const content = h('qq:rawmarkdown', { markdown: { content: '审核通知' } })
  const calls: Array<{ name: string, args: any[] }> = []
  const directChannel = { id: 'private:admin-openid', type: Universal.Channel.Type.DIRECT }
  const directSession = {
    event: { channel: directChannel, user: { id: 'admin-openid' } },
    isDirect: true,
  }
  const bot = {
    async createDirectChannel(userId: string) {
      calls.push({ name: 'createDirectChannel', args: [userId] })
      return directChannel
    },
    session(event: unknown) {
      calls.push({ name: 'session', args: [event] })
      return directSession
    },
    async sendMessage(...args: any[]) {
      calls.push({ name: 'sendMessage', args })
      return ['message-id']
    },
  }

  const result = await sendProactivePrivateMessage(bot as any, 'admin-openid', content)

  assert.deepEqual(result, ['message-id'])
  assert.deepEqual(calls[0], { name: 'createDirectChannel', args: ['admin-openid'] })
  assert.deepEqual(calls[1], {
    name: 'session',
    args: [{ channel: directChannel, user: { id: 'admin-openid' } }],
  })
  assert.equal(calls[2].name, 'sendMessage')
  assert.equal(calls[2].args[0], 'private:admin-openid')
  assert.equal(calls[2].args[1], content)
  assert.equal(calls[2].args[2], null)
  assert.equal(calls[2].args[3].session, directSession)
  assert.equal(calls[2].args[3].session.isDirect, true)
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

test('statistics query uses QQ markdown card and navigation keyboard', () => {
  const bundle = buildStatisticsBundle({
    total: 12,
    hidden: 2,
    neverScooped: 3,
    reviewTotal: 18,
    own: 4,
    reviewed: 5,
    typeCounts: { '图文瓶': 7, '文本瓶': 5 },
  }, 'qq')
  assert.equal(bundle.primary.type, 'qq:rawmarkdown')
  const markdown = bundle.primary.attrs.markdown.content
  assert.equal(markdown.includes('# 漂流瓶生态统计'), true)
  assert.equal(markdown.includes('可打捞：**10** 个'), true)
  assert.equal(markdown.includes('## 🧴 瓶子类型'), true)
  assert.equal(markdown.includes('## 👤 我的足迹'), true)
  assert.equal(markdown.includes('📚 图文瓶：**7** 个'), true)
  assert.equal(markdown.includes('我扔出的瓶子：**4** 个'), true)
  const rows = bundle.primary.attrs.keyboard.content.rows
  assert.equal(rows[0].buttons[0].action.data, '捞漂流瓶')
  assert.equal(rows[0].buttons[1].action.data, '扔漂流瓶 ')
  assert.equal(rows[0].buttons[1].action.enter, false)
  assert.equal(rows[1].buttons[0].action.data, '查看瓶子记录')
  assert.equal(rows[2].buttons[0].action.data, '漂流瓶')

  const fallback = buildStatisticsBundle({
    total: 0,
    hidden: 0,
    neverScooped: 0,
    reviewTotal: 0,
    own: 0,
    reviewed: 0,
    typeCounts: {},
  }, 'onebot')
  assert.equal(fallback.primary.type, 'message')
  assert.deepEqual(fallback.primary.children.map(element => element.type), ['img', 'text'])
})

test('numeric QQ IDs use the uapis HTTP endpoint only when adapter names are unavailable', async () => {
  assert.equal(isNumericQqUserId('qq', '123456789'), true)
  assert.equal(isNumericQqUserId('onebot', '123456789'), true)
  assert.equal(isNumericQqUserId('discord', '123456789'), false)
  assert.equal(isNumericQqUserId('qq', 'user-123'), false)

  let apiCalls = 0
  const session = {
    platform: 'qq',
    guildId: 'guild-1',
    userId: 'viewer',
    bot: {
      ctx: {
        http: {
          async get(url: string, config: { params: Record<string, string>, headers: Record<string, string>, timeout: number }) {
            apiCalls++
            assert.equal(url, 'https://uapis.cn/api/v1/social/qq/userinfo')
            assert.deepEqual(config.params, { qq: '246813579' })
            assert.deepEqual(config.headers, { Authorization: 'Bearer test-api-key' })
            assert.equal(config.timeout, 5000)
            return { nickname: '<b>Uapis 昵称</b>', nick: '备用昵称' }
          },
        },
      },
      async getGuildMember(_guildId: string, userId: string) {
        return { name: userId }
      },
      async getUser(userId: string) {
        return { name: userId }
      },
    },
  }
  const resolveName = createAdapterDisplayNameResolver(session as never, 'test-api-key')
  assert.equal(await resolveName('246813579'), 'Uapis 昵称')
  assert.equal(await resolveName('246813579'), 'Uapis 昵称')
  assert.equal(apiCalls, 1)

  let preferredApiCalls = 0
  const preferredSession = {
    ...session,
    bot: {
      ...session.bot,
      ctx: {
        http: {
          async get() {
            preferredApiCalls++
            return { nickname: 'API 昵称' }
          },
        },
      },
      async getGuildMember() {
        return { nick: '适配器昵称' }
      },
    },
  }
  assert.equal(
    await createAdapterDisplayNameResolver(preferredSession as never, 'test-api-key')('135792468'),
    '适配器昵称',
  )
  assert.equal(preferredApiCalls, 0)

  assert.equal(await fetchQqNicknameFromUapis('not-a-qq', 'test-api-key', {
    async get() { throw new Error('must not call HTTP for a non-numeric ID') },
  }), '')
  let guestCalls = 0
  assert.equal(await fetchQqNicknameFromUapis('1122334455', '', {
    async get(url: string, config: { params: Record<string, string>, headers?: Record<string, string>, timeout: number }) {
      guestCalls++
      assert.equal(url, 'https://uapis.cn/api/v1/social/qq/userinfo')
      assert.deepEqual(config.params, { qq: '1122334455' })
      assert.equal(config.headers, undefined)
      assert.equal(config.timeout, 5000)
      return { nick: '访客昵称' }
    },
  }), '访客昵称')
  assert.equal(guestCalls, 1)

  let retryCalls = 0
  const retryHttp = {
    async get() {
      retryCalls++
      if (retryCalls === 1) throw new Error('temporary Uapis failure')
      return { data: { nickname: '恢复后昵称' } }
    },
  }
  assert.equal(await fetchQqNicknameFromUapis('9988776655', '', retryHttp), '')
  assert.equal(await fetchQqNicknameFromUapis('9988776655', '', retryHttp), '恢复后昵称')
  assert.equal(retryCalls, 2)

  const explicitHttpSession = {
    platform: 'qq',
    userId: 'viewer',
    bot: {
      ctx: {},
      async getUser(userId: string) { return { name: userId } },
    },
  }
  const numericBottle: DiftInfo = {
    id: 31,
    style: 0,
    content: { creatTime: 1_700_000_000_000, text: '正文', image: null, audio: null, title: null },
    getCount: 0,
    show: true,
    userId: '8877665544',
    review: [],
  }
  const displayBottle = await withAdapterDisplayNames(
    explicitHttpSession as never,
    numericBottle,
    '',
    {
      async get() { return { body: { nickname: '显式 HTTP 昵称' } } },
    },
  )
  assert.equal(displayBottle.username, '显式 HTTP 昵称')
  assert.equal(numericBottle.username, undefined)

  let noCacheCalls = 0
  const noCacheHttp = {
    async get() {
      noCacheCalls++
      return { nickname: '不缓存昵称' }
    },
  }
  assert.equal(await fetchQqNicknameFromUapis('7766554433', '', noCacheHttp, 0), '不缓存昵称')
  assert.equal(await fetchQqNicknameFromUapis('7766554433', '', noCacheHttp, 0), '不缓存昵称')
  assert.equal(noCacheCalls, 2)
})

test('resolved nicknames are stored in the Koishi user database without mutating bottle storage', async () => {
  let storedName = ''
  let apiCalls = 0
  let createdUsers = 0
  let setCalls = 0
  const database = {
    async getUser(platform: string, pid: string) {
      assert.equal(platform, 'qq')
      assert.equal(pid, '6655443322')
      return storedName ? { id: 7, name: storedName } : undefined
    },
    async setUser(platform: string, pid: string, data: { name: string }) {
      assert.equal(platform, 'qq')
      assert.equal(pid, '6655443322')
      setCalls++
      storedName = data.name
    },
  }
  const session = {
    platform: 'qq',
    userId: 'viewer',
    async getUser(userId: string, fields: string[]) {
      assert.equal(userId, '6655443322')
      assert.deepEqual(fields, ['id', 'name'])
      createdUsers++
      return { id: 7, name: '' }
    },
    bot: {
      ctx: {},
      async getUser(userId: string) { return { name: userId } },
    },
  }
  const bottle: DiftInfo = {
    id: 32,
    style: 0,
    content: { creatTime: 1_700_000_000_000, text: 'database test', image: null, audio: null, title: null },
    getCount: 0,
    show: true,
    userId: '6655443322',
    review: [],
  }
  const http = {
    async get() {
      apiCalls++
      return { nickname: '数据库昵称' }
    },
  }

  const displayBottle = await withAdapterDisplayNames(
    session as never,
    bottle,
    '',
    http,
    0,
    database,
  )
  assert.equal(displayBottle.username, '数据库昵称')
  assert.equal(bottle.username, undefined)
  assert.equal(storedName, '数据库昵称')
  assert.equal(createdUsers, 1)
  assert.equal(setCalls, 1)
  assert.equal(apiCalls, 1)

  const resolveStoredName = createAdapterDisplayNameResolver(
    session as never,
    '',
    {
      async get() {
        apiCalls++
        throw new Error('database name should avoid Uapis')
      },
    },
    0,
    database,
  )
  assert.equal(await resolveStoredName('6655443322'), '数据库昵称')
  assert.equal(apiCalls, 1)

  const failingDatabase = {
    async getUser() { return { id: 9, name: '' } },
    async setUser() { throw new Error('database unavailable') },
  }
  const visibleName = await createAdapterDisplayNameResolver(
    {
      ...session,
      bot: {
        ctx: {},
        async getUser(userId: string) { return { name: userId } },
      },
    } as never,
    '',
    { async get() { return { nickname: '写入失败仍显示' } } },
    0,
    failingDatabase,
  )('5544332211')
  assert.equal(visibleName, '写入失败仍显示')
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

test('throw bottle prompts use QQ markdown keyboards and provide fallback text', () => {
  const contentPrompt = buildThrowBottlePrompt('content', 'qq')
  assert.equal(contentPrompt.type, 'qq:rawmarkdown')
  assert.equal(contentPrompt.attrs.markdown.content.includes('# 填写漂流瓶内容'), true)
  assert.equal(contentPrompt.attrs.keyboard.content.rows[0].buttons[0].action.data, THROW_BOTTLE_CANCEL_VALUE)

  const imagePrompt = buildThrowBottlePrompt('image', 'qq')
  assert.deepEqual(
    imagePrompt.attrs.keyboard.content.rows[0].buttons.map(button => button.render_data.label),
    ['跳过配图', '取消扔瓶'],
  )
  assert.equal(imagePrompt.attrs.keyboard.content.rows[0].buttons[0].action.data, THROW_BOTTLE_SKIP_IMAGE_VALUE)
  assert.equal(imagePrompt.attrs.keyboard.content.rows[0].buttons[1].action.data, THROW_BOTTLE_CANCEL_VALUE)

  const titlePrompt = buildThrowBottlePrompt('title', 'qq')
  assert.deepEqual(
    titlePrompt.attrs.keyboard.content.rows[0].buttons.map(button => button.render_data.label),
    ['跳过标题', '取消扔瓶'],
  )
  assert.equal(titlePrompt.attrs.keyboard.content.rows[0].buttons[0].action.data, THROW_BOTTLE_SKIP_TITLE_VALUE)

  const result = buildThrowBottleResultMessage('成功扔出 #12 漂流瓶。', 'qq', true)
  assert.equal(result.type, 'qq:rawmarkdown')
  assert.equal(result.attrs.markdown.content.includes('# 漂流瓶已投入大海'), true)
  assert.deepEqual(
    result.attrs.keyboard.content.rows.flatMap(row => row.buttons).map(button => button.render_data.label),
    ['再扔一个', '捞一个', '返回菜单'],
  )
  assert.equal(result.attrs.keyboard.content.rows[0].buttons[0].action.data, '扔漂流瓶 ')
  assert.equal(result.attrs.keyboard.content.rows[0].buttons[0].action.enter, false)
  assert.equal(buildThrowBottlePrompt('content', 'onebot').type, 'text')
  assert.equal(buildThrowBottleResultMessage('操作结束', 'onebot', false).type, 'text')
})

test('main command shows sea statistics with a dedicated statistics button', () => {
  const keyboard = createMainKeyboard()
  assert.deepEqual(keyboard.content.rows.flatMap(row => row.buttons).map(button => button.render_data.label), [
    '捞漂流瓶', '扔漂流瓶', '捞云漂流瓶', '扔云漂流瓶', '查看记录', '查看日志', '漂流瓶统计',
  ])
  assert.equal(keyboard.content.rows[0].buttons[1].action.data, '扔漂流瓶 ')
  assert.equal(keyboard.content.rows[0].buttons[1].action.enter, false)
  assert.equal(keyboard.content.rows[1].buttons[1].action.data, '扔云漂流瓶 ')
  assert.equal(keyboard.content.rows[1].buttons[1].action.enter, false)
  assert.equal(keyboard.content.rows[3].buttons[0].action.data, '漂流瓶统计')
  assert.equal(keyboard.content.rows[3].buttons[0].action.enter, true)

  const statistics = {
    total: 12,
    hidden: 2,
    neverScooped: 3,
    reviewTotal: 18,
    own: 4,
    reviewed: 5,
    typeCounts: { '图文瓶': 7, '文本瓶': 5 },
  }
  const qqMenu = buildMainMenuBundle('qq', statistics)
  assert.equal(qqMenu.primary.type, 'qq:rawmarkdown')
  const markdown = qqMenu.primary.attrs.markdown.content
  assert.equal(markdown.includes('# 漂流瓶'), true)
  assert.equal(markdown.includes('## 🌊 当前海域'), true)
  assert.equal(markdown.includes('漂流瓶总数：**12** 个'), true)
  assert.equal(markdown.includes('可打捞：**10** 个'), true)
  assert.equal(markdown.includes('## 🧴 瓶子类型'), false)
  assert.equal(markdown.includes('## 👤 我的足迹'), false)
  assert.equal(markdown.includes('📚 图文瓶：**7** 个'), false)
  assert.equal(markdown.includes('我扔出的瓶子：**4** 个'), false)

  const fallback = buildMainMenuBundle('onebot', statistics)
  assert.equal(fallback.primary.type, 'message')
  assert.equal(fallback.primary.children[0].attrs.content.includes('【当前海域统计】'), true)
  assert.equal(fallback.primary.children[0].attrs.content.includes('可打捞：10 个'), true)
  assert.equal(fallback.primary.children[0].attrs.content.includes('图文瓶：7 个'), false)
  assert.equal(fallback.primary.children[0].attrs.content.includes('我扔出的瓶子：4 个'), false)
})
