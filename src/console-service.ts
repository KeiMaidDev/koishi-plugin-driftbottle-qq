import type { DiftInfo } from './index'
import { isReportPending, type BottleReportRegistry } from './report'

/** 控制台列表筛选标签 */
export type ConsoleFilter = 'all' | 'reported' | 'banned'

/** 控制台面板中的操作者身份（写入日志用） */
export function consoleOperator(username: string): string {
  return 'console(' + (username || 'unknown') + ')'
}

/** 判断日志记录者是否来自控制台面板 */
export function isConsoleOperator(userId: string): boolean {
  return userId.startsWith('console(')
}

/** 面板数据变更动作，QQ 端与控制台端共用 */
export type PanelChangeAction = 'ban' | 'unban' | 'delete-review' | 'dismiss-report' | 'report'

export interface ConsoleLogInfo {
  type: number
  userId: string
  bottleId: number
  bottleType?: string
}

/**
 * 控制台面板服务：面板全部业务逻辑收敛于该模块，
 * 只依赖注入的数据访问接口，不接触 Koishi 运行时，便于纯函数式测试。
 */
export interface ConsoleServiceDeps {
  /** 所有本地瓶（内存全量） */
  getBottles(): DiftInfo[]
  /** 持久化单个作者的瓶子数据 */
  persistBottle(userId: string): Promise<void>
  /** 瓶子类型判断 */
  bottleType(bottle: DiftInfo): string
  reportRegistry: Pick<BottleReportRegistry, 'get' | 'resolve'>
  /** 举报阈值（待处理举报口径） */
  threshold: number
  /** 追加一条用户日志（与 QQ 端指令同一套日志） */
  addLog(userId: string, info: ConsoleLogInfo): void
  logTypes: { ban: number; unban: number; reviewDeleted: number }
  /** 把存储中的媒体地址解析为控制台媒体路由 URL；返回 null 表示无法展示 */
  mediaResolver(url: string | null | undefined, kind: 'image' | 'audio'): string | null
  /** 数据变更后广播（刷新所有已打开的面板） */
  notifyChange(action: PanelChangeAction): void
}

export interface ConsoleBottleSummary {
  id: number
  authorId: string
  type: string
  title: string | null
  preview: string
  show: boolean
  creatTime: number
  reviewCount: number
  reportCount: number
  reportPending: boolean
}

export interface ConsoleReviewView {
  /** 留言在瓶子 review 数组中的原始下标，删除操作回传该值 */
  index: number
  userId: string
  text: string | null
  images: Array<string | null>
  isDel: boolean
  creatTime: number
}

export interface ConsoleBottleDetail {
  id: number
  authorId: string
  type: string
  title: string | null
  text: string | null
  images: Array<string | null>
  audio: string | null
  show: boolean
  creatTime: number
  getCount: number
  reportCount: number
  reportPending: boolean
  reviews: ConsoleReviewView[]
}

export interface ConsoleStats {
  total: number
  visible: number
  banned: number
  /** 待处理举报数：举报数达到阈值且未处理 */
  pendingReports: number
}

export interface ListBottlesQuery {
  filter?: ConsoleFilter
  search?: string
  page?: number
  pageSize?: number
}

export interface ListBottlesResult {
  total: number
  page: number
  pageSize: number
  bottles: ConsoleBottleSummary[]
}

export type ConsoleOpResult = { ok: true } | { ok: false; reason: string }

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const PREVIEW_LENGTH = 50

function reportCountFor(deps: ConsoleServiceDeps, bottle: DiftInfo): number {
  return deps.reportRegistry.get('local', String(bottle.id))?.reporterIds.length ?? 0
}

function reportPendingFor(deps: ConsoleServiceDeps, bottle: DiftInfo): boolean {
  return isReportPending(deps.reportRegistry.get('local', String(bottle.id)), deps.threshold)
}

function buildPreview(bottle: DiftInfo): string {
  const text = bottle.content.text?.trim()
  if (text) {
    return text.length > PREVIEW_LENGTH ? text.slice(0, PREVIEW_LENGTH) + '…' : text
  }
  if (bottle.content.title?.trim()) return bottle.content.title.trim()
  if (bottle.content.audio?.length) return '[音频]'
  if (bottle.content.image?.length) return '[图片]'
  return '[空瓶子]'
}

function matchesSearch(bottle: DiftInfo, search: string): boolean {
  const query = search.trim()
  if (!query) return true
  return String(bottle.id).includes(query) || (bottle.userId ?? '').includes(query)
}

export class ConsoleService {
  constructor(private deps: ConsoleServiceDeps) {}

  getStats(): ConsoleStats {
    const bottles = this.deps.getBottles()
    let visible = 0
    let pendingReports = 0
    for (const bottle of bottles) {
      if (bottle.show) visible++
      if (reportPendingFor(this.deps, bottle)) pendingReports++
    }
    return { total: bottles.length, visible, banned: bottles.length - visible, pendingReports }
  }

