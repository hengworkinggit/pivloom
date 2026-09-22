# DEV-08 · 停止真实模型、远端命令和候选资源

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F09/F10。

## What to build

用户点击停止后能确认真实远端活动已结束，旧成功预览继续可用；清理未确认时明确等待并禁止启动同项目新任务。

## Implementation decisions

- POST /runs/:id/cancel 幂等；cancel_requested 先持久化，再 session.abort、命令/Chrome终止与候选沙箱清理；不能把 Promise取消当远端结束。
- 所有工具调用前/返回后校验 run/role/attempt、取消信号和预算；取消之后拒绝写入、交接、检查结果和 promote。
- 取消与 finalizing 使用同一事务行锁；完成先提交则保持 completed，取消先提交则不产生新 current。
- create句柄迟到立即登记销毁；失联保留cleanup pending并重查/生命周期兜底；确认前项目操作锁不释放，旧preview binding不误杀。

## Acceptance criteria

- [ ] 点击后立即“正在停止”，清理确认才“已停止”；刷新显示同状态；重复点击没有第二次副作用。
- [ ] 模型阶段、长命令/子进程阶段分别真实验证；注册的浏览器清理路径也可终止会话。
- [ ] 清理失败给出待确认原因并阻止下一次生成；恢复确认后可再次提交。
- [ ] 停止/完成竞争及迟到tool结果不发布被取消候选，不继续派工。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| E13/E14 + planning/review停止回归 | 先由真实三角色生成一个成功版本，再分别在模型调用、planning/review以及真实OpenSandbox长命令时停止；另测停止中刷新。 | 先stopping后cancelled；实际provider abort/远端进程结束证据齐全；旧预览仍可用。SLOW_MODEL只能证明受控adapter，需另做真实provider测试。 |
| I02/I03 | 取消与finalize前后并发、延迟tool返回、延迟sandbox创建、远端清理失败。 | 事务决定唯一终态；无取消后写入或promote；未确认不解锁；迟到沙箱无悬挂超出已记录lifetime。 |
| E26 增量 | 390px工作台通过键盘触发停止。 | 按钮状态和待确认提示可访问，不能只颜色变化。 |

## Blocked by

- [DEV-06 · #7](https://github.com/hengworkinggit/pivloom/issues/7)

## Out of scope

不做暂停/继续模型栈、撤销已经保存结果、全局kill其他项目或宿主进程。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。
