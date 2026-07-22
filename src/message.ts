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

export interface BottleStatistics {
  total: number
  hidden: number
  neverScooped: number
  reviewTotal: number
  own: number
  reviewed: number
  typeCounts: Record<string, number>
}

const MARKDOWN_SPECIALS = new Set(['\\', '`', '*', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '_', '>'])
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"']+/giu
const HTTP_URL_TRAILING_PUNCTUATION = new Set(['.', ',', '!', '?', ';', ':', '，', '。', '！', '？', '；', '：', '、'])
export const QQ_MARKDOWN_IMAGE_MAX_WIDTH = 1024
export const QQ_MARKDOWN_IMAGE_MAX_HEIGHT = 1024
export const QQ_MARKDOWN_COMMENT_IMAGE_MAX_WIDTH = 600
export const QQ_MARKDOWN_COMMENT_IMAGE_MAX_HEIGHT = 600

export function escapeQQMarkdown(value: unknown): string {
  return Array.from(String(value ?? ''), character => {
    return MARKDOWN_SPECIALS.has(character) ? '\\' + character : character
  }).join('')
}

function splitHttpUrlTail(candidate: string): [string, string] {
  let url = candidate
  let suffix = ''
  while (url && HTTP_URL_TRAILING_PUNCTUATION.has(url.at(-1)!)) {
    suffix = url.at(-1) + suffix
    url = url.slice(0, -1)
  }

  const pairs = [['(', ')'], ['[', ']']] as const
  for (const [opening, closing] of pairs) {
    let balance = Array.from(url).reduce((count, character) => {
      if (character === opening) return count + 1
      if (character === closing) return count - 1
      return count
    }, 0)
    while (balance < 0 && url.endsWith(closing)) {
      suffix = closing + suffix
      url = url.slice(0, -1)
      balance++
    }
  }
  return [url, suffix]
}

