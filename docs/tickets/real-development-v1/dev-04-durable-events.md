# DEV-04 · 执行中刷新与 SSE 断线后恢复同一个任务

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F04/F06/F07。

## What to build

用户生成中刷新、断网或切换标签，重新进入仍看到同一任务的真实阶段和唯一消息；未被服务接受的修改保留为草稿。

## Implementation decisions

- fetch + Bearer + eventsource-parser；eventId 为字符串，按 ID 去重；支持 after cursor，1/2/4/8 秒上限重连，401 刷新授权，404 停止。
- 后端先订阅缓冲、读高水位并重放、再衔接实时事件；设心跳、慢客户端缓冲上限；关键事件持久化顺序不得依赖 SDK 普通 subscriber 被 await。
- GET project/run 恢复服务端权威状态；UI 保存提交中幂等 key，仅在接受结果未知时重发相同请求；已知 run 只查询/订阅。终态单调，迟到旧事件不能倒退状态。
- 跨标签项目忙和 stale base 明确反馈；离开页面断开订阅，不取消后台任务。

## Acceptance criteria

- [ ] 运行中刷新后 run ID、用户消息数量不变，最终结果可见；不多收一次模型费用。
- [ ] SSE_CLOSE_ONCE 后显示连接问题，重连自动补事件且不重放 UI 消息；token 过期不会无限读取旧连接。
- [ ] 同项目两个标签同时发送只接受一份，失败侧草稿保留；忙碌不建立隐形队列。
- [ ] tool 输出截断、分批持久化，原始日志折叠；无隐藏推理与 secret。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| E10/E20 | 真实生成过程中刷新；隔离环境关闭一次目标 SSE，然后等待结果。 | 只一个 run/用户消息；当前阶段连续恢复；完成状态不倒退；离开浏览器后服务仍继续。 |
| E19 / I01 / I04 | 两标签同时提交；集成侧在历史读取与实时订阅之间插入事件，并测试重复/分块/慢连接/授权过期。 | 事件不漏关键终态、不重复；409/503 不吞草稿；网络恢复不自动创建新任务。 |
| E26 增量 | 窄屏切换对话/结果并继续编辑草稿，查看重连错误。 | 草稿和执行状态不丢，提示键盘可达。 |

## Blocked by

- [DEV-03 · #4](https://github.com/hengworkinggit/pivloom/issues/4)

## Out of scope

不提供跨进程透明恢复 Agent 执行栈；重启中断语义由重试票承担。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。
