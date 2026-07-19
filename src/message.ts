import { h, type Session } from 'koishi'
import type { DiftInfo, HistoryInfoList } from '.'
import type { WebBottleData } from './webBottle'

export interface QQKeyboardButton {
  render_data: { label: string; style: number }
  action: {
    type: 2
    permission: { type: 2 }
    data: string
    enter: boolean
  }
}

export interface QQKeyboard {
  content: { rows: Array<{ buttons: QQKeyboardButton[] }> }
}

export interface BottleMessageBundle {
  primary: ReturnType<typeof h>
  media: ReturnType<typeof h>[]
  fallback: ReturnType<typeof h>
  fallbackMedia: ReturnType<typeof h>[]
}

export interface AssetTransformer {
  transform(content: string): Promise<string>
}

export interface LogDisplayItem {
  time: number
  info: string
  isNew: boolean
}

const MARKDOWN_SPECIALS = new Set(['\\', '`', '*', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '_', '>'])

export function escapeQQMarkdown(value: unknown): string {
  return Array.from(String(value ?? ''), character => {
    return MARKDOWN_SPECIALS.has(character) ? '\\' + character : character
  }).join('')
}

function commandButton(label: string, data: string, enter: boolean, style = 1): QQKeyboardButton {
  return {
    render_data: { label, style },
    action: { type: 2, permission: { type: 2 }, data, enter },
  }
}

export function createBottleKeyboard(id: string | number, scope: 'local' | 'cloud'): QQKeyboard {
  const comment = scope === 'cloud' ? '云留言 ' + id + ' ' : '留言 ' + id + ' '
  const scoop = scope === 'cloud' ? '捞云漂流瓶' : '捞漂流瓶'
  return {
    content: {
      rows: [
        { buttons: [commandButton('留言', comment, false), commandButton('再捞一个', scoop, true)] },
        { buttons: [commandButton('查看记录', '查看瓶子记录', true, 0)] },
      ],
    },
  }
}

export function createMainKeyboard(): QQKeyboard {
  return {
    content: {
      rows: [
        { buttons: [commandButton('捞漂流瓶', '捞漂流瓶', true), commandButton('扔漂流瓶', '扔漂流瓶 ', false)] },
        { buttons: [commandButton('捞云漂流瓶', '捞云漂流瓶', true), commandButton('扔云漂流瓶', '扔云漂流瓶 ', false)] },
        { buttons: [commandButton('查看记录', '查看瓶子记录', true, 0), commandButton('查看日志', '漂流瓶日志', true, 0)] },
      ],
    },
  }
}

function publicHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

export async function resolveAssetImageUrl(
  source: string,
  assets?: AssetTransformer,
): Promise<string | null> {
  if (!assets) return null
  try {
    const transformed = await assets.transform(h.image(source).toString())
    const elements = h.parse(transformed).filter(element => {
      return element.type !== 'text' || String(element.attrs.content || '').trim()
    })
    if (elements.length !== 1 || elements[0].type !== 'img') return null
    if (elements[0].children.length || typeof elements[0].attrs.src !== 'string') return null
    return publicHttpUrl(elements[0].attrs.src)
  } catch {
    return null
  }
}

export function buildMarkdownImage(url: string, alt: string, width = 1024, height = 1024): string {
  const publicUrl = publicHttpUrl(url)
  if (!publicUrl) throw new TypeError('QQ Markdown image requires an absolute HTTP(S) URL.')
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError('QQ Markdown image dimensions must be positive integers.')
  }
  const safeUrl = publicUrl.replaceAll('(', '%28').replaceAll(')', '%29')
  return '![' + escapeQQMarkdown(alt) + ' #' + width + 'px #' + height + 'px](' + safeUrl + ')'
}

function formatTime(value: number | string): string {
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return String(value ?? '')
  const pad = (part: number) => String(part).padStart(2, '0')
  return [
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()),
    pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()),
  ].join(' ')
}

function displayName(username: string | undefined, userId: string | undefined): string {
  return username || userId || '匿名'
}

function imageElements(sources: readonly string[] | null | undefined): ReturnType<typeof h>[] {
  return (sources || []).filter(Boolean).map(source => h.image(source))
}

function audioElements(sources: readonly string[] | null | undefined): ReturnType<typeof h>[] {
  return (sources || []).filter(Boolean).map(source => h.audio(source))
}

async function resolveQqMarkdownImages(
  sources: readonly string[],
  assets: AssetTransformer | undefined,
  failedMedia: ReturnType<typeof h>[],
  altPrefix: string,
): Promise<string[]> {
  const markdownImages: string[] = []
  for (const [index, source] of sources.entries()) {
    const publicUrl = await resolveAssetImageUrl(source, assets)
    if (publicUrl) {
      markdownImages.push(buildMarkdownImage(publicUrl, altPrefix + ' ' + (index + 1)))
    } else {
      failedMedia.push(h.image(source))
    }
  }
  return markdownImages
}

