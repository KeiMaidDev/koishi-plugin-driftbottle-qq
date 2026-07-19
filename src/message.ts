import { h, type Session } from 'koishi'
import type { DiftInfo, HistoryInfoList } from '.'
import type { WebBottleData } from './webBottle'
import type { ReportScope } from './report'

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

export interface BottleActionPermissions {
  canBan?: boolean
  canDeleteComments?: boolean
}

export interface AssetTransformer {
  transform(content: string): Promise<string>
}

export interface CanvasImageResource {
  readonly naturalWidth: number
  readonly naturalHeight: number
  dispose(): Promise<void>
}

export interface CanvasImageLoader {
  loadImage(source: string): Promise<CanvasImageResource>
}

export interface MarkdownImageDimensions {
  width: number
  height: number
}

export interface LogDisplayItem {
  time: number
  info: string
  isNew: boolean
}

const MARKDOWN_SPECIALS = new Set(['\\', '`', '*', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '_', '>'])
export const QQ_MARKDOWN_IMAGE_MAX_WIDTH = 1024
export const QQ_MARKDOWN_IMAGE_MAX_HEIGHT = 1024

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

export function createBottleKeyboard(
  id: string | number,
  scope: ReportScope,
  permissions: BottleActionPermissions = {},
): QQKeyboard {
  const comment = scope === 'cloud' ? '云留言 ' + id + ' ' : '留言 ' + id + ' '
  const scoop = scope === 'cloud' ? '捞云漂流瓶' : '捞漂流瓶'
  const rows: Array<{ buttons: QQKeyboardButton[] }> = [
    { buttons: [commandButton('留言', comment, false), commandButton('再捞一个', scoop, true)] },
    {
      buttons: [
        commandButton('举报该瓶', '举报漂流瓶 ' + id + ' ' + scope, true, 0),
        commandButton('查看记录', '查看瓶子记录', true, 0),
      ],
    },
  ]
  if (scope === 'local' && (permissions.canBan || permissions.canDeleteComments)) {
    const managementButtons: QQKeyboardButton[] = []
    if (permissions.canBan) managementButtons.push(commandButton('封禁瓶子', '封漂流瓶 ' + id, true))
    if (permissions.canDeleteComments) managementButtons.push(commandButton('删除留言', '删留言 ' + id, true, 0))
    rows.push({ buttons: managementButtons })
  }
  return { content: { rows } }
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

export function fitMarkdownImageDimensions(
  width: number,
  height: number,
  maxWidth = QQ_MARKDOWN_IMAGE_MAX_WIDTH,
  maxHeight = QQ_MARKDOWN_IMAGE_MAX_HEIGHT,
): MarkdownImageDimensions {
  if (![width, height, maxWidth, maxHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Image dimensions and limits must be positive finite numbers.')
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export async function resolveMarkdownImageDimensions(
  source: string,
  canvas?: CanvasImageLoader,
  fallbackSource?: string,
): Promise<MarkdownImageDimensions> {
  const fallback = { width: QQ_MARKDOWN_IMAGE_MAX_WIDTH, height: QQ_MARKDOWN_IMAGE_MAX_HEIGHT }
  if (!canvas) return fallback

  const candidates = [...new Set([source, fallbackSource].filter((value): value is string => Boolean(value)))]
  for (const candidate of candidates) {
    let image: CanvasImageResource | undefined
    try {
      image = await canvas.loadImage(candidate)
      return fitMarkdownImageDimensions(image.naturalWidth, image.naturalHeight)
    } catch {
      // Try the Assets public URL when the original source cannot be loaded.
    } finally {
      if (image) {
        try {
          await image.dispose()
        } catch {
          // Dimension lookup succeeded; disposal failure must not block the bottle message.
        }
      }
    }
  }
  return fallback
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
  canvas: CanvasImageLoader | undefined,
  failedMedia: ReturnType<typeof h>[],
  altPrefix: string,
): Promise<string[]> {
  const markdownImages: string[] = []
  for (const [index, source] of sources.entries()) {
    const publicUrl = await resolveAssetImageUrl(source, assets)
    if (publicUrl) {
      const dimensions = await resolveMarkdownImageDimensions(source, canvas, publicUrl)
      markdownImages.push(buildMarkdownImage(
        publicUrl,
        altPrefix + ' ' + (index + 1),
        dimensions.width,
        dimensions.height,
      ))
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
  permissions: BottleActionPermissions = {},
  canvas?: CanvasImageLoader,
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
    '发送“举报漂流瓶 ' + bottle.id + ' local”可以举报。',
    ...(permissions.canBan ? ['发送“封漂流瓶 ' + bottle.id + '”可以封禁该瓶。'] : []),
    ...(permissions.canDeleteComments ? ['发送“删留言 ' + bottle.id + '”可以管理留言。'] : []),
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

  const markdownImages = await resolveQqMarkdownImages(sourceImages, assets, canvas, media, '漂流瓶图片')
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
      keyboard: createBottleKeyboard(bottle.id, 'local', permissions),
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
  canvas?: CanvasImageLoader,
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
    '发送“举报漂流瓶 ' + bottle.id + ' cloud”可以举报。',
  ].join('\n')

  const fallback = h('message', {}, [h.text(fallbackText)])
  const contentSources = (bottle.content.image || []).filter(Boolean)
  const reviewSources = bottle.review.flatMap(item => (item.image || []).filter(Boolean))
  const fallbackMedia = [...imageElements(contentSources), ...imageElements(reviewSources)]
  const media: ReturnType<typeof h>[] = []

  if (platform !== 'qq') {
    return { primary: fallback, media: fallbackMedia, fallback, fallbackMedia }
  }

  const contentImages = await resolveQqMarkdownImages(contentSources, assets, canvas, media, '云漂流瓶图片')
  const reviewImages = await resolveQqMarkdownImages(reviewSources, assets, canvas, media, '留言图片')
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

export interface ReportAdminNotice {
  scope: ReportScope
  bottleId: string
  reportCount: number
  threshold: number
  reporterId: string
  title?: string
  authorId?: string
}

function createReportReviewKeyboard(scope: ReportScope, bottleId: string): QQKeyboard {
  const viewCommand = scope === 'cloud' ? '捞云漂流瓶 ' + bottleId : '捞漂流瓶 ' + bottleId
  const buttons = [commandButton(scope === 'cloud' ? '查看云瓶' : '查看瓶子', viewCommand, true)]
  if (scope === 'local') buttons.push(commandButton('封禁瓶子', '封漂流瓶 ' + bottleId, true, 0))
  return { content: { rows: [{ buttons }] } }
}

export function buildReportAdminBundle(notice: ReportAdminNotice, platform: string): BottleMessageBundle {
  const scopeLabel = notice.scope === 'cloud' ? '云漂流瓶' : '本地漂流瓶'
  const fallbackText = [
    '【漂流瓶举报审核】',
    scopeLabel + ' #' + notice.bottleId + ' 的举报数量已达到阈值。',
    '举报数量：' + notice.reportCount + ' / ' + notice.threshold,
    '最近举报人：' + notice.reporterId,
    ...(notice.title ? ['标题：' + notice.title] : []),
    ...(notice.authorId ? ['作者：' + notice.authorId] : []),
    '请管理员尽快查看内容并决定是否处理。',
  ].join('\n')
  const fallback = h('message', {}, [h.text(fallbackText)])
  if (platform !== 'qq') {
    return { primary: fallback, media: [], fallback, fallbackMedia: [] }
  }
  const markdown = [
    '# 漂流瓶举报审核',
    '> ' + scopeLabel + ' #' + escapeQQMarkdown(notice.bottleId) + ' 的举报数量已达到阈值。',
    '',
    '- 举报数量：' + notice.reportCount + ' / ' + notice.threshold,
    '- 最近举报人：' + escapeQQMarkdown(notice.reporterId),
    ...(notice.title ? ['- 标题：' + escapeQQMarkdown(notice.title)] : []),
    ...(notice.authorId ? ['- 作者：' + escapeQQMarkdown(notice.authorId)] : []),
    '',
    '请管理员尽快查看内容并决定是否处理。',
  ].join('\n')
  return {
    primary: h('qq:rawmarkdown', {
      markdown: { content: markdown },
      keyboard: createReportReviewKeyboard(notice.scope, notice.bottleId),
    }),
    media: [],
    fallback,
    fallbackMedia: [],
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

function historyTypeIcon(type: HistoryInfoList['type']) {
  if (type === '语音瓶') return '🎧'
  if (type === '图片瓶') return '🖼️'
  if (type === '图文瓶') return '📚'
  return '📝'
}

function createHistoryKeyboard(): QQKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            commandButton('读取指定瓶子', '捞漂流瓶 ', false),
            commandButton('再捞一个', '捞漂流瓶', true),
          ],
        },
        {
          buttons: [
            commandButton('查看日志', '漂流瓶日志', true, 0),
            commandButton('返回菜单', '漂流瓶', true, 0),
          ],
        },
      ],
    },
  }
}

function createLogKeyboard(): QQKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            commandButton('查看捞瓶记录', '查看瓶子记录', true),
            commandButton('再捞一个', '捞漂流瓶', true),
          ],
        },
        {
          buttons: [
            commandButton('查看生态统计', '漂流瓶统计', true, 0),
            commandButton('返回菜单', '漂流瓶', true, 0),
          ],
        },
      ],
    },
  }
}

