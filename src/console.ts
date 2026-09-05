import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Context } from 'koishi'
import type {} from '@koishijs/console'
import type {} from '@koishijs/plugin-server'
import type { Config, DiftInfo } from './index'
import type { BottleReportRegistry } from './report'
import {
  ConsoleService,
  consoleOperator,
  type ConsoleBottleDetail,
  type ConsoleLogInfo,
  type ConsoleOpResult,
  type ConsoleStats,
  type ListBottlesQuery,
  type ListBottlesResult,
  type PanelChangeAction,
} from './console-service'

declare module '@koishijs/console' {
  interface Events {
    'driftbottle-console/stats'(): ConsoleStats
    'driftbottle-console/list'(query: ListBottlesQuery): ListBottlesResult
    'driftbottle-console/bottle'(id: number): ConsoleBottleDetail | null
    'driftbottle-console/ban'(id: number): Promise<ConsoleOpResult>
    'driftbottle-console/unban'(id: number): Promise<ConsoleOpResult>
    'driftbottle-console/delete-review'(id: number, reviewIndex: number): Promise<ConsoleOpResult>
    'driftbottle-console/dismiss-report'(id: number): Promise<ConsoleOpResult>
    'driftbottle-console/media-token'(): string
  }
}

/** 面板事件名前缀，客户端通过同名事件请求与监听广播 */
export const CONSOLE_API_PREFIX = 'driftbottle-console'

export interface ConsoleGlue {
  driftbottle: {
    GetAllBottle(): DiftInfo[]
    updateStoreUser(userId: string): Promise<void>
    driftbottleType(bottle: DiftInfo): string
  }
  logs: {
    addLogForEvent(userId: string, info: ConsoleLogInfo): void
  }
  logTypes: { ban: number; unban: number; reviewDeleted: number }
  reportRegistry: BottleReportRegistry
  /** 多媒体文件根目录（downloadUilts.basePath） */
  mediaBasePath: string
  /** QQ 端操作引起的数据变更广播入口 */
  notifyChange(action: PanelChangeAction): void
}

interface ConsoleClientRef {
  auth?: { name?: string }
}

const MEDIA_TOKEN_TTL = 10 * 60_000

const opErrors: Record<string, string> = {
  not_found: '没有找到对应的漂流瓶。',
  already_banned: '该漂流瓶已经是封禁状态。',
  already_visible: '该漂流瓶已经是开放显示状态。',
  invalid_review: '没有找到对应的留言。',
  already_deleted: '该留言已经是删除状态。',
  no_report: '该漂流瓶没有举报记录。',
}

/**
 * 把存储中的媒体地址转换为控制台媒体路由 URL。
 * file:// 路径按现有路径修正逻辑的 basename 规则解析；
 * http(s) 直链原样返回；其余无法解析的返回 null（前端降级占位）。
 */
export function toMediaRoutePath(url: string | null | undefined, kind: 'image' | 'audio'): string | null {
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  if (!url.startsWith('file://')) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(url).pathname)
  } catch {
    return null
  }
  const base = path.basename(pathname)
  if (!base || base === '.' || base === '..') return null
  return `/${CONSOLE_API_PREFIX}/media/${kind}/${encodeURIComponent(base)}`
}