export function escapeQQMarkdownWithLinks(value: unknown): string {
  const text = String(value ?? '')
  let result = ''
  let offset = 0
  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const index = match.index ?? 0
    result += escapeQQMarkdown(text.slice(offset, index))
    const [url, suffix] = splitHttpUrlTail(match[0])
    result += url + suffix
    offset = index + match[0].length
  }
  return result + escapeQQMarkdown(text.slice(offset))
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
        { buttons: [commandButton('漂流瓶统计', '漂流瓶统计', true, 0)] },
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
  maxWidth = QQ_MARKDOWN_IMAGE_MAX_WIDTH,
  maxHeight = QQ_MARKDOWN_IMAGE_MAX_HEIGHT,
): Promise<MarkdownImageDimensions> {
  const fallback = { width: maxWidth, height: maxHeight }
  if (!canvas) return fallback

  const candidates = [...new Set([source, fallbackSource].filter((value): value is string => Boolean(value)))]
  for (const candidate of candidates) {
    let image: CanvasImageResource | undefined
    try {
      image = await canvas.loadImage(candidate)
      return fitMarkdownImageDimensions(image.naturalWidth, image.naturalHeight, maxWidth, maxHeight)
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
  maxWidth = QQ_MARKDOWN_IMAGE_MAX_WIDTH,
  maxHeight = QQ_MARKDOWN_IMAGE_MAX_HEIGHT,
): Promise<string[]> {
  const markdownImages: string[] = []
  for (const [index, source] of sources.entries()) {
    const publicUrl = await resolveAssetImageUrl(source, assets)
    if (publicUrl) {
      const dimensions = await resolveMarkdownImageDimensions(source, canvas, publicUrl, maxWidth, maxHeight)
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

function localReviewText(reviews: DiftInfo['review']): string {
  if (!reviews.length) return '暂无留言'
  return reviews.map((item, index) => {
    const content = item.text || '（无文字内容）'
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
  const visibleReviews = bottle.review.filter(item => !item.isDel)
  const commentText = localReviewText(visibleReviews)
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
  const reviewSources = visibleReviews
    .flatMap(item => (item.image || []).filter(Boolean))
  const fallbackMedia = [
    ...imageElements(sourceImages),
    ...imageElements(reviewSources),
    ...audioElements(bottle.content.audio),
  ]
  const media = [...audioElements(bottle.content.audio)]
  if (platform !== 'qq') {
    return { primary: fallback, media: fallbackMedia, fallback, fallbackMedia }
  }

  const markdownImages = await resolveQqMarkdownImages(sourceImages, assets, canvas, media, '漂流瓶图片')
  const markdownReviews: string[] = []
  if (!visibleReviews.length) {
    markdownReviews.push('暂无留言')
  } else {
    for (const [index, item] of visibleReviews.entries()) {
      const content = item.text || '（无文字内容）'
      markdownReviews.push(escapeQQMarkdownWithLinks(
        String(index + 1) + '. ' + displayName(item.username, item.userId || '匿名') + '：' + content,
      ))
      const images = await resolveQqMarkdownImages(
        (item.image || []).filter(Boolean),
        assets,
        canvas,
        media,
        '留言 ' + (index + 1) + ' 图片',
        QQ_MARKDOWN_COMMENT_IMAGE_MAX_WIDTH,
        QQ_MARKDOWN_COMMENT_IMAGE_MAX_HEIGHT,
      )
      if (images.length) markdownReviews.push(...images)
      if (index < visibleReviews.length - 1) markdownReviews.push('')
    }
  }
  const markdown = [
    '# ' + escapeQQMarkdownWithLinks(bottle.content.title || '漂流瓶 #' + bottle.id),
    '> 编号：' + bottle.id + ' ｜ 作者：' + escapeQQMarkdown(displayName(bottle.username, bottle.userId)),
    '> 被捞：' + bottle.getCount + ' 次 ｜ 创建时间：' + escapeQQMarkdown(formatTime(bottle.content.creatTime)),
    '',
    escapeQQMarkdownWithLinks(bottle.content.text || '（无文字内容）'),
    ...(markdownImages.length ? ['', ...markdownImages] : []),
    '',
    '## 留言',
    ...markdownReviews,
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
  const markdownComments: string[] = []
  if (!bottle.review.length) {
    markdownComments.push('暂无留言')
  } else {
    for (const [index, item] of bottle.review.entries()) {
      markdownComments.push(
        String(index + 1) + '. ' + escapeQQMarkdown(item.userId) + '：' + escapeQQMarkdownWithLinks(item.text || '（无文字内容）'),
      )
      const images = await resolveQqMarkdownImages(
        (item.image || []).filter(Boolean),
        assets,
        canvas,
        media,
        '留言 ' + (index + 1) + ' 图片',
        QQ_MARKDOWN_COMMENT_IMAGE_MAX_WIDTH,
        QQ_MARKDOWN_COMMENT_IMAGE_MAX_HEIGHT,
      )
      if (images.length) markdownComments.push(...images)
      if (index < bottle.review.length - 1) markdownComments.push('')
    }
  }

  const markdown = [
    '# ' + escapeQQMarkdownWithLinks(bottle.content.title || '云漂流瓶 #' + bottle.id),
    '> 编号：' + escapeQQMarkdown(bottle.id) + ' ｜ 作者：' + escapeQQMarkdown(bottle.content.userId),
    '> 来源：' + escapeQQMarkdown(bottle.platform) + ' ｜ 被捞：' + bottle.getCount + ' 次',
    '> 创建时间：' + escapeQQMarkdown(formatTime(bottle.content.createTime)),
    '',
    escapeQQMarkdownWithLinks(bottle.content.text || '（无文字内容）'),
    ...(contentImages.length ? ['', ...contentImages] : []),
    '',
    '## 留言',
    ...markdownComments,
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

function buildMainMenuStatisticsText(statistics: BottleStatistics, markdown: boolean): string {
  const available = Math.max(0, statistics.total - statistics.hidden)
  if (!markdown) {
    return [
      '【当前海域统计】',
      '漂流瓶总数：' + statistics.total + ' 个',
      '可打捞：' + available + ' 个',
      '已沉入海底：' + statistics.hidden + ' 个',
      '从未被捞到：' + statistics.neverScooped + ' 个',
      '留言总数：' + statistics.reviewTotal + ' 条',
    ].join('\n')
  }

  return [
    '## 🌊 当前海域',
    '- 漂流瓶总数：**' + statistics.total + '** 个',
    '- 可打捞：**' + available + '** 个',
    '- 已沉入海底：**' + statistics.hidden + '** 个',
    '- 从未被捞到：**' + statistics.neverScooped + '** 个',
    '- 留言总数：**' + statistics.reviewTotal + '** 条',
  ].join('\n')
}

export function buildMainMenuBundle(
  platform: string,
  statistics?: BottleStatistics,
): BottleMessageBundle {
  const fallbackText = [
    '【漂流瓶】',
    ...(statistics ? [buildMainMenuStatisticsText(statistics, false), ''] : []),
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
    ...(statistics ? ['', buildMainMenuStatisticsText(statistics, true)] : []),
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

export type ThrowBottlePromptStage = 'content' | 'image' | 'title'

export const THROW_BOTTLE_CANCEL_VALUE = '取消扔漂流瓶'
export const THROW_BOTTLE_SKIP_IMAGE_VALUE = '跳过配图'
export const THROW_BOTTLE_SKIP_TITLE_VALUE = '跳过标题'

function createThrowBottlePromptKeyboard(stage: ThrowBottlePromptStage): QQKeyboard {
  const buttons: QQKeyboardButton[] = []
  if (stage === 'image') {
    buttons.push(commandButton('跳过配图', THROW_BOTTLE_SKIP_IMAGE_VALUE, true, 0))
  } else if (stage === 'title') {
    buttons.push(commandButton('跳过标题', THROW_BOTTLE_SKIP_TITLE_VALUE, true, 0))
  }
  buttons.push(commandButton('取消扔瓶', THROW_BOTTLE_CANCEL_VALUE, true, 0))
  return { content: { rows: [{ buttons }] } }
}

export function buildThrowBottlePrompt(
  stage: ThrowBottlePromptStage,
  platform: string,
): ReturnType<typeof h> {
  const prompt = stage === 'content'
    ? {
        title: '填写漂流瓶内容',
        description: '请在 60 秒内发送文字、图片或音频作为瓶子内容。',
        hint: '也可以点击下方按钮取消本次操作。',
      }
    : stage === 'image'
      ? {
          title: '是否添加配图',
          description: '当前内容没有图片，请在 20 秒内发送图片作为补充。',
          hint: '不需要图片时，可以点击“跳过配图”。',
        }
      : {
          title: '是否添加标题',
          description: '请在 20 秒内发送漂流瓶标题。',
          hint: '不需要标题时，可以点击“跳过标题”。',
        }
  const fallbackText = [prompt.title, prompt.description, prompt.hint].join('\n')
  if (platform !== 'qq') return h.text(fallbackText)
  return h('qq:rawmarkdown', {
    markdown: {
      content: [
        '# ' + prompt.title,
        '> ' + prompt.description,
        '',
        prompt.hint,
      ].join('\n'),
    },
    keyboard: createThrowBottlePromptKeyboard(stage),
  })
}

function createThrowBottleResultKeyboard(): QQKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            commandButton('再扔一个', '扔漂流瓶 ', false),
            commandButton('捞一个', '捞漂流瓶', true),
          ],
        },
        { buttons: [commandButton('返回菜单', '漂流瓶', true, 0)] },
      ],
    },
  }
}

export function buildThrowBottleResultMessage(
  content: string,
  platform: string,
  success: boolean,
): ReturnType<typeof h> {
  if (platform !== 'qq') return h.text(content)
  return h('qq:rawmarkdown', {
    markdown: {
      content: [
        '# ' + (success ? '漂流瓶已投入大海' : '扔漂流瓶操作结束'),
        '',
        escapeQQMarkdownWithLinks(content),
      ].join('\n'),
    },
    keyboard: createThrowBottleResultKeyboard(),
  })
}

function historyTypeIcon(type: HistoryInfoList['type']) {
  if (type === '语音瓶') return '🎧'
  if (type === '图片瓶') return '🖼️'
  if (type === '图文瓶') return '📚'
  return '📝'
}

function statisticsTypeIcon(type: string): string {
  if (type === '语音瓶') return '🎧'
  if (type === '图片瓶') return '🖼️'
  if (type === '图文瓶') return '📚'
  return '📝'
}

function createStatisticsKeyboard(): QQKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            commandButton('再捞一个', '捞漂流瓶', true),
            commandButton('扔漂流瓶', '扔漂流瓶 ', false),
          ],
        },
        {
          buttons: [
            commandButton('查看记录', '查看瓶子记录', true, 0),
            commandButton('查看日志', '漂流瓶日志', true, 0),
          ],
        },
        { buttons: [commandButton('返回菜单', '漂流瓶', true, 0)] },
      ],
    },
  }
}