function localReviewText(bottle: DiftInfo): string {
  if (!bottle.review.length) return '暂无留言'
  return bottle.review.map((item, index) => {
    const content = item.isDel ? '管理员已删除该条评论' : item.text || '（无文字内容）'
    return String(index + 1) + '. ' + displayName(item.username, item.userId || '匿名') + '：' + content
  }).join('\n')
}

export async function buildLocalBottleMessages(
  bottle: DiftInfo,
  platform: string,
  assets?: AssetTransformer,
): Promise<BottleMessageBundle> {
  const commentText = localReviewText(bottle)
  const fallbackText = [
    '【' + (bottle.content.title || '漂流瓶 #' + bottle.id) + '】',
    '编号：' + bottle.id,
    '作者：' + displayName(bottle.username, bottle.userId),
    '被捞次数：' + bottle.getCount,
    '创建时间：' + formatTime(bottle.content.creatTime),
    '',
    bottle.content.text || '（无文字内容）',
    '',
    '留言：',
    commentText,
    '',
    '发送“留言 ' + bottle.id + ' 你的内容”可以留言。',
  ].join('\n')

  const fallback = h('message', {}, [h.text(fallbackText)])
  const sourceImages = (bottle.content.image || []).filter(Boolean)
  const fallbackMedia = [
    ...imageElements(sourceImages),
    ...audioElements(bottle.content.audio),
  ]
  const media = [...audioElements(bottle.content.audio)]
  if (platform !== 'qq') {
    return { primary: fallback, media: fallbackMedia, fallback, fallbackMedia }
  }

  const markdownImages = await resolveQqMarkdownImages(sourceImages, assets, media, '漂流瓶图片')
  const markdown = [
    '# ' + escapeQQMarkdown(bottle.content.title || '漂流瓶 #' + bottle.id),
    '> 编号：' + bottle.id + ' ｜ 作者：' + escapeQQMarkdown(displayName(bottle.username, bottle.userId)),
    '> 被捞：' + bottle.getCount + ' 次 ｜ 创建时间：' + escapeQQMarkdown(formatTime(bottle.content.creatTime)),
    '',
    escapeQQMarkdown(bottle.content.text || '（无文字内容）'),
    ...(markdownImages.length ? ['', ...markdownImages] : []),
    '',
    '## 留言',
    escapeQQMarkdown(commentText),
  ].join('\n')

  return {
    primary: h('qq:rawmarkdown', {
      markdown: { content: markdown },
      keyboard: createBottleKeyboard(bottle.id, 'local'),
    }),
    media,
    fallback,
    fallbackMedia,
  }
}

export async function buildCloudBottleMessages(
  bottle: WebBottleData,
  platform: string,
  assets?: AssetTransformer,
): Promise<BottleMessageBundle> {
  const fallbackComments = bottle.review.length
    ? bottle.review.map((item, index) =>
      String(index + 1) + '. ' + item.userId + '：' + (item.text || '（无文字内容）')
    ).join('\n')
    : '暂无留言'

  const fallbackText = [
    '【' + (bottle.content.title || '云漂流瓶 #' + bottle.id) + '】',
    '编号：' + bottle.id,
    '作者：' + bottle.content.userId,
    '来源：' + bottle.platform,
    '被捞次数：' + bottle.getCount,
    '创建时间：' + formatTime(bottle.content.createTime),
    '',
    bottle.content.text || '（无文字内容）',
    '',
    '留言：',
    fallbackComments,
    '',
    '发送“云留言 ' + bottle.id + ' 你的内容”可以留言。',
  ].join('\n')

  const fallback = h('message', {}, [h.text(fallbackText)])
  const contentSources = (bottle.content.image || []).filter(Boolean)
  const reviewSources = bottle.review.flatMap(item => (item.image || []).filter(Boolean))
  const fallbackMedia = [...imageElements(contentSources), ...imageElements(reviewSources)]
  const media: ReturnType<typeof h>[] = []

  if (platform !== 'qq') {
    return { primary: fallback, media: fallbackMedia, fallback, fallbackMedia }
  }

  const contentImages = await resolveQqMarkdownImages(contentSources, assets, media, '云漂流瓶图片')
  const reviewImages = await resolveQqMarkdownImages(reviewSources, assets, media, '留言图片')
  const markdownComments = bottle.review.length
    ? bottle.review.map((item, index) =>
      String(index + 1) + '. ' + escapeQQMarkdown(item.userId) + '：' + escapeQQMarkdown(item.text || '（无文字内容）')
    ).join('\n')
    : '暂无留言'

  const markdown = [
    '# ' + escapeQQMarkdown(bottle.content.title || '云漂流瓶 #' + bottle.id),
    '> 编号：' + escapeQQMarkdown(bottle.id) + ' ｜ 作者：' + escapeQQMarkdown(bottle.content.userId),
    '> 来源：' + escapeQQMarkdown(bottle.platform) + ' ｜ 被捞：' + bottle.getCount + ' 次',
    '> 创建时间：' + escapeQQMarkdown(formatTime(bottle.content.createTime)),
    '',
    escapeQQMarkdown(bottle.content.text || '（无文字内容）'),
    ...(contentImages.length ? ['', ...contentImages] : []),
    '',
    '## 留言',
    markdownComments,
    ...(reviewImages.length ? ['', ...reviewImages] : []),
  ].join('\n')

  return {
    primary: h('qq:rawmarkdown', {
      markdown: { content: markdown },
      keyboard: createBottleKeyboard(bottle.id, 'cloud'),
    }),
    media,
    fallback,
    fallbackMedia,
  }
}

