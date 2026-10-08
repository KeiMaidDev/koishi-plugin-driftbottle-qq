/**
 * 控制台面板的权限门槛，客户端页面注册与服务端 RPC 监听器共用这一个值，
 * 避免两边各写一个字面量后漂移。
 *
 * 1 = 普通已登录用户（Koishi `autoAuthorize` 默认值）：未登录客户端会被
 * `@koishijs/plugin-auth` 的路由守卫（页面）与 `console/intercept`（RPC）拦下。
 */
export const CONSOLE_PANEL_AUTHORITY = 4
