# RC-12 最终证据覆盖草稿（待 #27 与最终健康补齐）

基准：生产 Web/API 成对提交 `2e6f917449a7c2b80d3a2897c9dd27d1acec3bc3`，构建时间 `2026-09-24T11:15:48.326149Z`，由主任务已核对两个公网 `/version`。本稿只整合已有模块验收，不再次生成应用、注入故障或占用沙箱；#27 的正式产品 Check 仍待其独立任务给出原始终态，最终部署健康由主任务补。它覆盖 [E/I/D 契约](../../docs/E2E.md)的每个 ID，但**不把过去某个 SHA 的模块证据伪装为本 SHA 新执行**。

记号：**P**＝当前真实作品/生产操作已覆盖本轮采用的简化范围；**R**＝可复用的已执行模块测试或明确标注的隔离 fixture，未在最终 SHA 重跑全用例；**Q**＝已有部分观察，但原契约仍缺子步骤；**W**＝等待 #27、最终部署或另一代理本轮取证；**F**＝既成未达成。只有 P 可写作本轮对应范围通过；R 需要引用既有原件和代码影响判断，Q/W/F 均不得写为完整 PASS。用户允许复用未变模块的有效证据，故不为每个 R 重做一次 UI 运行。

核心原件：[真实计算器三版与 5/5](rc10-three-version/report.md)、[A2 完整文件差异及 390px](rc10-a2-v8-qa/report.md)、[v7→v6→v7 实际回滚](rc09-live-roundtrip/report.md)、[A/B/新会话及私有 Preview](rc12-account-matrix/rc12-account-matrix.md)、[三角色停止与 Pi 边界](rc02-lifecycle.md)、[模型失败/重启/SSE/清理](rc03-progress.md)、[真实 PostgreSQL/沙箱故障](rc03-real-postgres-outage.md)、[Canvas 图像正反例](rc05-real-reviewer.md)、[五组/历史版本模块](rc06-five-groups.md)、[旧源码与差异](rc08-version-history.md)。历史 [E 草稿](rc12-evidence-e-draft.md)、[I/D 草稿](rc12-evidence-i-d-draft.md)停留在 `e3f9b4f`、#25/#26 未完成时，不能直接沿用其结论。

## E01–E42