export function buildMainMenuBundle(platform: string): BottleMessageBundle {
  const fallbackText = [
    '【漂流瓶】',
    '捞漂流瓶：从本地大海随机获取一个瓶子',
    '扔漂流瓶：发布本地漂流瓶',
    '捞云漂流瓶：从云端大海获取瓶子',
    '扔云漂流瓶：发布云端漂流瓶',
    '查看瓶子记录：查看自己捞到过的瓶子',
    '漂流瓶日志：查看漂流瓶事件日志',
  ].join('\n')
  const fallback = h('message', {}, [h.text(fallbackText)])
  if (platform !== 'qq') {
    return { primary: fallback, media: [], fallback, fallbackMedia: [] }
  }
  const markdown = [
    '# 漂流瓶',
    '> 点击下方按钮选择操作，也可以继续直接发送原命令。',
    '',
    '## 本地大海',
    '- 捞取或投放保存在当前 Koishi 实例中的漂流瓶。',
    '',
    '## 云端大海',
    '- 捞取或投放能够跨机器人流转的云漂流瓶。',
  ].join('\n')
  return {
    primary: h('qq:rawmarkdown', {
      markdown: { content: markdown },
      keyboard: createMainKeyboard(),
    }),
    media: [],
    fallback,
    fallbackMedia: [],
  }
}

export function buildAuxiliaryMessage(content: string, platform: string): ReturnType<typeof h> {
  if (platform === 'qq') return h('qq:rawmarkdown-without-keyboard', { content })
  return h.text(content)
}

export function buildLogText(items: LogDisplayItem[], markdown: boolean): string {
  if (!items.length) return '## 漂流瓶日志\n暂无日志'
  return ['## 漂流瓶日志', ...items.map((item, index) => {
    const marker = item.isNew ? '新' : '已读'
    const info = markdown ? escapeQQMarkdown(item.info) : item.info
    return String(index + 1) + '. [' + marker + '] ' + formatTime(item.time) + '  ' + info
  })].join('\n')
}

export function buildHistoryText(items: HistoryInfoList[], total: number, markdown: boolean): string {
  return [
    '## 捞瓶历史',
    '> 显示 ' + items.length + ' / ' + total + ' 条',
    ...(items.length ? items.map((item, index) =>
      String(index + 1) + '. ' + (markdown ? escapeQQMarkdown(item.type) : item.type) + ' #' + item.id
    ) : ['暂无记录']),
  ].join('\n')
}

export function buildCommentSelectionText(bottle: DiftInfo, markdown: boolean): string {
  const lines = bottle.review.map((item, index) => {
    const content = item.isDel ? '管理员已删除该条评论' : item.text || '（无文字内容）'
    const raw = displayName(item.username, item.userId || '匿名') + '：' + content
    return String(index + 1) + '. ' + (markdown ? escapeQQMarkdown(raw) : raw)
  })
  return [
    '漂流瓶 #' + bottle.id + ' 的留言',
    ...(lines.length ? lines : ['暂无可删除留言']),
    '',
    '请发送需要删除的留言序号。',
  ].join('\n')
}

export async function sendBottleBundle(session: Session, bundle: BottleMessageBundle): Promise<void> {
  let media = bundle.media
  if (session.platform === 'qq') {
    try {
      await session.send(bundle.primary)
    } catch (error) {
      session.bot.ctx.logger('smmcat-driftbottle').warn(error, 'QQ 原生 Markdown 发送失败，改用通用消息')
      await session.send(bundle.fallback)
      media = bundle.fallbackMedia
    }
  } else {
    await session.send(bundle.fallback)
    media = bundle.fallbackMedia
  }
  for (const element of media) await session.send(element)
}
