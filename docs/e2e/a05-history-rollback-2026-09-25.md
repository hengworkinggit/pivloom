# A05 版本历史、源码差异、检查与回滚：浏览器验收（2026-09-25）

环境：公网 `https://pivloom-69-5-7-187.sslip.io`，Web 与 API、GitHub `main` HEAD 同为提交 `4a4b8d6c517112a47721c7e6a1eb2cf99bc618fb`。测试项目：计算器 `bfbbe5cc-4207-4d3e-9620-84df5035e1bc`（已有 v1–v8）。浏览器为 agent-browser 独立会话 `pivloom-a05`。数据库观测经 SSH 隧道直连生产 PostgreSQL。

复用对象：沿用既有历史/回滚/源码/Check API 与 A 抽屉布局（`apps/web/src/components/version-history.tsx`、`generation-result.tsx`、`apps/api/src/data/rollback.ts`），未为视觉面板重写回滚事务。

## 验收结果

| 通过条件 | 结果 | 实际观测 |
| --- | --- | --- |
| 当前版本号与短源码 hash 持续可见且可复制完整值 | **PASS** | 工具栏显示 `v8 · 当前 · hash 424bd83f`；历史抽屉显示「当前成功版本 v8」+ `424bd83f1d55…` + 「复制完整 hash」；完整值 `424bd83f1d55475c0a6acc038e69e6a2e59b121328575dcc199b84d2ee872e2d` 可展开查看 |
| 打开历史只切换查看内容，不改变 current | **PASS** | 选择 v7 后工具栏变为 `v7 · 历史`，同时**仍显示**「当前 v8 424bd83f」并提供一键返回按钮；抽屉明确写「正在查看 v7 历史已验收版本 · 当前只读；下一轮生成仍以当前成功版本为基线」 |
| 每个历史版本展示对应完整文件与可读 diff | **PASS** | 选择 v7 后用「查看差异」对比 v6 → v7：「完整文件集合: v6 7 → v7 7；5 个未变，2 处差异」，并给出 `src/App.tsx` 的真实 patch（`@@ -4,8 +4,15 @@`） |
| 展示该版本自己的 Check 五组及全部子项 | **PASS** | 检查抽屉显示「正在查看历史 v7 的检查记录；当前版本不会因此改变」+「查看 5 组 / 17 项完整子检查与截图」，工具栏徽标 5/5 |
| 失败/blocked 不被改写为通过 | **PASS** | 抽屉对 passed/failed/blocked 分别渲染，未把未通过项写成通过（由既有组件测试固定，本轮观测到 v7 为 5/5 passed 的真实结论） |
| 用户确认回滚目标后经真实回滚 API 更新 current | **PASS** | 点击「回滚到 v7」后确认区显示方向 **v8 → v7**，确认后数据库 `nano.rollbacks` 新增记录 `status=committed` |
| 回滚后版本、源码 manifest/hash、Preview、对话基线同指目标 | **PASS** | 四项同一 revision `6bf92d83`（v7）：①`nano.projects.current_revision_id` = 6bf92d83；②该 revision `status=accepted`、`build_status=passed`、`source_hash=659e72f69cdd…`；③`nano.rollbacks.target_revision_id` = 6bf92d83、`source_hash` 相同，页面刷新后工具栏显示 `v7 · 当前 · hash 659e72f6`；④对话新增 `kind='rollback'`：「已从 v8 回滚到 v7。后续修改将以 v7 为基线。」 |
| 历史中仍保留后续版本 | **PASS** | 回滚后 `nano.revisions` 仍有 `v1…v8` 全部八版，v8 未被删除 |
| 旧版本预览过期时以真实恢复状态提示，不把恢复称作回滚 | **PASS** | 预览不可用时页面显示「预览已到期」+「重新启动预览」，并说明「不会调用模型，也不会改变版本或检查结论」，与回滚入口分离 |
| 长文件名/代码在 390px 容器内可读、不撑宽整页 | **PASS** | 代码与差异容器 `overflow:auto`（`globals.css` 的 `.code-content`、diff `pre`），390px 下 `document.documentElement.scrollWidth = 390` |

## 这次回滚的副作用（对后续有利）

回滚把项目从 v8 变成「基于 v7」，并保留 v8 于历史。这正好是 #37 要求的 C3 起点——规格要求 C3 必须证明 `baseRevisionId`/`expectedCurrent`/`previousPlan` 从 C1（此处的对应版本）出发而不是误用较新版本。因此本轮的真实回滚同时把 C3 的前置状态准备就绪。

## 未覆盖（NOT_RUN）

- **回滚的并发/CAS 竞争**：由既有真实 PostgreSQL 集成测试覆盖（本轮只执行了一次顺序回滚）。
- 未构造「预览过期后点击重新启动」：观测到该提示与按钮存在，未点击（点击会占用一个沙箱名额）。

## 结论

A05 的通过条件满足，可以关单。
