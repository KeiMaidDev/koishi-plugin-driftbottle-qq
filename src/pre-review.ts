export interface ExamineConfig {
  isExamine: boolean
  Appid?: string
  key?: string
}

/**
 * 自动内容安全审核是否实际可用：isExamine 开启且 Appid/key 齐全。
 * 与 delSetu.checkImg / checkText 的放行条件一致。
 */
export function isAutoExamineAvailable(config: ExamineConfig): boolean {
  return Boolean(config.isExamine && config.Appid && config.key)
}

/** 预审是否启用：自动内容安全审核实际不可用时兜底启用，两个条件互为补集 */
export function isPreReviewRequired(config: ExamineConfig): boolean {
  return !isAutoExamineAvailable(config)
}

export interface PendingStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

/** 待审投稿的内容，结构与瓶子 content 对齐，便于通过时直接转正 */
export interface PendingSubmissionContent {
  creatTime: number
  text: string | null
  title: string | null
  image: string[] | null
  audio: string[] | null
}

/** 待审投稿：不是瓶子——不入瓶子库、不占瓶子 ID、捞不到、不计入海里统计 */
export interface PendingSubmissionRecord {
  /** 待审编号：全局递增、持久化、只增不复用 */
  pendingId: number
  userId: string
  content: PendingSubmissionContent
  /** 作者是否订阅了预审结果私信推送 */
  notifyAuthor: boolean
  createdAt: number
}

export interface PendingSubmitInput {
  userId: string
  content: PendingSubmissionContent
  notifyAuthor: boolean
}

/** 清理投稿媒体文件的回调：驳回/撤回时删除已下载到本地媒体目录的文件 */
export type PendingMediaRemover = (record: PendingSubmissionRecord) => Promise<void>

interface PendingPersistShape {
  nextPendingId: number
  submissions: Record<string, PendingSubmissionRecord>
}

function normalizeContent(value: unknown): PendingSubmissionContent | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<PendingSubmissionContent>
  if (typeof source.creatTime !== 'number') return null
  return {
    creatTime: source.creatTime,
    text: typeof source.text === 'string' ? source.text : null,
    title: typeof source.title === 'string' ? source.title : null,
    image: Array.isArray(source.image) ? source.image.filter((item): item is string => typeof item === 'string') : null,
    audio: Array.isArray(source.audio) ? source.audio.filter((item): item is string => typeof item === 'string') : null,
  }
}

function normalizeRecord(value: unknown): PendingSubmissionRecord | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<PendingSubmissionRecord>
  if (typeof source.pendingId !== 'number' || typeof source.userId !== 'string') return null
  const content = normalizeContent(source.content)
  if (!content) return null
  return {
    pendingId: source.pendingId,
    userId: source.userId,
    content,
    notifyAuthor: Boolean(source.notifyAuthor),
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : source.content.creatTime,
  }
}

/**
 * 待审区注册表：独立 LocalStorage 命名空间持久化，与瓶子数据、历史记录平级。
 * 批量上传云漂流瓶只读瓶子库，天然不会包含待审区内容。
 */
export class PendingSubmissionRegistry {
  private submissions: Record<string, PendingSubmissionRecord> = {}
  private nextPendingId = 0
  private queue = Promise.resolve()

  constructor(
    private storage: PendingStorage,
    private storageKey: string,
    private removeMedia: PendingMediaRemover = async () => {},
  ) {}

  async init(): Promise<void> {
    await this.exclusive(async () => {
      try {
        const raw = await this.storage.getItem(this.storageKey)
        const parsed: unknown = raw ? JSON.parse(raw) : null
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
        const data = parsed as Partial<PendingPersistShape>
        const submissions: Record<string, PendingSubmissionRecord> = {}
        let maxId = 0
        for (const value of Object.values(data.submissions ?? {})) {
          const record = normalizeRecord(value)
          if (record) {
            submissions[String(record.pendingId)] = record
            maxId = Math.max(maxId, record.pendingId)
          }
        }
        this.submissions = submissions
        this.nextPendingId = Math.max(typeof data.nextPendingId === 'number' ? data.nextPendingId : 0, maxId)
        await this.save()
      } catch {
        this.submissions = {}
        this.nextPendingId = 0
      }
    })
  }

  /** 提交待审投稿：分配全局递增的待审编号并持久化 */
  async submit(input: PendingSubmitInput): Promise<PendingSubmissionRecord> {
    return await this.exclusive(async () => {
      const record: PendingSubmissionRecord = {
        pendingId: ++this.nextPendingId,
        userId: input.userId,
        content: input.content,
        notifyAuthor: input.notifyAuthor,
        createdAt: Date.now(),
      }
      this.submissions[String(record.pendingId)] = record
      await this.save()
      return this.clone(record)
    })
  }

  get(pendingId: number): PendingSubmissionRecord | undefined {
    const record = this.submissions[String(pendingId)]
    return record ? this.clone(record) : undefined
  }

  listAll(): PendingSubmissionRecord[] {
    return Object.values(this.submissions)
      .sort((a, b) => a.pendingId - b.pendingId)
      .map((record) => this.clone(record))
  }

  listByUser(userId: string): PendingSubmissionRecord[] {
    return this.listAll().filter((record) => record.userId === userId)
  }

  count(): number {
    return Object.keys(this.submissions).length
  }

  /** 通过预审：返回供转正为瓶子的数据并作废记录；媒体文件保留复用，不触发清理 */
  async approve(pendingId: number): Promise<PendingSubmissionRecord | null> {
    return await this.exclusive(async () => {
      const record = this.submissions[String(pendingId)]
      if (!record) return null
      delete this.submissions[String(pendingId)]
      await this.save()
      return this.clone(record)
    })
  }

  /** 驳回：彻底丢弃投稿记录与已下载的媒体文件 */
  async reject(pendingId: number): Promise<PendingSubmissionRecord | null> {
    return await this.exclusive(async () => {
      const record = this.submissions[String(pendingId)]
      if (!record) return null
      return await this.disposeLocked(record)
    })
  }

  /** 撤回：作者丢弃自己的待审投稿，效果与驳回一致；非作者或已处理返回 null */
  async withdraw(pendingId: number, userId: string): Promise<PendingSubmissionRecord | null> {
    return await this.exclusive(async () => {
      const record = this.submissions[String(pendingId)]
      if (!record || record.userId !== userId) return null
      return await this.disposeLocked(record)
    })
  }

  /** 仅在 exclusive 回调内调用：清记录、持久化并删除媒体文件 */
  private async disposeLocked(record: PendingSubmissionRecord): Promise<PendingSubmissionRecord> {
    delete this.submissions[String(record.pendingId)]
    await this.save()
    const detached = this.clone(record)
    await this.removeMedia(detached)
    return detached
  }

  private clone(record: PendingSubmissionRecord): PendingSubmissionRecord {
    return {
      ...record,
      content: {
        ...record.content,
        image: record.content.image ? [...record.content.image] : null,
        audio: record.content.audio ? [...record.content.audio] : null,
      },
    }
  }

  private async save() {
    const data: PendingPersistShape = { nextPendingId: this.nextPendingId, submissions: this.submissions }
    await this.storage.setItem(this.storageKey, JSON.stringify(data))
  }

  private async exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.queue.then(callback, callback)
    this.queue = result.then(() => undefined, () => undefined)
    return await result
  }
}
