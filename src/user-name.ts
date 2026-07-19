import type { Session } from 'koishi'
import type { DiftInfo } from '.'

interface AdapterUserLike {
  name?: string
  nick?: string
  username?: string
  nickname?: string
  user?: AdapterUserLike
}

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

export function createAdapterDisplayNameResolver(session: Session) {
  const cache = new Map<string, Promise<string>>()
  return async (userId: string): Promise<string> => {
    const key = session.platform + ':' + (session.guildId || '') + ':' + userId
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        if (userId === session.userId) {
          const currentName = pickAdapterDisplayName(session.author)
          if (currentName) return currentName
        }

        if (session.guildId) {
          try {
            const member = await session.bot.getGuildMember(session.guildId, userId)
            const memberName = pickAdapterDisplayName(member)
            if (memberName) return memberName
          } catch {
            // Some adapters do not implement guild member lookup.
          }
        }

        try {
          const user = await session.bot.getUser(userId, session.guildId)
          return pickAdapterDisplayName(user)
        } catch {
          return ''
        }
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

export async function withAdapterDisplayNames(session: Session, bottle: DiftInfo): Promise<DiftInfo> {
  const storedBottle = withoutAdapterDisplayNames(bottle)
  const resolveName = createAdapterDisplayNameResolver(session)
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