  listBottles(query: ListBottlesQuery = {}): ListBottlesResult {
    const filter: ConsoleFilter = query.filter === 'reported' || query.filter === 'banned' ? query.filter : 'all'
    const pageSize = Math.min(Math.max(Math.floor(query.pageSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const filtered = this.deps.getBottles()
      .filter((bottle) => {
        if (filter === 'banned' && bottle.show) return false
        if (filter === 'reported' && reportCountFor(this.deps, bottle) <= 0) return false
        return matchesSearch(bottle, query.search ?? '')
      })
      .sort((a, b) => {
        if (filter === 'reported') {
          const diff = reportCountFor(this.deps, b) - reportCountFor(this.deps, a)
          if (diff !== 0) return diff
        }
        return b.id - a.id
      })
    const page = Math.max(Math.floor(query.page) || 1, 1)
    const start = (page - 1) * pageSize
    return {
      total: filtered.length,
      page,
      pageSize,
      bottles: filtered.slice(start, start + pageSize).map((bottle) => this.toSummary(bottle)),
    }
  }

  getBottle(id: number): ConsoleBottleDetail | null {
    const bottle = this.deps.getBottles().find((item) => item.id === id)
    if (!bottle) return null
    return {
      id: bottle.id,
      authorId: bottle.userId ?? '',
      type: this.deps.bottleType(bottle),
      title: bottle.content.title ?? null,
      text: bottle.content.text ?? null,
      images: (bottle.content.image ?? []).map((url) => this.deps.mediaResolver(url, 'image')),
      audio: (bottle.content.audio ?? []).map((url) => this.deps.mediaResolver(url, 'audio'))[0] ?? null,
      show: bottle.show,
      creatTime: bottle.content.creatTime ?? 0,
      getCount: bottle.getCount ?? 0,
      reportCount: reportCountFor(this.deps, bottle),
      reportPending: reportPendingFor(this.deps, bottle),
      // 已软删除的留言同样返回，由前端展示「已删除」徽标
      reviews: (bottle.review ?? []).map((review, index) => ({
        index,
        userId: review.userId ?? '',
        text: review.text ?? null,
        images: (review.image ?? []).map((url) => this.deps.mediaResolver(url, 'image')),
        isDel: Boolean(review.isDel),
        creatTime: review.creatTime ?? 0,
      })),
    }
  }

  async banBottle(id: number, operator: string): Promise<ConsoleOpResult> {
    const bottle = this.deps.getBottles().find((item) => item.id === id)
    if (!bottle) return { ok: false, reason: 'not_found' }
    if (!bottle.show) return { ok: false, reason: 'already_banned' }

    bottle.show = false
    await this.deps.persistBottle(bottle.userId)

    this.deps.addLog(bottle.userId, {
      type: this.deps.logTypes.ban,
      userId: operator,
      bottleId: bottle.id,
      bottleType: this.deps.bottleType(bottle),
    })
    // 封禁即处理举报：闭环举报记录，不再重复通知
    await this.deps.reportRegistry.resolve('local', String(bottle.id))
    this.deps.notifyChange('ban')
    return { ok: true }
  }

  async unbanBottle(id: number, operator: string): Promise<ConsoleOpResult> {
    const bottle = this.deps.getBottles().find((item) => item.id === id)
    if (!bottle) return { ok: false, reason: 'not_found' }
    if (bottle.show) return { ok: false, reason: 'already_visible' }

    bottle.show = true
    await this.deps.persistBottle(bottle.userId)

    this.deps.addLog(bottle.userId, {
      type: this.deps.logTypes.unban,
      userId: operator,
      bottleId: bottle.id,
      bottleType: this.deps.bottleType(bottle),
    })
    this.deps.notifyChange('unban')
    return { ok: true }
  }

  /** 软删除留言，语义与 QQ 端删留言指令一致 */
  async deleteReview(id: number, reviewIndex: number, operator: string): Promise<ConsoleOpResult> {
    const bottle = this.deps.getBottles().find((item) => item.id === id)
    if (!bottle) return { ok: false, reason: 'not_found' }
    const review = (bottle.review ?? [])[reviewIndex]
    if (!review) return { ok: false, reason: 'invalid_review' }
    if (review.isDel) return { ok: false, reason: 'already_deleted' }

    review.isDel = true
    await this.deps.persistBottle(bottle.userId)

    this.deps.addLog(review.userId ?? bottle.userId, {
      type: this.deps.logTypes.reviewDeleted,
      userId: operator,
      bottleId: bottle.id,
      bottleType: this.deps.bottleType(bottle),
    })
    this.deps.notifyChange('delete-review')
    return { ok: true }
  }

  /** 忽略举报：不封瓶，仅闭环举报记录并停止重复通知 */
  async dismissReport(id: number, operator: string): Promise<ConsoleOpResult> {
    const bottle = this.deps.getBottles().find((item) => item.id === id)
    if (!bottle) return { ok: false, reason: 'not_found' }
    const resolved = await this.deps.reportRegistry.resolve('local', String(bottle.id))
    if (!resolved) return { ok: false, reason: 'no_report' }

    this.deps.notifyChange('dismiss-report')
    return { ok: true }
  }

  private toSummary(bottle: DiftInfo): ConsoleBottleSummary {
    return {
      id: bottle.id,
      authorId: bottle.userId ?? '',
      type: this.deps.bottleType(bottle),
      title: bottle.content.title ?? null,
      preview: buildPreview(bottle),
      show: bottle.show,
      creatTime: bottle.content.creatTime ?? 0,
      reviewCount: (bottle.review ?? []).length,
      reportCount: reportCountFor(this.deps, bottle),
      reportPending: reportPendingFor(this.deps, bottle),
    }
  }
}