export const setupConsole = Object.assign(
  function setupConsole(ctx: Context, options: { config: Config; glue: ConsoleGlue }) {
  const { config, glue } = options
  // console 服务未就绪时，cordis 会在其可用后重新加载本子插件
  if (!ctx.console) return

  const logger = ctx.logger('driftbottle-console')

  const service = new ConsoleService({
    getBottles: () => glue.driftbottle.GetAllBottle(),
    persistBottle: (userId) => glue.driftbottle.updateStoreUser(userId),
    bottleType: (bottle) => glue.driftbottle.driftbottleType(bottle),
    reportRegistry: glue.reportRegistry,
    threshold: config.reportThreshold,
    addLog: (userId, info) => glue.logs.addLogForEvent(userId, info),
    logTypes: glue.logTypes,
    mediaResolver: toMediaRoutePath,
    notifyChange: (action) => glue.notifyChange(action),
  })

  const operatorOf = (client: ConsoleClientRef) => consoleOperator(client.auth?.name ?? 'unknown')

  ctx.console.addListener(`${CONSOLE_API_PREFIX}/stats`, () => service.getStats())
  ctx.console.addListener(`${CONSOLE_API_PREFIX}/list`, (query) => service.listBottles(query ?? {}))
  ctx.console.addListener(`${CONSOLE_API_PREFIX}/bottle`, (id) => service.getBottle(Number(id)))

  ctx.console.addListener(`${CONSOLE_API_PREFIX}/ban`, async function (id) {
    const result = await service.banBottle(Number(id), operatorOf(this))
    if (result.ok === false) throw new Error(opErrors[result.reason])
    return result
  })
  ctx.console.addListener(`${CONSOLE_API_PREFIX}/unban`, async function (id) {
    const result = await service.unbanBottle(Number(id), operatorOf(this))
    if (result.ok === false) throw new Error(opErrors[result.reason])
    return result
  })
  ctx.console.addListener(`${CONSOLE_API_PREFIX}/delete-review`, async function (id, reviewIndex) {
    const result = await service.deleteReview(Number(id), Number(reviewIndex), operatorOf(this))
    if (result.ok === false) throw new Error(opErrors[result.reason])
    return result
  })
  ctx.console.addListener(`${CONSOLE_API_PREFIX}/dismiss-report`, async function (id) {
    const operator = operatorOf(this)
    const result = await service.dismissReport(Number(id), operator)
    if (result.ok === false) throw new Error(opErrors[result.reason])
    // 忽略举报没有对应的用户日志类型，写入服务端日志供追责
    logger.info('%s 忽略了漂流瓶 %s 的举报', operator, id)
    return result
  })

  // 媒体路由令牌：只发给已连接控制台的客户端，未登录控制台拿不到令牌即取不到文件
  const mediaTokens = new Map<string, number>()
  const pruneMediaTokens = () => {
    const now = Date.now()
    for (const [key, expiry] of mediaTokens) {
      if (expiry <= now) mediaTokens.delete(key)
    }
  }
  ctx.console.addListener(`${CONSOLE_API_PREFIX}/media-token`, () => {
    pruneMediaTokens()
    const token = crypto.randomBytes(16).toString('hex')
    mediaTokens.set(token, Date.now() + MEDIA_TOKEN_TTL)
    return token
  })

  ctx.server.get(`/${CONSOLE_API_PREFIX}/media/:kind/:name`, (koaCtx) => {
    const expiry = typeof koaCtx.query.token === 'string' ? mediaTokens.get(koaCtx.query.token) : undefined
    if (!expiry) return (koaCtx.status = 401)
    if (expiry <= Date.now()) {
      mediaTokens.delete(koaCtx.query.token as string)
      return (koaCtx.status = 401)
    }

    const kind = koaCtx.params.kind
    if (kind !== 'image' && kind !== 'audio') return (koaCtx.status = 404)
    // 先取 basename 再 resolve，双重防路径穿越
    const name = path.basename(String(koaCtx.params.name ?? ''))
    if (!name || name.startsWith('.')) return (koaCtx.status = 404)
    const dir = path.resolve(glue.mediaBasePath, kind)
    const file = path.resolve(dir, name)
    if (!file.startsWith(dir + path.sep)) return (koaCtx.status = 403)

    try {
      if (!fs.statSync(file).isFile()) return (koaCtx.status = 404)
    } catch {
      return (koaCtx.status = 404)
    }
    koaCtx.type = path.extname(file)
    koaCtx.body = fs.createReadStream(file)
  })

  ctx.console.addEntry({
    dev: path.resolve(ctx.baseDir, 'client/index.ts'),
    prod: path.resolve(__dirname, '../dist'),
  })
}, { inject: { console: { required: false } } })
