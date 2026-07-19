export type ReportScope = 'local' | 'cloud'

export interface ReportStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

export interface BottleReportRecord {
  scope: ReportScope
  bottleId: string
  reporterIds: string[]
  updatedAt: number
  notifiedAt?: number
  notificationPending?: boolean
}

export interface ReportSubmitResult {
  record: BottleReportRecord
  duplicate: boolean
  shouldNotify: boolean
}

function reportKey(scope: ReportScope, bottleId: string) {
  return scope + ':' + bottleId
}

function normalizeRecord(value: unknown): BottleReportRecord | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<BottleReportRecord>
  if ((source.scope !== 'local' && source.scope !== 'cloud') || typeof source.bottleId !== 'string') return null
  const reporterIds = Array.isArray(source.reporterIds)
    ? [...new Set(source.reporterIds.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    : []
  return {
    scope: source.scope,
    bottleId: source.bottleId,
    reporterIds,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : 0,
    notifiedAt: typeof source.notifiedAt === 'number' ? source.notifiedAt : undefined,
    // A process restart means an in-flight notification is no longer running.
    notificationPending: false,
  }
}

export class BottleReportRegistry {
  private records: Record<string, BottleReportRecord> = {}
  private queue = Promise.resolve()

  constructor(
    private storage: ReportStorage,
    private storageKey: string,
    private threshold: number,
  ) {
    this.threshold = Math.max(1, Math.floor(threshold || 1))
  }

  async init(): Promise<void> {
    await this.exclusive(async () => {
      try {
        const raw = await this.storage.getItem(this.storageKey)
        const parsed = raw ? JSON.parse(raw) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
        const records: Record<string, BottleReportRecord> = {}
        for (const value of Object.values(parsed)) {
          const record = normalizeRecord(value)
          if (record) records[reportKey(record.scope, record.bottleId)] = record
        }
        this.records = records
        await this.save()
      } catch {
        this.records = {}
      }
    })
  }

  async submit(scope: ReportScope, bottleId: string, reporterId: string): Promise<ReportSubmitResult> {
    return await this.exclusive(async () => {
      const key = reportKey(scope, bottleId)
      const record = this.records[key] || {
        scope,
        bottleId,
        reporterIds: [],
        updatedAt: 0,
      }
      if (record.reporterIds.includes(reporterId)) {
        return { record: { ...record, reporterIds: [...record.reporterIds] }, duplicate: true, shouldNotify: false }
      }

      record.reporterIds.push(reporterId)
      record.updatedAt = Date.now()
      const shouldNotify = record.reporterIds.length >= this.threshold
        && !record.notifiedAt
        && !record.notificationPending
      if (shouldNotify) record.notificationPending = true
      this.records[key] = record
      await this.save()
      return { record: { ...record, reporterIds: [...record.reporterIds] }, duplicate: false, shouldNotify }
    })
  }

  async completeNotification(scope: ReportScope, bottleId: string, success: boolean): Promise<void> {
    await this.exclusive(async () => {
      const record = this.records[reportKey(scope, bottleId)]
      if (!record) return
      record.notificationPending = false
      if (success) record.notifiedAt = Date.now()
      record.updatedAt = Date.now()
      await this.save()
    })
  }

  get(scope: ReportScope, bottleId: string): BottleReportRecord | undefined {
    const record = this.records[reportKey(scope, bottleId)]
    return record ? { ...record, reporterIds: [...record.reporterIds] } : undefined
  }

  private async save() {
    await this.storage.setItem(this.storageKey, JSON.stringify(this.records))
  }

  private async exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.queue.then(callback, callback)
    this.queue = result.then(() => undefined, () => undefined)
    return await result
  }
}
