# RC-03 · E15 受控模型失败后真实 Provider 重试

关联 [#19](https://github.com/hengworkinggit/pivloom/issues/19)；执行于 2026-09-24（Asia/Shanghai）。按 [E15 契约](../../docs/E2E.md)逐项核对，**E15 PASS**。本机 Web/API 从干净生产源码提交 `9255399a8685b0c69f2bb9b2b4a04177d123a83c` 同时构建，页面两个部署徽标和两端 `/version` 均匹配；独立包记录见 [Web](rc03-e15-925-web-build.json)、[API](rc03-e15-925-api-build.json)。这是一份同提交的隔离构建，并非在生产账号或项目上注入故障。

## 环境和明确的夹具边界

新建本机 PostgreSQL `pivloom_e2e_test_rc03_e15`、合成 Auth owner 与空项目 `a3ed4666-6c38-47db-9ccd-1614d900d7f4`，owner 与生产 A 不同。对生产 A 已验证的 `kimi-k2.7-code` 配置仅执行只读查询；streaming/tools/vision 均为 `verified`、最近连接测试 `passed`。Provider 凭据只在隔离播种进程内解封，立即按合成 owner 重新加密存入本地测试库；**明文未写磁盘或报告**，生产 A 配置未修改。Auth 与对象存储 HTTP 由本机夹具提供；源码快照使用本机私有对象目录。截图对象通过真实 Supabase JS 上传/下载接口与产品校验路径，8 个 PNG 均独立核对 SHA256；[本机存储请求记录](rc03-e15-925-storage-operations.json)包含 9 次成功上传、9 次成功下载（含一次预检），没有错误。这不冒充运行了完整 Supabase 云服务。

首 API 进程的唯一模型边界夹具对首次 Run 返回一次不可重试 401，**不声称首轮发生真实 Provider 认证故障**。它结束后停止该进程，以同一 `9255399a...` API `dist` 产物启动没有 `generationBoundaries.modelFetch` 覆盖的新进程；点击页面重试后使用产品原生模型传输及真实 OpenSandbox。后续 Coordinator、Builder、Reviewer 的模型回复、源码、操作和结论均非固定模板夹具；模型调用次数来自持久化的 Pi 角色账本，而不是对每个 HTTPS 请求的独立抓包。

## 两轮实际结果

独立浏览器提交中文计数器需求，首 Run `c7042522-3868-4b88-8732-4f8c9716e1a2` 在 Coordinator 得到**一次**受控 401，落库 `failed / MODEL_FAILED / cleanup confirmed`，无候选、无沙箱、current 为 NULL；页面明确说明错误并保留原需求与“以新任务重试”。[首轮页面](rc03-e15-925-first-401.png)。

在浏览器点击一次重试创建 Run `4daa0764-59c0-49f4-98e0-206d2dd3190f`：`kind=retry`、`retry_of` 精确指向旧 Run，两个 Run 请求文字相同，base/current 均为 NULL；数据库只有这两次 accepted 任务，旧失败记录未被覆盖。真实模型返回了与需求对应的五组 7 项计划，Builder 写出 7 文件源码并通过可信构建，`src/App.tsx` 包含“加一”和“重置”。Pi 账本记录 Coordinator 2、Builder 6、Reviewer 33 次模型调用；真实沙箱只有 `0f1fcd7a-6851-4230-9aad-0e87b7b3271a` 一条。最终 Run `completed`，revision `14ccb77c-3f8d-4248-b6bd-d74085aa695e` 被接受为 current，sourceHash `14c4567c50c8ac156be1281db325e9933f80e20e78d1a85d35a979b89b7424a4`。Check `d182ce3e-87f3-4262-b5da-6b06501be3af` **passed：5/5 组、7/7 子检查、8 张有效 PNG**；Preview 与 revision/sourceHash 一致，状态 `ready`。[完成页面](rc03-e15-925-passed.png) · [脱敏 DB/版本/检查原始摘要](rc03-e15-925-state.json) · [密钥与工件审计](rc03-e15-925-audit.json)。

独立于产品 Reviewer 的浏览器通过同一工作台 Preview iframe 实际操作计数器，观察 **0→1→2→重置0**，切换窄屏布局后仍可用。[点击画面](rc03-e15-925-clicked.png) · [窄屏画面](rc03-e15-925-narrow.png)。这验证了可访问的应用行为，不把“模型自称完成”、构建通过或检查 exit0 单独当作产品成功。

## 资源与安全收口

截图和原始记录保存后，先用官方 SDK 查询沙箱 metadata 的 `run_id` 与新 Run 完全相同，再经产品 `destroyCandidateSandbox` 执行官方 kill/get 确认；另建全新 SDK manager 独立 `getSandboxInfo=404`，活跃沙箱数 0，且只更新本地测试库对应的一条沙箱 binding 为 `destroyed`。[远端精确清理记录](rc03-e15-925-remote-cleanup.json)。扫描本轮公开消息、事件、错误及全部保存源码，未发现 Provider 明文密钥；生产 A 的数据和发布文件均未变动。合成身份、项目及 10 个本机对象文件按精确 owner/project manifest 清理，七类持久表中该 owner 的残留均为 0；[本机清理核对](rc03-e15-925-local-cleanup.json)。独立浏览器、本机 Web/API/Auth/Storage 和 PostgreSQL 均已停止。
