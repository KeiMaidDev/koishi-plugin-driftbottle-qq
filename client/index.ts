import type { Context } from '@koishijs/client'
import { store } from '@koishijs/client'
import { defineComponent, h } from 'vue'
import { CONSOLE_PANEL_AUTHORITY } from '../src/console-permission'
import App from './app'

// plugin-auth 的客户端守卫由 auth 入口模块注册，而控制台首次导航只等待入口登记，不等待入口执行完，
// 因此匿名深链有概率先渲染出面板外壳（官方 /logs 等页面同样如此）。这里用同一个 store.user 条件
// 同步兜底，未登录时不渲染面板内容；真正的闸门是服务端 console listener 上的 authority。
const GuardedApp = defineComponent({
  name: 'DriftbottlePanelGuard',
  setup: () => () => (store.user ? h(App) : null),
})

export default (ctx: Context) => {
  ctx.page({
    path: '/driftbottle',
    name: '漂流瓶管理',
    order: 5,
    // 与面板 RPC 同一门槛：未登录访问会被 plugin-auth 重定向到 /login
    authority: CONSOLE_PANEL_AUTHORITY,
    component: GuardedApp,
  })
}
