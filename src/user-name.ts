import type { Session } from 'koishi'
import type { DiftInfo } from '.'

interface AdapterUserLike {
  name?: string
  nick?: string
  username?: string
  nickname?: string
  user?: AdapterUserLike
}

export interface QqNicknameHttpClient {
  get(url: string, config?: {
    params?: Record<string, string>
    headers?: Record<string, string>
    timeout?: number
  }): Promise<unknown>
}

interface UapisQqUserInfo {
  nickname?: unknown
  nick?: unknown
  data?: UapisQqUserInfo
  body?: UapisQqUserInfo
}

const UAPIS_QQ_USERINFO_URL = 'https://uapis.cn/api/v1/social/qq/userinfo'
export const DEFAULT_QQ_NICKNAME_CACHE_TTL = 60 * 60 * 1000
const QQ_PLATFORMS = new Set(['qq', 'onebot'])
const qqNicknameCache = new Map<string, { cachedAt: number, value: Promise<string> }>()

function sanitizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 80)
}

export function pickAdapterDisplayName(...sources: Array<AdapterUserLike | null | undefined>): string {
  for (const source of sources) {
    if (!source) continue
    const candidates = [
      source.nick,
      source.nickname,
      source.name,
      source.username,
      source.user?.nick,
      source.user?.nickname,
      source.user?.name,
      source.user?.username,
    ]
    for (const candidate of candidates) {
      const name = sanitizeDisplayName(candidate)
      if (name) return name
    }
  }
  return ''
}

function pickUapisQqNickname(response: unknown): string {
  if (!response || typeof response !== 'object') return ''
  const payload = response as UapisQqUserInfo
  const data = payload.data && typeof payload.data === 'object'
    ? payload.data
    : payload.body && typeof payload.body === 'object'
      ? payload.body
      : payload
  return sanitizeDisplayName(data.nickname) || sanitizeDisplayName(data.nick)
}

export function isNumericQqUserId(platform: string, userId: string): boolean {
  return QQ_PLATFORMS.has(platform) && /^\d+$/.test(userId)
}

export async function fetchQqNicknameFromUapis(
  userId: string,
  apiKey = '',
  http?: QqNicknameHttpClient,
  cacheTtlMs = DEFAULT_QQ_NICKNAME_CACHE_TTL,
): Promise<string> {
  const token = apiKey.trim()
  if (!http || !/^\d+$/.test(userId)) return ''
  const now = Date.now()
  const ttl = Number.isFinite(cacheTtlMs) ? Math.max(0, cacheTtlMs) : DEFAULT_QQ_NICKNAME_CACHE_TTL
  const cached = qqNicknameCache.get(userId)
  if (ttl > 0 && cached && now - cached.cachedAt < ttl) return await cached.value
  if (cached) qqNicknameCache.delete(userId)

  const value = (async () => {
    try {
      const response = await http.get(UAPIS_QQ_USERINFO_URL, {
        params: { qq: userId },
        ...(token ? { headers: { Authorization: 'Bearer ' + token } } : {}),
        timeout: 5000,
      })
      return pickUapisQqNickname(response)
    } catch {
      return ''
    }
  })()
  if (ttl > 0) qqNicknameCache.set(userId, { cachedAt: now, value })
  const nickname = await value
  if (!nickname && qqNicknameCache.get(userId)?.value === value) {
    qqNicknameCache.delete(userId)
  }
  return nickname
}

export function createAdapterDisplayNameResolver(
  session: Session,
  uapisApiKey = '',
  http?: QqNicknameHttpClient,
  cacheTtlMs = DEFAULT_QQ_NICKNAME_CACHE_TTL,
) {
  const cache = new Map<string, Promise<string>>()
  return async (userId: string): Promise<string> => {
    const key = session.platform + ':' + (session.guildId || '') + ':' + userId
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        let adapterFallback = ''
        if (userId === session.userId) {
          const currentName = pickAdapterDisplayName(session.author)
          if (currentName && currentName !== userId) return currentName
          adapterFallback ||= currentName
        }

        if (session.guildId) {
          try {
            const member = await session.bot.getGuildMember(session.guildId, userId)
            const memberName = pickAdapterDisplayName(member)
            if (memberName && memberName !== userId) return memberName
            adapterFallback ||= memberName
          } catch {
            // Some adapters do not implement guild member lookup.
          }
        }

        try {
          const user = await session.bot.getUser(userId, session.guildId)
          const userName = pickAdapterDisplayName(user)
          if (userName && userName !== userId) return userName
          adapterFallback ||= userName
        } catch {
          // Continue with the QQ nickname API fallback.
        }

        if (isNumericQqUserId(session.platform, userId)) {
          const httpClient = http || (session.bot.ctx as unknown as { http?: QqNicknameHttpClient }).http
          const apiName = await fetchQqNicknameFromUapis(userId, uapisApiKey, httpClient, cacheTtlMs)
          if (apiName) return apiName
        }
        return adapterFallback
      })())
    }
    return await cache.get(key)!
  }
}

export function withoutAdapterDisplayNames(bottle: DiftInfo): DiftInfo {
  const cleanBottle = { ...bottle }
  const cleanContent = { ...bottle.content }
  delete cleanBottle.username
  delete cleanContent.username
  return {
    ...cleanBottle,
    content: cleanContent,
    review: bottle.review.map(item => {
      const cleanItem = { ...item }
      delete cleanItem.username
      return cleanItem
    }),
  }
}

export async function withAdapterDisplayNames(
  session: Session,
  bottle: DiftInfo,
  uapisApiKey = '',
  http?: QqNicknameHttpClient,
  cacheTtlMs = DEFAULT_QQ_NICKNAME_CACHE_TTL,
): Promise<DiftInfo> {
  const storedBottle = withoutAdapterDisplayNames(bottle)
  const resolveName = createAdapterDisplayNameResolver(session, uapisApiKey, http, cacheTtlMs)
  const [username, review] = await Promise.all([
    resolveName(storedBottle.userId),
    Promise.all(storedBottle.review.map(async item => ({
      ...item,
      username: item.userId ? await resolveName(item.userId) : undefined,
    }))),
  ])
  return {
    ...storedBottle,
    username: username || undefined,
    review,
  }
}
