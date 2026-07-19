# koishi-plugin-driftbottle-qq

漂流瓶插件，QQ 平台优先使用原生 Markdown  展示内容。

## 消息兼容

- QQ：漂流瓶主体使用 `qq:rawmarkdown`，操作入口使用下挂 Keyboard。
- 其他适配器：自动降级为普通文本、图片和音频消息。
- QQ 图片优先通过 Koishi Assets 服务生成公网直链并内嵌 Raw Markdown。
- Assets 未安装、转存失败或没有公网 HTTP(S) 地址时，图片自动降级为 Koishi 标准图片消息。

## 依赖

- `koishi-plugin-smmcat-localstorage`
- QQ 原生 Markdown 功能需要 [adapter-qq-crack](https://assets.koishi.chat/zh-CN/api.html)
- Assets 服务为可选依赖；要在 Markdown 内嵌图片，Assets 必须能返回公网 HTTP(S) 直链
