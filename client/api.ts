import { receive, send } from '@koishijs/client'
import type {} from '@koishijs/plugin-console'
import type {
  ConsoleBottleDetail,
  ConsoleFilter,
  ConsolePendingDetail,
  ConsolePendingSummary,
  ConsoleStats,
  ListBottlesResult,
  ListPendingResult,
} from '../src/console-service'

export type { ConsoleBottleDetail, ConsoleFilter, ConsolePendingDetail, ConsolePendingSummary, ConsoleStats, ListBottlesResult, ListPendingResult }

declare module '@koishijs/plugin-console' {
  interface Events {
    'driftbottle-console/stats'(): ConsoleStats
    'driftbottle-console/list'(query: { filter?: ConsoleFilter; search?: string; page?: number; pageSize?: number }): ListBottlesResult
    'driftbottle-console/bottle'(id: number): ConsoleBottleDetail | null
    'driftbottle-console/ban'(id: number): Promise<unknown>
    'driftbottle-console/unban'(id: number): Promise<unknown>
    'driftbottle-console/delete-review'(id: number, reviewIndex: number): Promise<unknown>
    'driftbottle-console/dismiss-report'(id: number): Promise<unknown>
    'driftbottle-console/media-token'(): string
    'driftbottle-console/pending-list'(): ListPendingResult
    'driftbottle-console/pending-detail'(pendingId: number): ConsolePendingDetail | null
    'driftbottle-console/approve-pending'(pendingId: number): Promise<unknown>
    'driftbottle-console/reject-pending'(pendingId: number, reason: string): Promise<unknown>
  }
}

export interface PanelChangeEvent {
  action: string
  at: number
}

export const onPanelChange = (listener: (event: PanelChangeEvent) => void) => receive<PanelChangeEvent>('driftbottle-console/changed', listener)

export const fetchStats = () => send('driftbottle-console/stats')
export const fetchList = (query: { filter?: ConsoleFilter; search?: string; page?: number; pageSize?: number }) =>
  send('driftbottle-console/list', query)
export const fetchBottle = (id: number) => send('driftbottle-console/bottle', id)
export const banBottle = (id: number) => send('driftbottle-console/ban', id)
export const unbanBottle = (id: number) => send('driftbottle-console/unban', id)
export const deleteReview = (id: number, reviewIndex: number) => send('driftbottle-console/delete-review', id, reviewIndex)
export const dismissReport = (id: number) => send('driftbottle-console/dismiss-report', id)
export const fetchMediaToken = () => send('driftbottle-console/media-token')
export const fetchPendingList = () => send('driftbottle-console/pending-list')
export const fetchPendingDetail = (pendingId: number) => send('driftbottle-console/pending-detail', pendingId)
export const approvePending = (pendingId: number) => send('driftbottle-console/approve-pending', pendingId)
export const rejectPending = (pendingId: number, reason: string) => send('driftbottle-console/reject-pending', pendingId, reason)
