# RC-07 私有 Preview 会话撤销复核

范围：GitHub #23。2026-09-24 在同构隔离环境验证：Web localhost:45231、API 127.0.0.1:45312、Preview 各版本子域 localhost:45313、Supabase Auth 的 postgres 库、隔离业务库 pivloom_e2e_test_20260923、真实 OpenSandbox。工作树基于 260d2c8bca734ce9c9eedb8beecc8f5b8475813d；本地 Web/API version 均返回 commit:null，故不声称已部署正式 SHA。Node 24.19.0，独立 QA 浏览器 agent-browser 0.36.0。

## 实现与上游

- 直接使用 Supabase local signOut、经 Auth 验证的 JWT session_id 与服务器 auth.sessions 状态。新增受限布尔函数 nano.preview_session_active(owner,session)，仅 nano_api 可执行；每次私有 HTML、JS、marker 请求都核对会话仍存在。
- 适配 OpenHands 资源专用 Cookie 的 host-only、版本路径、HttpOnly、匹配属性清除端点，以及普通 API 不接受资源 Cookie 的测试边界；没有复制其长期 API key 或源码。
- 用户先从带 Bearer 的平台接口取得 owner/session/revision 专属 grant，再以 Preview 专用 Authorization header 换 HttpOnly Cookie。iframe URL、生成应用、公开报告均不含 grant；浏览器 Cookie/Authorization 不转发给沙箱。
- 修复本轮发现的恢复回归：原 30 秒定时全局恢复会杀掉本进程刚创建的 Preview 沙箱。现在只在启动前全局认领旧 restore，运行时仅重试启动时精确认领的 ID。另增加本地 Preview 公告端口与实际监听端口一致的启动检查。

## 实测矩阵

复用隔离项目 e1f19e78-39b4-4aa2-b863-1ae37fd1cc10，当前 v2 4a9f8f3c-2c15-42f9-81a3-31b5bb224c7c，Run 11b3c2bd-a8e6-486a-88dd-9840be089b96，sourceHash 3ba0ac647d8f2ea566c786e03dfcc0d51458921c05e50696c022f9d7e09b5e9c。[原始 Check](rc07-baseline-check.json) 为 1/1 passed。此项目是受控计数器夹具，v1/v2 七个文件的 SHA256 完全相同；只用于会话、历史持久化和 Preview，**不是**真实模型生成、有效增量或逐轮 5/5 的证据。本轮没有调用模型或发布该项目。

| 场景 | 实际 |
|---|---|
| A1 打开 v2 | OPTIONS/POST 授权交换均 204，iframe HTML、JS、marker 新请求均 200；marker 与上述 revisionId/sourceHash 一致。[页面](rc07-a1-private-preview.png) |
| 独立 A2 | 新浏览器登录 A、独立交换授权并打开 v2；A1 退出后 A2 新标签仍 200。[A2 结果](rc07-a2-still-valid-after-a1-logout.png) |
| A1 在线退出 | 原标签已下载画面仍可见；新发 HTML、构建 JS、版本 marker 请求全部 403，刷新旧入口也是 403。[刷新结果](rc07-a1-after-logout-preview-denied.png) |
| 同浏览器切 B、独立 B、空白访客 | 同浏览器 B 访问 A 项目 404、旧私有 Preview 403。独立 B 对 A 项目、Preview 元数据、源码、Check、grant、历史和 diff 均收到 404，直接 Preview 403。空白 profile 直接 Preview 403。[B 项目拒绝](rc07-b-project-denied.png) |
| A1 重登 A | 新会话重新取得授权，v2 iframe 返回 200。[重登结果](rc07-a1-relogin-preview-restored.png) |
| 全新 A 浏览器 | 登录前 localStorage 零项；登录后可见项目、8 条对话、v1/v2 历史和两版各七个完整文件路径与哈希。A2 在有效期内打开 v2；更晚登录的全新会话看到 v2 自然到期，可按设计重建。v1 历史预览在请求完成后明确显示到期及恢复按钮。[v1 到期](rc07-a2-v1-expired.png)、[v2 源码](rc07-a2-source.png) |
| 正式发布对照 | 既有永久发布地址 https://3c866a6a-26e9-4af4-89d4-d84127b7d430.app-69-5-7-187.sslip.io/ 匿名 GET 200。 |

