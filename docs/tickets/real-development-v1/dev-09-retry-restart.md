# DEV-09 · 失败后新建重试任务并恢复 API 重启中断状态

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F07/F10。

## What to build

用户遇到模型、构建、保存失败或服务重启时看懂原因，并以新 run 重试；旧错误记录和上一成功版本保留，系统不会悄悄重放 shell。

## Implementation decisions

- retryOfRunId只指向本项目适用失败终态，text与原请求一致；新run关联旧run，选用校验有效候选或原base；不得把旧终态重置为active。
- 启动扫描遗留accepted/active/operation，标interrupted并确认远端清理；accepted已落库但未启动也不得无限等待。
- 模型鉴权、构建、预览、检查基础设施、保存、budget与restart错误分类；用户卡片简短原因+下一步，详情有run ID且脱敏。
- 故障通过隔离adapter profile定向注入，生产拒绝profile，普通用户prompt和query不能启用。

## Acceptance criteria

- [ ] 模型失败显示明确错误；重试新run ID、只新增一条合理关联记录，失败历史仍可读。
- [ ] 非零构建不标完成；Storage失败不丢原current；重试后的保存才出现新成功结果。
- [ ] 强制API退出并重启，遗留任务interrupted；服务端已接受需求仍在，无自动重复模型/shell调用。
- [ ] cleanup未确认时重试被拒绝且草稿/失败需求保留；外部错误不泄露密钥。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| E15/E18 | MODEL_ERROR_ONCE→UI点击重试；另在accepted后、build中分别重启API→重开项目→重试。 | 新run关联旧run；已存消息/current不丢；日志无透明重放；成功路径恢复。 |
| E16 基础失败/E27 + I07 | 注入非零build、Storage写失败；查询DB和UI结果，再进行允许的重试。 | 失败不promote；清理与恢复状态一致；本票不冒充自动修复已实现。 |
| I01 重试子集 | 重复点击/同key请求重试，修改text或越权retryOfRunId。 | 只一个新run；非法引用和内容拒绝，无他人数据泄漏。 |

## Blocked by

- [DEV-08 · #9](https://github.com/hengworkinggit/pivloom/issues/9)

## Out of scope

不做持久工作流引擎、断点自动续跑或无限provider重试。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。
