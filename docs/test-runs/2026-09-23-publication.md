# 可选永久发布验收（2026-09-23）

发布是显式操作：普通生成只保存版本和临时预览，不分配永久域名。用户点击“永久发布”时，仅允许当前已通过浏览器检查的版本；预览过期时先从已保存源码重建，再将版本匹配的静态构建产物复制到宿主持久目录。独立地址不依赖沙箱存活。后续已验收版本可以由用户再次点击发布更新同一项目地址。

## 真实环境结果

- 公网工作台：<https://pivloom-69-5-7-187.sslip.io/>；公开仓库：<https://github.com/hengworkinggit/pivloom>。
- 项目 `aff32973-781f-4a2e-8723-7f3526a93518`：发布前认证 GET `/publication` 返回 `publication: null`；从保存版本 `d2f412c2-5b18-47e5-b77f-0e82283c1419` 恢复预览，观察到 `restoring → ready`；认证 POST `/publication` 返回 200 与独立 HTTPS 地址；再次 GET 返回相同版本。公网地址 <https://aff32973-781f-4a2e-8723-7f3526a93518.app-69-5-7-187.sslip.io/> 返回 200，HTML 正确引用静态资源。
- 独立 Chromium 无登录打开上述读书清单应用，添加“发布验收读物 / Pivloom QA”，刷新后条目仍存在。此数据由应用自身 localStorage 保存，仅限该浏览器与域名，不代表生成应用具备云数据库。
- 既有活动报名应用 <https://3c866a6a-26e9-4af4-89d4-d84127b7d430.app-69-5-7-187.sslip.io/> 的预览沙箱已销毁，独立地址仍返回 200；此前独立 Chromium 的表单提交及刷新已通过。
- 原有站点 <https://beats-steps-69-5-7-187.sslip.io/beats> 和工作台登录、API readiness 在 Caddy 与 API/Web 切换后仍返回 200。

模块验证：API 类型检查与 lint 通过；API 测试 261 通过、49 跳过；Web 类型检查与 lint 通过，75 测试通过；API 与 Web 生产构建通过。永久发布修复提交 `95e9c73`，前一完整实现提交 `f61fc91` 的 CI 已通过。发布产物 `dev18-20260923-publish-lines`（API）及 `dev17-20260923-published-apps`（Web）已在服务器运行。

当前只托管生成应用的静态前端；不提供每应用独立后端、云数据库或自定义域名。