export function buildLogText(items: LogDisplayItem[], markdown: boolean): string {
  if (!markdown) {
    if (!items.length) return '【漂流瓶日志】\n当前没有任何日志。'
    return [
      '【漂流瓶日志】',
      '本次显示最近 ' + items.length + ' 条日志。',
      '',
      ...items.flatMap((item, index) => [
        String(index + 1) + '. ' + (item.isNew ? '[新消息]' : '[已读]') + ' ' + formatTime(item.time),
        '   ' + item.info,
      ]),
    ].join('\n')
  }

  if (!items.length) {
    return [
      '# 漂流瓶日志',
      '> 当前没有任何日志，去大海里进行一次操作后再来看看吧。',
    ].join('\n')
  }
  return [
    '# 漂流瓶日志',
    '> 本次显示最近 ' + items.length + ' 条日志；打开后未读日志会自动标记为已读。',
    '',
    '---',
    '',
    ...items.flatMap((item, index) => [
      '### ' + (index + 1) + '. ' + (item.isNew ? '🆕 新消息' : '✅ 已读'),
      '> ' + escapeQQMarkdown(formatTime(item.time)),
      escapeQQMarkdown(item.info),
      '',
    ]),
  ].join('\n').trimEnd()
}

export function buildHistoryText(items: HistoryInfoList[], total: number, markdown: boolean): string {
  if (!markdown) {
    if (!items.length) return '【捞瓶记录】\n你还没有捞到过任何漂流瓶。'
    return [
      '【捞瓶记录】',
      '当前显示最近 ' + items.length + ' / ' + total + ' 条。',
      '',
      ...items.map((item, index) =>
        String(index + 1) + '. ' + item.type + ' #' + item.id + '（发布者：' + displayName(item.username, item.userId) + '）'
      ),
    ].join('\n')
  }

  if (!items.length) {
    return [
      '# 捞瓶记录',
      '> 你还没有捞到过任何漂流瓶，点击下方“再捞一个”开始第一次打捞吧。',
    ].join('\n')
  }
  return [
    '# 捞瓶记录',
    '> 已记录 ' + total + ' 条，当前显示最近 ' + items.length + ' 条。',
    '',
    '---',
    '',
    ...items.flatMap((item, index) => [
      '### ' + (index + 1) + '. ' + historyTypeIcon(item.type) + ' ' + escapeQQMarkdown(item.type) + ' #' + item.id,
      '> 发布者：' + escapeQQMarkdown(displayName(item.username, item.userId)),
      '',
    ]),
  ].join('\n').trimEnd()
}

export function buildLogBundle(items: LogDisplayItem[], platform: string): BottleMessageBundle {
  const fallback = h('message', {}, [h.text(buildLogText(items, false))])
  if (platform !== 'qq') return { primary: fallback, media: [], fallback, fallbackMedia: [] }
  return {
    primary: h('qq:rawmarkdown', {
      markdown: { content: buildLogText(items, true) },
      keyboard: createLogKeyboard(),
    }),
    media: [],
    fallback,
    fallbackMedia: [],
  }
}

export function buildHistoryBundle(
  items: HistoryInfoList[],
  total: number,
  platform: string,
): BottleMessageBundle {
  const fallback = h('message', {}, [h.text(buildHistoryText(items, total, false))])
  if (platform !== 'qq') return { primary: fallback, media: [], fallback, fallbackMedia: [] }
  return {
    primary: h('qq:rawmarkdown', {
      markdown: { content: buildHistoryText(items, total, true) },
      keyboard: createHistoryKeyboard(),
    }),
    media: [],
    fallback,
    fallbackMedia: [],
  }
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