真实 Auth/PostgreSQL/Gateway 集成测试另证：A1/A2 两条 Supabase session 初始都存在；local signOut A1 后，仅 A1 的 auth.sessions 校验变 false，A2 仍 true。复用旧 A1 grant 和 Cookie 请求 HTML、JS、marker 全被拒绝，A2 继续可读。普通平台 API 仅携 Preview Cookie 或 Preview Authorization 均返回 401。清 Cookie 只是浏览器卫生，**服务端会话检查**才是撤销依据。

恢复回归在隔离库测试：启动时认领的旧 restore 远端销毁第一次失败后仍保持锁，只重试该 ID 后释放；启动后新 restore 跨六次短周期 sweep 仍 pending，之后可绑定 ready。真实 UI 恢复 a379af3a-2426-4b4e-a832-34edaa72792a 用约 110 秒到 ready，跨越 30 秒 sweep，版本/current/Check 未变。最新沙箱 dc3dd221-44e0-4ed7-b78a-fb88fcaf2e61 在 API 停止后数据库为 destroyed，OpenSandbox SDK 确认远端不存在；前序调试沙箱也已销毁。

验证：API 全套 283 passed、58 个需显式环境的用例默认 skipped；Web 全套 81 passed；API/Web typecheck 与 lint 通过。真实会话撤销集成 1 passed；隔离恢复服务 3 passed；恢复清理三项分别通过。临时 B 账号已精确删除，A1/A2/全新 A 已退出，QA 浏览器均关闭。隔离项目由总体验收统一清理。

边界：离线退出时无法确认 Auth session 即时移除，后续 `9aea161` 已改为明确显示 `LOGOUT_UNCONFIRMED`，不再向用户宣称退出成功。本轮只把**在线 signOut 成功**的服务端撤销判为通过。E25/I09 中涉及未来回滚目标的部分留待 #25 和最终 RC；本票已测现存资源及新 Preview grant 的 owner/session 边界。

生产迁移顺序：先确认 /etc/pivloom/maintenance.env 的 MIGRATION_DATABASE_URL 指向含 auth.sessions 与 nano.projects 的 postgres 库，以维护身份事务执行 migrations/014_preview_sessions.sql；验证 nano_api 有执行权限，anon/authenticated 无权限，随机不存在的 owner/session 查询为 false。现有 /etc/pivloom/api.env 的 DATABASE_URL 也指向 postgres 库，AUTH_SESSION_DATABASE_URL 可以默认不填。infra/release/deploy.sh api **不会自动运行迁移**，只做空闲检查；迁移后再发布 API，验证 version/readiness 与真实会话，最后发布 Web 并复测匿名正式发布地址。

## 生产同一 SHA 补证（2026-09-24）

- Web/API 均部署 `55845117176f706b14e1c3f9e23ec8f97e11905e`，生产迁移 014 已登记且 `nano.preview_session_active` 的权限检查通过。使用 A 的全新真实计算器项目 `bfbbe5cc-4207-4d3e-9620-84df5035e1bc` 的候选 Revision `610ad910-53dd-4fef-84fa-8606de06d6a7`，在私有 Preview 尚存活时建立两条独立的 Supabase A 会话；这只验证 Preview 会话授权，不把尚在 Reviewer 阶段的候选版当已验收应用。
- [脱敏原始 HTTP 矩阵](rc07-production-session-5584511.json)：A1、A2 分别交换专用 grant 后 HTML 200；A1 的构建资源和 revision marker 200。A1 正常 local signOut 后，复用旧 Cookie 新请求 HTML/JS/marker 均 403，旧 grant 再交换也 403；A2 同一 Preview 的 HTML/marker 仍 200。A1 重新登录取得新授权后 HTML 200。仅携 Preview Cookie/grant 访问普通平台 API 得 401；永久发布地址匿名 200。脚本在结束时退出所有新建会话，未打印或保存凭据、grant 或 Cookie。
- 生产测试没有新建 B，以保留“生产只有 A 测试账号”的交付约束。同浏览器 B、独立 B 和匿名访客越权拒绝由上面的同构隔离环境实测矩阵提供。生产候选 Preview 自然过期不影响已保存源码或公开发布。
