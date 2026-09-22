# DEV-12 · 检查失败后最多两轮真实修复与复查

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P1；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F10/F14。

## What to build

用户无需手动搬运错误：可修复构建/行为失败交回工程师，生成新候选并复查；最多两轮，仍失败则保留问题与候选、继续展示旧成功结果。

## Implementation decisions

- attempt=0初次，1/2修复；修复与前序角色共用run的deadline/token/tool预算，不为修复重置预算。
- 只将具体failed行为和诊断交给Builder；每轮独立候选snapshot、browser session和带版本handoff，重新可信构建/检查。
- 达到上限needs_changes；check blocked是基础设施问题，不冒充行为错误无限修；用户显式重试另建run。
- 无current的首次失败可查看build通过且已保存候选；沙箱清理后按预览恢复票处理。build失败只展示源码和诊断；不清掉可诊断资产。

## Acceptance criteria

- [ ] 可复现坏筛选被真实Reviewer发现，再由真实Builder修复并实际复查通过。
- [ ] 持续坏筛选最多attempt0/1/2，绝无第3轮修复；终态needs_changes且旧current可操作。
- [ ] 构建错误也进入有界修复；预算/取消可提前终止并清理；迟到旧check不产生成功。
- [ ] 默认结果卡只显示改动/检查结论/问题/下一步；展开可读行为与必要证据；不得假造历史。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| E16/E22 | 隔离环境分别注入首次无效TS、首次可构建但坏筛选；后续修复使用真实模型，UI观察工程师→检查者再交接。 | 检查证据具体指出失败；新候选修复与复查通过；首版fixture与后续真实执行明确标注。 |
| E23 / I08 | PERSISTENT_BROKEN_FILTER保持各次失败；读取角色/attempt及模型预算记录。 | repair≤2；needs_changes；上一成功预览与源码不变；普通“模型说完成”不能结束run。 |
| E24/I06/候选恢复回归 | 修复中注入旧报告和浏览器受阻；首次无current失败后查看候选。 | 不误promote、不无穷修复；候选警示可见并可按需恢复，检查状态不被抹去。 |

## Blocked by

- [DEV-11 · #12](https://github.com/hengworkinggit/pivloom/issues/12)

## Out of scope

不做无限自愈、跨天人工审批工作流、通用证据平台或每版本强制用户阅读验收报告。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。