| ID | 状态 | 本轮证据边界 / 仍需什么 |
| --- | --- | --- |
| E01 | R | 独立 A 登录、项目列表和重登已在 [账号矩阵](rc12-account-matrix/rc12-account-matrix.md)实测；最终 v8 的新会话由主任务 E11 补。 |
| E02 | R | 错账号/过期身份的 Auth 与旧 UI 模块证据；未重新制造最终 SHA 的过期会话。 |
| E03 | Q | 空项目、输入边界有旧交付模块记录；没有本轮中文 IME 确认、超长输入与无多余 Run 的同一 UI 原件。 |
| E04 | P | v5 真实模型生成计算器，v6 同源码候选重建复检后 accepted；真实/复检边界和 5/5 在[三版报告](rc10-three-version/report.md)。 |
| E05 | P | v6 产品 12/12，独立浏览器实际操作优先级、括号、小数、退格、错误恢复、键盘。 |
| E06 | P | 已验收版本工作台预览/新标签、marker 与 sourceHash、窄屏切换和刷新；临时沙箱过期另按设计处理。 |
| E07 | P | v6/v7/v8 全七文件经认证 API 下载并逐文件比较；最终成对部署上的[全新 A 会话](rc12-final-session/report.md)打开 v8 代码页、重进页面、读取 src/App.tsx，七文件和只读版本标识保持一致。 |
| E08 | P | A1 同项目 v6→v7 真实 modify，历史创建、重用、刷新、清空和旧功能 Check 17/17。 |
| E09 | P | A2 同项目 v7→v8 真实 modify，仅 CSS 改动；390px 深色/橙键/等宽结果、历史与旧功能 Check 21/21。 |
| E10 | R | 旧[交付矩阵](../../docs/test-runs/2026-09-23-delivery-matrix.md)有活动 Run 刷新同 ID；本版 A1/A2 未特意中途重刷。 |
| E11 | P | [账号矩阵](rc12-account-matrix/rc12-account-matrix.md)已证独立 A、重登、B 隔离和私有 Preview；最终同 SHA 的[全新 A 会话](rc12-final-session/report.md)已核对 v8 项目、增量/回滚对话、七文件源码、历史版本与重建后的 Preview，并实际计算 2+3=5。 |
| E12 | W | 真实 Canvas 贪吃蛇与独立玩法有 #27 原件，正式产品 Check 尚未给出完成终态。 |
| E13 | R | [RC-02](rc02-lifecycle.md)实际 UI 停 Coordinator/Builder/Reviewer，模型等待由受控 fixture，另有真实 Provider abort。 |
| E14 | R | RC-02 在真实 OpenSandbox 停长命令及子进程，保留旧 current/Preview。 |
| E15 | R | [RC-03 真实 Provider 关联重试](rc03-e15-925-real-provider.md)首轮受控401、次轮真模型5/5；A0 本轮还证同源码关联复检。 |
| E16 | R | 旧[交付矩阵](../../docs/test-runs/2026-09-23-delivery-matrix.md)的首产物 TS 故障 fixture→真实修复；不冒充初版真实模型自然错误。 |
| E17 | P | 最终 v8 临时预览已过期；[正常点击“重新启动预览”](rc12-final-session/report.md)后相同 v8 地址加载，实际按钮计算与历史可用，没有提交模型生成。 |
| E18 | R | [固定 SHA 隔离 API SIGKILL](rc03-e18-4733-acceptance.md)中断落库、旧 current/源码留存、沙箱404、关联新 Run。 |
| E19 | Q | 项目级互斥/额度真实 PG 和历史 UI 有证；最终两个标签并发发送/草稿保留的完整屏幕链未复跑。 |
| E20 | R | [RC-03](rc03-progress.md)真实浏览器定点断 SSE 后恢复同 Run，31 个唯一事件；只重用连接模块证据。 |
| E21 | P | A0/A1/A2 的真实 Pi Coordinator→Builder→Reviewer role、源码/Check/current 可逐 Run 关联。 |
| E22 | R | 旧版受控行为缺陷首产物→真实 Reviewer 发现/Builder 修复，见[交付矩阵](../../docs/test-runs/2026-09-23-delivery-matrix.md)。 |
| E23 | R | 旧持久故障 fixture 的 attempt0/1/2、needs_changes 与旧 current 保留已验。 |
| E24 | Q | 浏览器受阻/错误绑定的隔离负例有据；最终产品中“预览不可达→blocked→恢复→拒旧报告”的整条 UI 未重跑。 |
| E25 | R | [生产 A/B/匿名矩阵](rc12-account-matrix/rc12-account-matrix.md)覆盖项目、版本、源码、Check、Run 和 live Preview 403/200；最终 v8 专属读数归 E11。 |
| E26 | P | A2 独立真实 390×844 浏览器测 20 按钮、scrollWidth=390，旧工作台桌面/窄屏 smoke 可复用。 |
| E27 | R | 源码 Storage 上传/事务失败的隔离 PG/Storage 测试有据；不在生产注入。 |
| E28 | R | 生产 A1 曾获 `SERVICE_BUSY` 且未产生 Run，释放精确临时沙箱后接受；额度/容量边界的隔离 PG 测试复用。 |
| E29 | Q | Coordinator 澄清/范围外说明旧模块已有；本版未用无业务公式 Prompt 走完整 UI 父子 Run。 |
| E30 | R | [短截止/清理](rc03-e30-e40-local-fault.md)加[真远端首次销毁失败](rc03-real-opensandbox-fault.md)的 pending→confirmed/404。 |
| E31 | Q | [生产 BYOK UI/真实连接](rc04-production-e31-4733.md)已核对模型、掩码/390px；A/B 全 CRUD、轮换和错连更正没有同轮完整 UI 原件。 |
| E32 | P | [RC-01 来源机制](rc01-deployment-sha.md)已有；最终双 `/version`、[工作台实际徽标和干净构建产物记录](rc12-final-session/report.md)均为 `2e6f9174…`。复制行为沿用未变组件测试，不把这次屏幕读取说成新执行复制测试。 |
| E33 | R | [真实图像探针](rc04-reviewer-image.md)和[Canvas 正反例](rc05-real-reviewer.md)证明 PNG 入成功模型请求；#27 自然生成蛇另列。 |
| E34 | R | [远端七键](rc05-e34-seven-key-cancel.md)、[首键取消](rc05-real-cancel-925.md)与本轮计算器键盘输入；不是全套最终 SHA 重跑。 |
| E35 | P（简化范围） | 真实 UI v7→v6→v7：current、七文件 manifest、Preview marker、对话、零模型调用一致；A2 确从恢复的 v7 base/plan 修改。原契约“第三版→第一版”未做，按用户后续简化授权记录。 |
| E36 | R | [RC-09 隔离真实 PG](rc09-isolated-e2e.md)及同构 CI 覆盖准备失败、幂等、CAS、取消、boot claim/竞争；生产不故障注入。 |
| E37 | R | [账号矩阵](rc12-account-matrix/rc12-account-matrix.md)实测 A1 退出旧 Preview403、A2仍200、B/匿名403。 |
| E38 | P（简化范围） | v6/v7/v8 七文件完整路径/逐文件 SHA 与真实修改 diff，往返回滚 manifest/marker 一致；远端工作区逐文件重列由 I18 隔离测试覆盖。 |
| E39 | P | 真实逐轮五组 12/17/21 个 required 全通过，A2 App.tsx 字节未变；删旧 ID/改义/漏项隔离负例见[RC-06](rc06-five-groups.md)。 |
| E40 | R | [真实 PostgreSQL 断线](rc03-real-postgres-outage.md)的 failed/cancelled 终态与[真实远端首次销毁失败](rc03-real-opensandbox-fault.md)分场景验证。 |
| E41 | R | [RC-02](rc02-lifecycle.md)的 Pi faux 连错→成功→再错、退避取消/settled 与 RC-03 真 Provider 401/终态事件；未在最终线上重注入。 |
| E42 | W | [Canvas 受控正反例](rc05-real-reviewer.md)已有；真实蛇正式基线 Check 和动作后复测取 #27 终态。游戏额外两轮增量在契约中为“可补”，不是计算器两轮替代。 |

