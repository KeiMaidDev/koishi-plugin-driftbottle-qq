import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Context } from 'koishi'
import type {} from '@koishijs/console'
import type {} from '@koishijs/plugin-server'
import type { Config, DiftInfo } from './index'
import type { BottleReportRegistry } from './report'
import type { PendingSubmissionRegistry } from './pre-review'
import {
  ConsoleService,
  consoleOperator,
  type ConsoleBottleDetail,
  type ConsoleLogInfo,
  type ConsoleOpResult,
  type ConsolePendingDetail,
  type ConsoleStats,
  type ListBottlesQuery,
  type ListBottlesResult,
  type ListPendingResult,
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
    'driftbottle-console/pending-list'(): ListPendingResult
    'driftbottle-console/pending-detail'(pendingId: number): ConsolePendingDetail | null
    'driftbottle-console/approve-pending'(pendingId: number): Promise<ConsoleOpResult>
    'driftbottle-console/reject-pending'(pendingId: number, reason: string): Promise<ConsoleOpResult>
  }
}

/** 面板事件名前缀，客户端通过同名事件请求与监听广播 */
export const CONSOLE_API_PREFIX = 'driftbottle-console'

/** 包名（与 package.json name 一致），用于定位 workspace 安装时的 node_modules 链接 */
const PKG_NAME = 'koishi-plugin-driftbottle-qq'

/**
 * 计算控制台客户端 entry 路径。
 * 生产模式下 @koishijs/plugin-console 的静态服务只放行 console 自身 dist 与
 * 路径含 node_modules 的文件；而本插件经 workspace symlink 被 Node realpath
 * 解析到 external/ 下，__dirname 形式的 prod 路径会被 403（面板无法显示）。
 * 因此 prod 优先走 node_modules 链接路径，真实安装进 node_modules 时回退 __dirname。
 */
export function resolveConsoleEntry(ctx: Pick<Context, 'baseDir'>): { dev: string; prod: string } {
  const viaNodeModules = path.resolve(ctx.baseDir, 'node_modules', PKG_NAME, 'dist')
  return {
    dev: path.resolve(ctx.baseDir, 'client/index.ts'),
    prod: fs.existsSync(viaNodeModules) ? viaNodeModules : path.resolve(__dirname, '../dist'),
  }
}

export interface ConsoleGlue {
  driftbottle: {
    GetAllBottle(): DiftInfo[]
    updateStoreUser(userId: string): Promise<void>
    driftbottleType(bottle: Pick<DiftInfo, 'content'>): string
  }
  logs: {
    addLogForEvent(userId: string, info: ConsoleLogInfo): void
  }
  logTypes: { ban: number; unban: number; reviewDeleted: number }
  reportRegistry: BottleReportRegistry
  pendingRegistry: PendingSubmissionRegistry
  /** 通过预审：转正语义由主入口实现（分配 ID、入海、写日志、订阅推送） */
  approvePending(pendingId: number, operator: string): Promise<ConsoleOpResult>
  /** 驳回预审：reason 可留空 */
  rejectPending(pendingId: number, operator: string, reason: string): Promise<ConsoleOpResult>
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
  pending_not_found: '没有找到对应的待审投稿。',
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
    getPendingSubmissions: () => glue.pendingRegistry.listAll(),
    pendingType: (pending) => glue.driftbottle.driftbottleType(pending),
    approvePending: (pendingId, operator) => glue.approvePending(pendingId, operator),
    rejectPending: (pendingId, operator, reason) => glue.rejectPending(pendingId, operator, reason),
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

  ctx.console.addListener(`${CONSOLE_API_PREFIX}/pending-list`, () => service.listPending())
  ctx.console.addListener(`${CONSOLE_API_PREFIX}/pending-detail`, (pendingId) =>
    service.getPending(Number(pendingId)))
  ctx.console.addListener(`${CONSOLE_API_PREFIX}/approve-pending`, async function (pendingId) {
    const operator = operatorOf(this)
    const result = await service.approvePending(Number(pendingId), operator)
    if (result.ok === false) throw new Error(opErrors[result.reason])
    logger.info('%s 通过了待审投稿 %s', operator, pendingId)
    return result
  })
  ctx.console.addListener(`${CONSOLE_API_PREFIX}/reject-pending`, async function (pendingId, reason) {
    const operator = operatorOf(this)
    const result = await service.rejectPending(Number(pendingId), operator, String(reason ?? ''))
    if (result.ok === false) throw new Error(opErrors[result.reason])
    logger.info('%s 驳回了待审投稿 %s%s', operator, pendingId, reason ? `，理由：${reason}` : '（未附理由）')
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

  ctx.console.addEntry(resolveConsoleEntry(ctx))
// server：媒体路由挂在 server 服务上；console 的 required inject 已保证 console 可用时 server 必已启动
}, { inject: { console: { required: false }, server: { required: false } } })
