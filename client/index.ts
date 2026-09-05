import type { Context } from '@koishijs/client'
import App from './app'

export default (ctx: Context) => {
  ctx.page({
    path: '/driftbottle',
    name: '漂流瓶管理',
    order: 5,
    fields: [],
    component: App,
  })
}
