# DEV-03 / #4 真实工作台前端联调记录

时间：2026-09-22 11:21（Asia/Shanghai）。基线 `dee0ae5` 加本轮未提交工作区。当前结论是**前端可联调，真实模块 E2E 待主执行者完成**，不能据此关闭 #4。

## 实现范围

- 既有 `/projects/:id` 在 API 模式显示服务端消息、Run 状态/阶段、真实事件，以及所选模型配置版本；显式 Demo 页面保持原样。
- 使用共享 contracts，提交 UUID `Idempotency-Key` 与 text、expectedCurrentRevisionId、modelProfileId、modelConfigVersion。接受前保留草稿；接受后仅清已发送的内容，等待期间编辑的下一条需求不丢失。
- 网络结果未知时保留 owner/project 隔离的原 key/body，提供“确认提交结果”；明确 4xx 拒绝保留草稿。202 已接受但随后状态 GET 暂时失败时仍禁用新提交，通过读取已知 Run 恢复。
- SSE 走统一 Bearer/401 refresh/epoch 边界，退出即中止流。使用 eventsource-parser 解析分块 UTF-8、校验 envelope、bigint cursor 去重；SSE 触发权威状态重读，短轮询兜底。离开页面只断开读取，不调用任务取消。
- CHECK_BLOCKED 的已保存候选明确显示“尚未检查”，不晋升 current。真实任务 ID 和配置版本可见；没有伪造角色、百分比、工具结果或检查通过状态。
- 候选预览核对 revisionId/sourceHash，仅加载 HTTP(S) 且不同工作台来源的 URL。iframe 不包含工作台 token，sandbox 仅允许 scripts/same-origin/forms，禁止顶层导航权限；相同预览的后台状态更新不重新挂载 iframe。
- 预览/代码页签、桌面/窄屏预览宽度、刷新/新标签、只读 manifest 和文件内容；键盘页签切换、中文 composition/229 保护、空白/超长输入保护。390px 复用现有对话/结果切换布局。
- 运行中显示本次锁定的模型配置版本；若当前配置已改版或删除，显示冻结引用，避免把当前默认模型误称为本次运行模型。

## 自动验证

```text
npm run test -w @pivloom/web
9 files / 31 tests PASS
npm run typecheck -w @pivloom/web
PASS
npm run lint -w @pivloom/web
PASS
git diff --check
PASS
```

较基础模块新增 7 项测试，关键行为经过 red→green：

| 边界 | 本轮证明的行为 |
| --- | --- |
| 公共 HTTP/auth | SSE 401 刷新、退出中止流；明确服务端拒绝保留 HTTP 状态，区别于未知提交结果。 |
| SSE HTTP 字节流 | 跨块中文解码、超过 JS 安全整数范围的事件 ID、重复/较旧事件去重、错误 Run 事件拒绝。 |
| 生成 API + 草稿存储 | 网络断开后刷新可恢复原提交 key/body，其他 owner 无法读取，确认请求保持原始快照。 |
| 实际 React DOM | 中文 composition 不误发；发送携带真实所选配置/version；202 接受前保留原草稿；过程中编辑的新草稿保留；运行中不能重复发送；初次 snapshot 503 仍保持等待状态。 |
| 实际 React DOM | CHECK_BLOCKED 候选展示未检查、读取快照文件且只读；同源 iframe 拒绝；不同来源 iframe 的限制正确；后台 snapshot 刷新保持同一 iframe DOM 节点。 |

上述测试使用生产 React 组件、Supabase SDK 和 adapter，仅在外部 HTTP/身份、Next 导航边界注入 fixture。没有调用真实模型或创建远端沙箱；不能替代真实浏览器或 Postgres/Storage 集成结果。31 项中包含此前的 24 项基础/Demo 回归，不把它们重复计作真实生成成绩。

## 文件与联调入口

- `apps/web/src/components/api-workbench.tsx`：输入、消息、模型选择、候选选择与页面组合。
- `generation-state.ts`：项目/Run 权威快照、真实事件、轮询和订阅生命周期。
- `generation-activity.tsx`：真实阶段/事件与终态解释。
- `generation-result.tsx`：独立来源 iframe 与服务端只读源码。
- `apps/web/src/lib/generation-api.ts`、`run-events.ts`：共享协议适配、提交快照、SSE 解析。
- `api-workspace.ts`：小范围扩展 `requestStream` 与 `WorkspaceError.httpStatus`，沿用身份隔离。
- 新增对应测试及 `globals.css` 中 `.generation-*` 响应式样式。

主执行者可从已登录项目页选择通过测试的模型并发送需求。没有添加临时跳过鉴权、硬编码账户/Key、静态成品或模拟执行入口。

## 仍待真实验收

活动报名和读书清单两条真实模型生成链路；Storage/DB 引用一致性；候选 iframe 的实际增删/校验/筛选及刷新数据保持；新标签版本绑定；1280×800 和 390px 的真实布局与键盘；两个有效模型配置切换；真实 SSE/代理行为、owner 拒绝与失败注入。由主执行者记录真实环境、API boot ID、Run/Revision/hash、截图、清理及结果，本补充不填造 PASS。

完整持久事件窗口/断线恢复验收属于 DEV-04；停止、失败重试、恢复过期预览、Reviewer 行为检查和正式 current 晋升不在本轮前端交付范围。页面没有未接通的相应操作按钮。

该报告无凭据、完整 token 或模型 API Key；fixture 测试未产生服务器资源，无额外清理对象。