## I01–I22（I22 为条件项）

| ID | 状态 | 复用证据 / 边界 |
| --- | --- | --- |
| I01 | R | 幂等/项目互斥真实 PG、A1 容量拒绝后唯一 Run、回滚同键/CAS；多种交错组合以隔离测试为准。 |
| I02 | R | [RC-02](rc02-lifecycle.md)真实远端取消、迟到创建与[清理失败](rc03-real-opensandbox-fault.md)。 |
| I03 | R | 停止与完成竞争在隔离 PG/角色状态机测试，非生产强杀。 |
| I04 | R | [SSE 原始事件](rc03-e15-e20.json)与 events 集成测试，重连未多 Run。 |
| I05 | R | Storage/DB snapshot 失败、路径/对象边界测试；真实三版七文件下载补结果。 |
| I06 | P | 真模型 Reviewer 三版精确绑定 + [版本错配负例](rc05-binding-audit.json)和隔离 PG 拒 promote。 |
| I07 | R | [API 强杀](rc03-e18-4733-acceptance.md)与 recovery-service CI；旧版不透明重放被阻止。 |
| I08 | R | [Pi 三角色](rc02-lifecycle.md)、[五组/旧项](rc06-five-groups.md)和真实 12/17/21 项，角色预算/澄清负例复用。 |
| I09 | R | [A/B 生产 404 矩阵](rc12-account-matrix/rc12-account-matrix.md)及路径越界单测；取消/重试负例无需在生产B重做。 |
| I10 | R | [真实远端按键/取消](rc05-real-cancel-925.md)与 browser adapter 来源/ref/命令参数测试。 |
| I11 | W | [RC-01](rc01-deployment-sha.md)和旧部署模块已验；最终 `2e6f9174…` 生产健康/资源/SSE/隔离由主任务补。 |
| I12 | Q | BYOK 加密/冻结/网络边界测试及[旧生产 UI](rc04-production-e31-4733.md)；完整 A/B 配置 CRUD 实测未齐。 |
| I13 | R | [真 Provider PNG](rc04-reviewer-image.md)及[Canvas正反例](rc05-real-reviewer.md)。 |
| I14 | R | [A1旧grant403/A2新grant200](rc12-account-matrix/rc12-account-matrix.md)，与公开发布分域。 |
| I15 | P（简化范围） | [同构 PG 回滚/幂等/CAS](rc09-isolated-e2e.md) + [生产两版本往返](rc09-live-roundtrip/report.md)；不宣称线上注入提交响应丢失。 |
| I16 | P | [最终干净构建的 API/Web 包摘要](rc12-final-session/release-summary.json)、公网版本和[工作台徽标](rc12-final-session/fresh-a-v8-preview.png)一致，代码 SHA `2e6f9174…`。 |
| I17 | R | [真实 PG 失败终态](rc03-real-postgres-outage.md)、事件 drain 与首次远端销毁失败。 |
| I18 | P（简化范围） | [Unicode/新增/删除/残留隔离测试](rc09-isolated-e2e.md) + 真实三版七文件 hash/diff + 往返 marker。 |
| I19 | R | [Pi retry/abort/settled](rc02-lifecycle.md)与真 Provider 错误/成功边界，版本仍固定0.86.1。 |
| I20 | R | Pi 原生 read/write/edit/bash 和单份 schema 测试；真实 Builder 12次模型/18工具完成 v8。 |
| I21 | R | 官方 compaction/旧观察回读测试 + v8 真 Reviewer16次模型、21 required 全 passed；是否实际触发压缩须以 trace 为准。 |
| I22 | N/A | Pi 三包锁定0.86.1，未显式升级到0.87.x。 |

