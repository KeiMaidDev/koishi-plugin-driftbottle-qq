# koishi-plugin-driftbottle-qq

漂流瓶插件，QQ 平台优先使用原生 Markdown  展示内容。

## 消息兼容

- QQ：`漂流瓶` 主命令和漂流瓶主体均使用 `qq:rawmarkdown`，操作入口使用下挂 Keyboard。
- `查看瓶子记录` 使用带类型图标、发布者信息和记录总数的 Markdown 卡片，并提供指定读取、继续打捞、查看日志和返回菜单按钮。
- `漂流瓶日志` 使用区分“新消息/已读”的 Markdown 时间线，并提供查看记录、继续打捞、生态统计和返回菜单按钮。
- `漂流瓶统计` 使用 Markdown 卡片展示海域概览、瓶子类型和用户足迹，并提供继续打捞、扔瓶子、查看记录、查看日志和返回菜单按钮。
- 管理员查看本地瓶时会额外显示“封禁瓶子”和“删除留言”按钮；瓶子作者查看自己的本地瓶时，在允许作者管理留言的配置下显示“删除留言”按钮。
- 插件不再需要手动填写 `botId` 配置；云端协议数据中的 `botId` 仍由运行时自动识别和维护。
- 本地瓶作者和留言用户的展示名称优先读取当前适配器提供的群昵称或用户名称，查询失败时回退显示用户 ID。
- QQ/OneBot 平台遇到纯数字 QQ ID，且适配器未提供有效昵称时，会通过 [Uapis QQ 用户信息接口](https://uapis.cn/docs/api-reference/get-social-qq-userinfo) 查询昵称；`uapisApiKey` 为可选配置。
- Uapis 回退仅使用 Koishi HTTP 直接请求官方 API，未引入该站提供的 npm 包。配置密钥时附加 `Authorization: Bearer <API Key>` 请求头；未配置时仍会直接请求。`uapisCacheMinutes` 控制昵称缓存分钟数，默认 `60`，设为 `0` 时禁用缓存。请求失败时不缓存空结果并回退显示 QQ ID。
- 名称只在构造消息时临时补全，漂流瓶和留言持久化数据仍只保存用户 ID；旧版本遗留的 `username` 字段会在加载或保存时清理。
- 旧的 `onbotAvatar` 配置和第三方 QQ 昵称查询接口已删除。
- 其他适配器：自动降级为普通文本、图片和音频消息。
- QQ 图片优先通过 Koishi Assets 服务生成公网直链，并使用带宽度、高度参数的原生 Markdown 图片语法。
- 安装并启用 Koishi Canvas 服务后，插件会读取图片的原始宽高；尺寸不超过 `1024 x 1024` 时按原尺寸显示，超过时在该边界内等比例缩小。
- Canvas 未安装或图片尺寸读取失败时，Markdown 图片回退为 `1024 x 1024` 的安全尺寸，不影响漂流瓶内容发送。
- Assets 未安装、转存失败或没有公网 HTTP(S) 地址时，图片自动降级为 Koishi 标准图片消息。

## 举报审核

- 每个本地瓶和云瓶的 Keyboard 都提供“举报该瓶”按钮；非 QQ 平台可使用 `举报漂流瓶 <ID> [local|cloud]`。
- 同一用户对同一漂流瓶只能计入一次举报，举报记录通过 LocalStorage 持久化。
- 配置项 `reportThreshold` 控制通知阈值，默认值为 `3`。
- 举报数达到阈值后，插件会使用当前机器人向 `adminQQ` 中的管理员发送主动私聊审核通知。
- QQ 管理员通知使用原生 Markdown：本地瓶提供“查看瓶子”和“封禁瓶子”按钮，云瓶提供“查看云瓶”按钮。
- 主动消息发送失败时会保留举报记录；后续新增举报会再次尝试通知。

## 依赖

- `koishi-plugin-smmcat-localstorage`
- QQ 原生 Markdown 功能需要 [adapter-qq-crack](https://assets.koishi.chat/zh-CN/api.html)
- Assets 服务为可选依赖；要在 Markdown 内嵌图片，Assets 必须能返回公网 HTTP(S) 直链
- Canvas 服务为可选依赖；启用后用于获取 QQ Markdown 图片的原始宽高