export function buildStatisticsText(statistics: BottleStatistics, markdown: boolean): string {
  const available = Math.max(0, statistics.total - statistics.hidden)
  const typeEntries = Object.entries(statistics.typeCounts)
  if (!markdown) {
    return [
      '【漂流瓶生态统计】',
      '海中共有 ' + statistics.total + ' 个漂流瓶，当前可打捞 ' + available + ' 个。',
      '已沉入海底：' + statistics.hidden + ' 个',
      '从未被捞到：' + statistics.neverScooped + ' 个',
      '留言总数：' + statistics.reviewTotal + ' 条',
      '',
      '【瓶子类型】',
      ...(typeEntries.length
        ? typeEntries.map(([type, count]) => type + '：' + count + ' 个')
        : ['暂无瓶子数据']),
      '',
      '【我的足迹】',
      '我扔出的瓶子：' + statistics.own + ' 个',
      '我留言过的瓶子：' + statistics.reviewed + ' 个',
    ].join('\n')
  }

  return [
    '# 漂流瓶生态统计',
    '> 当前本地大海共记录 ' + statistics.total + ' 个漂流瓶。',
    '',
    '## 🌊 海域概览',
    '- 可打捞：**' + available + '** 个',
    '- 已沉入海底：**' + statistics.hidden + '** 个',
    '- 从未被捞到：**' + statistics.neverScooped + '** 个',
    '- 留言总数：**' + statistics.reviewTotal + '** 条',
    '',
    '## 🧴 瓶子类型',
    ...(typeEntries.length
      ? typeEntries.map(([type, count]) => '- ' + statisticsTypeIcon(type) + ' ' + escapeQQMarkdown(type) + '：**' + count + '** 个')
      : ['> 暂无瓶子数据。']),
    '',
    '## 👤 我的足迹',
    '- 我扔出的瓶子：**' + statistics.own + '** 个',
    '- 我留言过的瓶子：**' + statistics.reviewed + '** 个',
  ].join('\n')
}

export function buildStatisticsBundle(statistics: BottleStatistics, platform: string): BottleMessageBundle {
  const fallback = h('message', {}, [
    h.image('https://smmcat.cn/run/plp.jpg'),
    h.text(buildStatisticsText(statistics, false)),
  ])
  if (platform !== 'qq') return { primary: fallback, media: [], fallback, fallbackMedia: [] }
  return {
    primary: h('qq:rawmarkdown', {
      markdown: { content: buildStatisticsText(statistics, true) },
      keyboard: createStatisticsKeyboard(),
    }),
    media: [],
    fallback,
    fallbackMedia: [],
  }
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
  const lines = bottle.review.filter(item => !item.isDel).map((item, index) => {
    const content = item.text || '（无文字内容）'
    const raw = displayName(item.username, item.userId || '匿名') + '：' + content
    return String(index + 1) + '. ' + (markdown ? escapeQQMarkdownWithLinks(raw) : raw)
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
