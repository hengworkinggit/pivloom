# DEV-05 · 协调者澄清需求并向工程师交接可观察目标

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P1；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F03/F13；F14的计划前置。

## What to build

用户提出需求后看到协调者实际整理目标和1–5个可观察行为，再由独立工程师执行；必要时只问一个关键问题并释放资源，用户补充后继续新任务。

## Implementation decisions

- Coordinator与Builder独立Pi session；服务端工具allowlist隔离，Coordinator只读摘要、提交计划和请求澄清。
- 计划与handoff schema校验并先持久化，记录run/roleRun/attempt/base revision；执行状态由服务端推进而非模型声称完成。
- needs_input为终态并释放资源；回答创建带parentRunId的新run，合并问题上下文；与retryOfRunId互斥。
- 普通配色布局合理默认；支付、跨用户后端等范围外请求说明前端演示限制，不能静默假付款。参考Multica交接机制但不复制受附加许可约束源码。

## Acceptance criteria

- [ ] 本票新建/澄清链路都有实际Coordinator→Builder活动及独立session ID；修改计划保留旧行为的契约先做集成断言，DEV-07真实修改时立即回归；不存在未执行角色动画。
- [ ] 计划行为可直接用于交互检查；无效schema、重复handoff、旧attempt输出不能推进。
- [ ] 澄清结束无活动槽位/沙箱泄漏，回复关联新run与原问题；颜色等可逆选择不反复审批。
- [ ] 协调者写源码或执行shell请求被服务端拒绝，不能仅依赖prompt。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| E29 | 输入缺关键业务语义的需求→收到单个问题→查看任务已结束→回复；另输入范围外要求。 | 新run有parent引用，原需求未丢；说明能力边界；普通需求无需不必要澄清。 |
| E21 Coordinator/Builder子集 + I08 | 执行正常需求并查看真实角色摘要；测试无效计划、重复交接、越权工具。 | 独立session、先持久后通知；写工具拒绝；旧run/attempt不接收。 |
| E26 增量 | 在390px工作台回答澄清，并观察needs_input资源释放。 | 问题与输入可访问、无隐藏排队；不要求本票尚未开发的用户停止入口。 |

## Blocked by

- [DEV-03 · #4](https://github.com/hengworkinggit/pivloom/issues/4)

## Out of scope

不做自由组队、并行Race、任意角色mention派工；Reviewer由下一票实现。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。
