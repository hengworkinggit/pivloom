# RC-09 · 原子回滚隔离复核（局部完成）

关联 [#25](https://github.com/hengworkinggit/pivloom/issues/25)。本轮仅在本机独立 PostgreSQL `pivloom_rollback_test_rc09_local`、合成身份与 HTTP 沙箱夹具执行，不访问生产 A 项目、发布作品或正在运行的 #27 真实沙箱。Web/API 来自同一个干净提交 `16deb75b12392dab3f92628d3a9de501f600cc20` 的构建包；[Web](rc09-isolated-web-build.json)、[API](rc09-isolated-api-build.json)以及页面徽标同 SHA。**#25 保持开放**：此例证明平台回滚状态机的可观察主路径，不代替真实计算器 A0/A1/A2 三版和真实 OpenSandbox 验收。

## 最小浏览器→API→PostgreSQL 场景

隔离项目 `40e35d70-1a0f-460d-b57d-93afdc9ecb08` 预置 v1/v2/v3 三个 `accepted` 版本及 passed Check。三版均为**直接构造的源码/Check 夹具，未由模型生成或重新验收**；完整源码分别为 7/8/8 文件，v2 增加 `src/extra.ts`，v3 换为 Unicode 路径 `src/界面.tsx`，初始 current 为 v3 `c89becfd-11a7-4e7f-a1da-f4e252f66575`。Check 的旧记录是历史平铺 0/0，浏览器正确标出“回滚重建后的预览尚未重新验收”，没有伪造新 Check。

独立浏览器登录后从历史选择 v1 `befa8ec0-1a81-4cc0-98e5-f994dfa7e814`，确认框明确显示 **v3→v1**、保留历史和已发布作品不自动更新。[确认页面](rc09-isolated-confirm.png)。实际 API 接受后，回滚 `6e8f2440-ae71-4abb-b836-ab1be6b088c8` 从 `preparing` 到 `committed`，项目 current 原子切到 v1、操作锁为 NULL，仍只有原三版 revision 和历史对话；追加的 rollback 消息没有伪装成新的模型 Run。模型调用计数在回滚期间为 **0**，只创建一条本机 HTTP 沙箱夹具。

回滚所用的完整 v1 对象哈希为 `52386076c720dc3f156c59e3bbe02f0c5b6f54ba42c85c945214b67ea4e49b08`；构建后的 marker、Preview binding 与 v1 revision/sourceHash 精确一致，API 返回 Preview `ready`。浏览器 iframe 显示“计数器 v1”，历史 v2/v3 继续可选；会话中显示“已从 v3 回滚到 v1。后续修改将以 v1 为基线。”[提交后页面](rc09-isolated-committed.png)。全新浏览器会话重新登录仍看到 current v1、回滚消息和 Preview；代码页只读列出 v1 完整 7 文件，没有 v3 的 Unicode 额外文件。[新会话](rc09-isolated-fresh-session.png) · [源码页](rc09-isolated-source-tree.png)。[脱敏 DB/完整文件哈希/marker/HTTP 原始摘要](rc09-isolated-e2e.json)。

同一 `Idempotency-Key` 对已提交回滚重放得到 HTTP 200、`replayed=true`、相同操作 ID，未新建沙箱；新键携带过期 v3 expected current 得 `409 STALE_BASE`。回滚后浏览器新提交一条修改，测试模型夹具明确返回 401；该新 Run 虽未生成新版本，但其 `base_revision_id` 和 planning context 的 `previousPlan.goal` 分别精确指向 v1 和“计数器 v1”，项目 `next_revision_no=4` 未倒退、旧 current 未变。API 的 v3→v1 完整源码 diff 为 6 个未变文件、`src/App.tsx` 修改和 `src/界面.tsx` 删除。

## 自动检查与未覆盖前置

当前代码的隔离 PostgreSQL 回滚持久化 6 项与沙箱源码重建 5 项合计 **11/11 PASS**；Web rollback API、hook、版本历史 3 个文件 **6/6 PASS**。这些测试覆盖 owner/CAS/同键幂等、双请求竞争、取消、准备失败后的锁、boot claim 和已准备提交，以及完整文件集合、Unicode、保存的 package/lock/模板版本与残留文件拒绝。它们是单元/集成证据，不冒充浏览器故障 E2E。

E35 的真实 A0/A1/A2 生成、目标 v1 的**实际业务**重新运行和通过、下一次修改生成 v4，以及正式站点不自动更新，均 **NOT_RUN**；本轮 iframe 的“计数器 v1”由 HTTP 沙箱夹具呈现。E36 的准备/绑定/提交门槛、进程重启、响应丢失及两个真实浏览器标签竞争在本轮 UI 流程中 **NOT_RUN**，仅上述 repository 集成测试覆盖。E38 的恢复端已通过产品完整哈希/marker 检查，且独立源码 diff/manifest 可回读；未对真实 OpenSandbox 中的目标工作区重新列举逐文件内容，故真实远端子项 **NOT_RUN**。这些缺口未被记为 PASS。

测试沙箱夹具按唯一 `restore-v1` 绑定精确销毁，独立 SDK 得 404，本地 Preview binding 标记 destroyed；[沙箱清理记录](rc09-isolated-cleanup.json)与[管理器原始事件](rc09-isolated-manager-events.json)。取证后按合成 owner/project 清理 2 个 Auth 用户、1 项目、4 Runs、3 Revisions、3 Checks、1 rollback、1 沙箱记录和 3 个私有源码对象；七类持久表残留均为 0，[本机数据清理核对](rc09-isolated-data-cleanup.json)。独立浏览器、本机 Web/API/Auth/沙箱管理器和 PostgreSQL 均已关闭；生产没有变动。
