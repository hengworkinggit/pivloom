# DEV-06 · 检查者实际操作候选应用并绑定检查结果

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P1；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F13/F14。

## What to build

构建后由独立检查者在OpenSandbox Chrome里执行计划行为；用户看到准确的通过、失败或受阻，详情可展开，但无需阅读长报告。只有匹配版本的通过结果才允许正式成功提交。

## Implementation decisions

- Reviewer独立Pi session和每attempt独立Chrome session，仅source_read和受控BrowserPort，禁止shell与写源码。
- 动作schema包含open/observe/click/fill/select/press/scroll/screenshot/logs，工具参数不拼任意shell；目标仅已绑定预览origin，refs不跨session复用；过期refs重新观察，不盲重放写动作。
- 每项至少一个真实动作与结果观察，保存expected/actual/status及必要工件；check包含run/roleRun/attempt/revision/sourceHash/sandbox/browserSession。前后哈希/marker不符拒收。
- passed、failed、blocked分别处理；浏览器失联=CHECK_BLOCKED，不触发基于业务失败的盲修复。默认卡片摘要，详情按需读且owner授权。
- 正式finalize须对象已保存+build通过+preview marker匹配+本revision check passed，同事务提交revision/current/run/result/event。将DEV-03的检查未接入blocked分支替换为真实Reviewer；未检查候选绝不promote，也不提供生产绕过配置。

## Acceptance criteria

- [ ] 三角色真实独立执行；Reviewer读不到工作台token且不能改代码；检查结束关闭Chrome。
- [ ] 正常A/B场景有实际浏览器动作和观察；只看标题/截图/模型总结不算行为通过。
- [ ] 失败/受阻有原因且不promote；错误revision/hash/attempt/session与迟到报告拒绝。
- [ ] UI查看检查细节与工件可用，B无法读取A截图；不泄露隐藏推理或原始secret。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| 完整 E04/E05/E12/E21 | 内置浏览器分别触发真实活动A和读书B生成→观察三角色→查看检查摘要→独立在用户iframe重做关键行为。 | 正式run=completed且current匹配真实检查版本；三session/handoff审计存在；Reviewer报告与独立E2E分别记录；满足完整E04/E12关闭门槛。 |
| E24 / I06/I10 | PREVIEW_UNREACHABLE、旧版本迟到报告、ref过期、越界导航和参数注入。 | blocked未被记passed；不替换旧current；越界拒绝且会话清理，旧报告不能污染新版本。 |
| I08/I09 + E25 工件子集 | Reviewer尝试写工具；B请求A check/artifact/SSE。 | 服务端拒绝越权；无secret泄漏；相关UI可解释结果。用户在review中停止由DEV-08实现并立即回归。 |

## Blocked by

- [DEV-05 · #6](https://github.com/hengworkinggit/pivloom/issues/6)

## Out of scope

不做浏览器直播或接管用户iframe；DOM-only模型不宣传自动视觉理解；不实现自动修复循环。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。
