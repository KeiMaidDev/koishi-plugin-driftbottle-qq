import { h, type Session } from 'koishi'

/**
 * Sends a proactive direct message while preserving the adapter-provided
 * direct-channel metadata. This is required by adapters that select their
 * private-message endpoint from `session.isDirect`.
 */
export async function sendProactivePrivateMessage(
  bot: Session['bot'],
  userId: string,
  content: h.Fragment,
) {
  const channel = await bot.createDirectChannel(userId)
  const directSession = bot.session({
    channel,
    user: { id: userId },
  })

  return bot.sendMessage(channel.id, content, null, { session: directSession })
}