## D01–D05

| ID | 状态 | 实际情况 |
| --- | --- | --- |
| D01 | W | HTTPS 工作台与测试账号/公开仓库可用，最终成对 SHA 已读；等主任务最后健康、评审入口与作品可达性复核。 |
| D02 | R | README、本地启动/迁移说明及干净 CI 构建测试已有；最终代码 SHA `2e6f9174…` 的 [CI](https://github.com/hengworkinggit/pivloom/actions/runs/35992009113)与[干净构建包摘要](rc12-final-session/release-summary.json)已通过；不称 CI 绿等于完整本地生成。 |
| D03 | P | README 与另建的同标题交付文档说明当前功能、两层持久化、临时预览/主动永久发布和蛇待验收边界；无凭据写入仓库。 |
| D04 | P（待归档） | 仓库公开；主任务已 fresh 查新交付文档任何人可读/外部开放/可评论，并有两张实图。测试账号只在交付文档，不在仓库。实际对外发送另列 D05。 |
| D05 | F（历史时限） | 用户要求的 2026-09-24 17:30 CST“全部真实完成”未达成，不能倒填 PASS；后来用户允许先交文档、继续慢慢验证 #27。最终实际完成/发送时间和适用范围由主任务如实填写。 |

## 关闭判断与最小余项

**实质运行阻塞仍是 #27 自然生成蛇的正式产品 Check，以及主任务最后同 SHA 健康/产物复核。** E11 最终 v8 的新浏览器五类数据是一个小而有价值的只读补证，主任务已在执行；不需重生成计算器。D05 的旧期限失败属于无法事后修复的事实，交付记录须注明。原版 #28 逐字阅读时，E03/E07/E17/E19/E24/E29/E31 和 I12 等仍有上述 `Q` 子步骤；它们是**未执行证据**，并非观察到当前产品故障。若仍要求原契约所有行严格 PASS，就不能把这些 Q/R 改写成 PASS 或关闭 #28；若按用户后续简化授权以现有模块证据验收，则在最终报告中明确采纳范围、链接原件及剩余限制，避免制造 68 次重复运行。

最后冻结 SHA、真实蛇结果、E11 最终 v8 补证、最终健康与 D05 真实时间由主任务追加；本草稿没有执行这些动作或替其判断结果。
