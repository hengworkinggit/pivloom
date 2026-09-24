# RC-12 · E01–E42 证据索引草稿

冻结候选：`e3f9b4f765949123da0d11ac4d84d8528ffda3b6`。本表仅据 [`docs/E2E.md`](../../docs/E2E.md)、截至本提交已入库的脱敏报告及 GitHub Issue 状态编制；**没有在该 SHA 重新操作生产 UI、调用模型或注入故障**。#17–#24 已关闭代表各模块曾完成其范围，不自动继承为 RC-12 最终 PASS；[#25](https://github.com/hengworkinggit/pivloom/issues/25)、[#26](https://github.com/hengworkinggit/pivloom/issues/26)、[#27](https://github.com/hengworkinggit/pivloom/issues/27)、[#28](https://github.com/hengworkinggit/pivloom/issues/28) 仍开放。按完整最终契约，本草稿当前为 **PASS 0 / FAIL 2 / BLOCKED 10 / NOT_RUN 30**；FAIL 是旧 SHA 最近一次真实失败，仍需在冻结版重测，不是对 e3f 的新失败判定。

状态口径：**PASS** 需满足该 E 用例完整步骤且有冻结 SHA 证据；**FAIL** 是最近一次真实目标用例有可复查失败（即使旧 SHA，不能视为冻结版结论）；**BLOCKED** 是契约前置未满足；**NOT_RUN** 是尚无该完整用例的最终执行记录。单元/集成、受控 fixture、旧应用、旧 SHA 的局部 PASS 只列在“已执行范围”，不升级状态。最后一列“是”表示 `e3f9b4f` 仍需按原契约实测；“前置后”表示须先补依赖样本。若后续另有未入库证据，应追加原始记录并重判，不能回填本表为 PASS。

目前最短关键链是 **E04/E05 真实 A0 被产品 Check 接受 → E08 A1 → E09 A2 → E11 跨浏览器 → E35 回滚**；另一路是 **E12/E42 真实生成贪吃蛇的产品 5/5 + 独立玩法**。已保存候选的可玩性、旧版四则 QA、或隔离三版回滚都不能跳过这些前置。

