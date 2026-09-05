# 01: 控制台扩展骨架与统计条

**What to build:** 管理员打开 Koishi 控制台，能看到一个「漂流瓶管理」面板页面，顶部统计条显示真实数字：瓶子总数、正常/封禁数、待处理举报数（口径＝举报数达到阈值且未被处理）。这是打通全链路的 tracer bullet：声明控制台依赖 → client 目录（Vue）构建接线 → 注册控制台服务 → 统计 API → 页面展示。

**Blocked by:** None (can start immediately).

**Status:** done (2026-09-05, implemented + built + tests pass)

- [x] 插件启用后面板页面出现在 Koishi 控制台，无需手动刷新配置
- [x] 统计条三项数字与本地瓶实际数据一致
- [x] 待处理举报数按「达到举报阈值且未处理」口径统计
- [x] 包元信息正确声明 client 资源，构建产物随插件分发
- [x] 统计 API 有服务层测试（纯函数 + 夹具数据，沿用现有 message 测试风格）