| 用例 | 当前 | 实际已执行范围与边界 | 证据 / Issue | e3f9b4f 复测 |
| --- | --- | --- | --- | --- |
| E01 登录与项目列表 | NOT_RUN | 旧交付有登录/项目工作台；无冻结 SHA 的从无态登录→刷新→退出→保护 URL 全流程。 | [旧交付矩阵](../../docs/test-runs/2026-09-23-delivery-matrix.md) · [#3](https://github.com/hengworkinggit/pivloom/issues/3) | 是 |
| E02 错误账号/过期身份 | NOT_RUN | Auth 拒绝与隔离测试存在；未见冻结版 UI 错误→正确登录→失效身份→草稿保留的同链证据。 | [RC-07](rc07-preview-session.md) · [#3](https://github.com/hengworkinggit/pivloom/issues/3) | 是 |
| E03 空项目/输入边界/中文输入 | NOT_RUN | 旧项目模块已关闭；没有冻结版空格、超 8,000 字、输入法确认和 Shift+Enter 的正常 UI/无多余 Run 记录。 | [旧交付矩阵](../../docs/test-runs/2026-09-23-delivery-matrix.md) · [#3](https://github.com/hengworkinggit/pivloom/issues/3) | 是 |
| E04 全新计算器真实生成 | FAIL | A0 多轮真实模型写出计算器并构建；最新保存 v4 在旧 SHA `92246de` 的 Run 无有效 Check/current，未完成产品 5/5；不是 e3f 结果。 | [A0 失败](rc10-a0-real-calculator-failure.md) · [v4 独立 QA](rc10-calc-v4-qa/report.md) · [#26](https://github.com/hengworkinggit/pivloom/issues/26) | 是 |
| E05 计算器完整业务行为 | BLOCKED | 旧 SHA v4 **候选**独立浏览器实际验证优先级/括号/小数/错误恢复/键盘/390px；没有已接受 A0 与产品完整五组 Check。 | [v4 独立 QA](rc10-calc-v4-qa/report.md) · [#26](https://github.com/hengworkinggit/pivloom/issues/26) | 前置后 |
| E06 刷新/新标签/版本 | BLOCKED | 旧 SHA v4 候选恢复后曾打开新标签并核对 marker；其 Run 未被接受，未在冻结版健康 A0 上做桌面/窄屏切换。 | [v4 独立 QA](rc10-calc-v4-qa/report.md) · [#26](https://github.com/hengworkinggit/pivloom/issues/26) | 前置后 |
| E07 真实源码查看 | NOT_RUN | RC-08 与旧版工作台可读完整历史源码/差异；尚无冻结版已验收新样本全部文件、逐文件 hash、刷新与只读 UI 对照。 | [RC-08](rc08-version-history.md) · [#24](https://github.com/hengworkinggit/pivloom/issues/24) | 是 |
| E08 同项目功能增量 A1 | BLOCKED | A0 未验收，未发送真实 A1；旧书单/计数器样本不等于计算器历史功能增量。 | [A0 边界](rc10-calc-v4-qa/report.md) · [#26](https://github.com/hengworkinggit/pivloom/issues/26) | 前置后 |
| E09 同项目视觉增量 A2 | BLOCKED | A1 未完成；无真实 A2 的深色/橙色/等宽区 390px 画面及 A0/A1 全回归。 | [A0 边界](rc10-calc-v4-qa/report.md) · [#26](https://github.com/hengworkinggit/pivloom/issues/26) | 前置后 |
| E10 生成中刷新工作台 | NOT_RUN | DEV-04 的旧任务/SSE 恢复曾测；没有冻结版正常修改 Run 刷新前后同 ID、无重复 POST 与最终消息/角色对照。 | [旧交付矩阵](../../docs/test-runs/2026-09-23-delivery-matrix.md) · [#5](https://github.com/hengworkinggit/pivloom/issues/5) | 是 |
| E11 全新浏览器/退出重登 | BLOCKED | RC-07 合成计数器曾用独立 A 会话核对项目/历史/源码/Preview；A2 未完成，未对其完整对话与三版数据在冻结版重验。 | [RC-07](rc07-preview-session.md) · [#23](https://github.com/hengworkinggit/pivloom/issues/23) · [#26](https://github.com/hengworkinggit/pivloom/issues/26) | 前置后 |
| E12 全新 Canvas 贪吃蛇 | FAIL | #27 四次真实 Provider 候选；第四轮旧 SHA `92246de` 构建通过，但 Reviewer 20 分钟截断，正式 Check 0/5、19 项 blocked，独立 v4 全玩法未执行。 | [第四轮超时](rc11-fourth/rc11-fourth-timeout.md) · [#27](https://github.com/hengworkinggit/pivloom/issues/27) | 是 |
| E13 模型阶段停止 | NOT_RUN | RC-02 真实 Provider abort 与受控角色生命周期有证据；冻结版 Coordinator/Builder/Reviewer 三阶段 UI 停止、幂等及清理矩阵未重做。 | [RC-02](rc02-lifecycle.md) · [#18](https://github.com/hengworkinggit/pivloom/issues/18) | 是 |
| E14 远程命令阶段停止 | NOT_RUN | RC-02 使用真实 OpenSandbox 长命令确认终止；旧资产、UI 停止状态与随后新任务的冻结版全链未重验。 | [RC-02](rc02-lifecycle.md) · [真实远端记录](rc02-real-remote-command.json) · [#18](https://github.com/hengworkinggit/pivloom/issues/18) | 是 |
| E15 模型失败与用户重试 | NOT_RUN | 同 SHA `9255399` 的隔离 Web/API：首轮受控 401、UI 点击关联重试、后轮真实 Provider/沙箱、5/5 计数器已完整通过并清理；非冻结 e3f。 | [E15 报告](rc03-e15-925-real-provider.md) · [#19](https://github.com/hengworkinggit/pivloom/issues/19) | 是 |
| E16 构建错误与修复 | NOT_RUN | 旧交付以标注 TS 错误首产物→真实 Builder 修复/构建/Reviewer/IAB 通过；未在冻结版重跑，不能算初次模型质量。 | [旧收尾](../../docs/test-runs/2026-09-23-finalization.md) · [#13](https://github.com/hengworkinggit/pivloom/issues/13) | 是 |
| E17 预览失效后恢复 | NOT_RUN | 旧 SHA v4 候选第二次恢复 ready、marker/hash 不变且无新模型 Run；首次恢复超时。正式已验收版本的冻结版流程未重验。 | [v4 预览 QA](rc10-calc-v4-qa/report.md) · [#11](https://github.com/hengworkinggit/pivloom/issues/11) | 是 |
| E18 API 进程重启 | NOT_RUN | 旧 SHA `4733d3a` 隔离 API 强杀/重连/旧版本保留/关联重试曾判 PASS；非冻结版、不能中断正式 Demo 代测。 | [E18 验收](rc03-e18-4733-acceptance.md) · [#19](https://github.com/hengworkinggit/pivloom/issues/19) | 是（隔离） |
| E19 忙碌输入/多标签 | NOT_RUN | 旧仓库同项目互斥与草稿路径有测试；无冻结版两真实标签尝试、可见草稿、任务后重发。 | [旧交付矩阵](../../docs/test-runs/2026-09-23-delivery-matrix.md) · [#12](https://github.com/hengworkinggit/pivloom/issues/12) | 是 |
| E20 SSE 断开重连 | NOT_RUN | RC-03 隔离定点断流/事件去重原始记录，DEV-04 旧 UI 验收；缺冻结版连接提示→自动重连→同 Run/结果页面链。 | [断流记录](rc03-e15-e20.json) · [#5](https://github.com/hengworkinggit/pivloom/issues/5) | 是 |
| E21 三角色正常交接 | BLOCKED | E15 旧 SHA 计数器三角色及 Reviewer 证据完整；E04/E08 冻结版真实样本尚未被接受，未做同版本 UI/角色审计。 | [E15 报告](rc03-e15-925-real-provider.md) · [#26](https://github.com/hengworkinggit/pivloom/issues/26) | 前置后 |
| E22 行为缺陷发现并修复 | NOT_RUN | 旧交付 `BROKEN_FILTER_FIRST_ATTEMPT` 有真实 Reviewer/后续 Builder 与 IAB 操作；首产物是标注 fixture，冻结版未重做。 | [旧收尾](../../docs/test-runs/2026-09-23-finalization.md) · [#13](https://github.com/hengworkinggit/pivloom/issues/13) | 是（隔离） |
| E23 两轮修复上限 | NOT_RUN | 旧交付 `PERSISTENT_BROKEN_FILTER` attempt 0/1/2、needs_changes 与旧 current 曾 PASS；冻结版尚无该故障场景。 | [旧收尾](../../docs/test-runs/2026-09-23-finalization.md) · [#13](https://github.com/hengworkinggit/pivloom/issues/13) | 是（隔离） |
| E24 浏览器受阻/旧版本结果 | NOT_RUN | 代码与旧模块有受阻/版本绑定测试；缺冻结版预览不可达的 UI blocked、恢复重试及旧报告竞争结果。 | [#7](https://github.com/hengworkinggit/pivloom/issues/7) · [#19](https://github.com/hengworkinggit/pivloom/issues/19) | 是（隔离） |
| E25 账号/会话/私有资源隔离 | NOT_RUN | RC-07 同构隔离 A1/A2/B/访客与生产旧 SHA A1/A2 Preview HTTP 阵列；冻结版回滚资源、全平台数据与独立 UI 矩阵未合并复测。 | [RC-07](rc07-preview-session.md) · [#23](https://github.com/hengworkinggit/pivloom/issues/23) | 是 |
| E26 工作台响应式/键盘 | NOT_RUN | 旧 SHA 桌面/390px 工作台与模型设置 smoke；v4 候选应用390px可用，非冻结版同次主操作/Tab/错误/应用双层验收。 | [生产 UI smoke](rc09-production-ui-smoke.md) · [v4 QA](rc10-calc-v4-qa/report.md) · [#14](https://github.com/hengworkinggit/pivloom/issues/14) | 是 |
| E27 源码存储失败 | NOT_RUN | RC-03/存储单测覆盖对象/事务故障边界；无冻结版 UI 发起修改→Storage失败→旧 current/源码保留→重试链。 | [RC-03 进展](rc03-progress.md) · [#19](https://github.com/hengworkinggit/pivloom/issues/19) | 是（隔离） |
| E28 全局容量/额度 | NOT_RUN | #12 隔离 PostgreSQL 证实容量满 503、回收后接单；未在冻结版 UI 用两个项目与耗额账号核对草稿、无隐藏 Run/模型调用。 | [#12](https://github.com/hengworkinggit/pivloom/issues/12) · [旧交付矩阵](../../docs/test-runs/2026-09-23-delivery-matrix.md) | 是（隔离） |
| E29 澄清/范围外要求 | NOT_RUN | DEV-05 老流程有 Coordinator 澄清/交接；冻结版缺关键字段提问、回复父子 Run、支付/云数据库边界 UI 同链。 | [#6](https://github.com/hengworkinggit/pivloom/issues/6) · [旧交付矩阵](../../docs/test-runs/2026-09-23-delivery-matrix.md) | 是 |
| E30 预算/清理待确认 | NOT_RUN | 本机隔离短 deadline + 终态写/首次 destroy 故障、页面状态分别已测；真实远端首销毁另测，尚非冻结版同一 UI Run 全链。 | [局部报告](rc03-e30-e40-local-fault.md) · [真实沙箱故障](rc03-real-opensandbox-fault.md) · [#19](https://github.com/hengworkinggit/pivloom/issues/19) | 是（隔离） |
| E31 用户模型设置/真实连接 | NOT_RUN | 旧 SHA `4733d3a` 生产只读保存配置/桌面/390px UI，真实连接/视觉能力另有探针；创建、错连更正、更新/删除、B 隔离整套冻结版 UI 未执行。 | [旧生产 UI](rc04-production-e31-4733.md) · [图像/连接](rc04-reviewer-image.md) · [#20](https://github.com/hengworkinggit/pivloom/issues/20) | 是 |
| E32 页面/部署 SHA | NOT_RUN | RC-01 曾在旧提交完整验证产物 manifest/重启/换包；冻结版 `e3f9b4f` 页面复制、两端 version、实际包和重启稳定性未在本索引中有记录。 | [RC-01](rc01-deployment-sha.md) · [#17](https://github.com/hengworkinggit/pivloom/issues/17) | 是 |
| E33 截图进入真实 Reviewer 模型 | NOT_RUN | 旧 SHA 真实 Provider/OpenSandbox 两色 Canvas 图片闭环与后续行为绑定已测；未在 e3f 同产物重新捕图/核对请求。 | [RC-04](rc04-reviewer-image.md) · [RC-05 真模型](rc05-real-reviewer.md) · [#20](https://github.com/hengworkinggit/pivloom/issues/20) | 是 |
| E34 原生按键/batch/Canvas | NOT_RUN | 旧 SHA `bbdb94b` 七键分两短批 7/7、`9255399` 首键后真实取消与后续零键；本地空白/断线等负例有据，尚未在 e3f 完成 Enter/Backspace+计算器输入/失败+取消同套复核。 | [七键](rc05-e34-seven-key-cancel.md) · [远端取消](rc05-real-cancel-925.md) · [#21](https://github.com/hengworkinggit/pivloom/issues/21) | 是 |
| E35 已验收版本回滚 | BLOCKED | #25 旧 SHA `16deb75` 的三版合成 accepted/Check 夹具可从浏览器回滚并重登；真实 A0/A1/A2 三版不存在，无旧业务复验及真实下一版。 | [RC-09 隔离](rc09-isolated-e2e.md) · [#25](https://github.com/hengworkinggit/pivloom/issues/25) | 前置后 |
| E36 回滚失败/并发/重启 | NOT_RUN | #25 隔离 PG/沙箱单测涵盖部分准备失败/锁；同一冻结构建的 UI 竞争、提交响应丢失及真实进程重启窗口未执行。 | [RC-09 隔离](rc09-isolated-e2e.md) · [#25](https://github.com/hengworkinggit/pivloom/issues/25) | 是（隔离） |
| E37 注销后旧 Preview 凭证 | NOT_RUN | RC-07 旧 SHA 隔离 A1/A2/B 和生产 A1/A2 已证 HTML/JS/marker/旧 grant 403、A2 200；冻结版尚未复测完整旧 token/Cookie 与切账号路径。 | [RC-07](rc07-preview-session.md) · [#23](https://github.com/hengworkinggit/pivloom/issues/23) | 是 |
| E38 原始源码 diff/完整集合 | BLOCKED | RC-08 历史完整 diff 与 RC-09 合成 Unicode/移动/回滚文件集合已测；真实 A1/A2 与回滚目标源未形成，缺 e3f 实际远端逐文件核对。 | [RC-08](rc08-version-history.md) · [RC-09](rc09-isolated-e2e.md) · [#24](https://github.com/hengworkinggit/pivloom/issues/24) | 前置后 |
| E39 五组与旧 required 全保留 | BLOCKED | RC-06 隔离计划/聚合负例及旧平铺只读通过；真实 A0 第四轮计划有 5 组 19 项，但旧 SHA 正式 Check 0/5；A1/A2 全旧功能逐轮回归未开始。 | [RC-06](rc06-five-groups.md) · [第四轮 Check](rc11-fourth/rc11-fourth-timeout.md) · [#22](https://github.com/hengworkinggit/pivloom/issues/22) | 前置后 |
| E40 终态落库失败/清理重试 | NOT_RUN | 本机真 PostgreSQL 停机后 cancelled/failed 收口、独立远端首次 destroy 故障分别通过；没有冻结版同一 UI Run 中两故障/远端记录联结。 | [PG 故障](rc03-real-postgres-outage.md) · [远端故障](rc03-real-opensandbox-fault.md) · [#19](https://github.com/hengworkinggit/pivloom/issues/19) | 是（隔离） |
| E41 Pi 原生重试/结束边界 | NOT_RUN | RC-02/RC-03 的 Pi/执行器测试覆盖 retry、abort 与事件屏障局部；未见 e3f 官方 faux 错→成→再错、退避取消和延迟 DB 事件同一审计。 | [RC-02](rc02-lifecycle.md) · [#18](https://github.com/hengworkinggit/pivloom/issues/18) · [#19](https://github.com/hengworkinggit/pivloom/issues/19) | 是（隔离） |
| E42 小游戏反馈负例/有效增量 | BLOCKED | RC-05 旧 SHA 受控空白/菜单/断线/假分数/无碰撞被真 Provider 判 failed；#27 真实蛇尚无 accepted 5/5 基线，完整玩法及同游戏有效增量未执行。 | [受控负例](rc05-real-reviewer.md) · [第四轮](rc11-fourth/rc11-fourth-timeout.md) · [#27](https://github.com/hengworkinggit/pivloom/issues/27) | 前置后 |

本草稿只索引 E01–E42；[#28](https://github.com/hengworkinggit/pivloom/issues/28) 还要求 I01–I21、D01–D05 与有条件的 I22 单独逐项建证。完整最终复核不能靠此表替代真实按钮、模型、浏览器、数据库、沙箱和清理检查；任一必需项保持 FAIL/BLOCKED/NOT_RUN，RC-12 就继续开放。
