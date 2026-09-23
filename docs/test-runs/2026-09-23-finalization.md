# #13 / #14 收尾验收

状态更新：2026-09-23 13:08（Asia/Shanghai）。#13 已关闭；#14 的公网 A 初次、两轮修改及 B 初次真实链路已通过，最终工程验收见文末。早期失败记录按时间保留，不冒充成功。最终 API 提交 `03b6da8`、[CI 35820485171](https://github.com/hengworkinggit/pivloom/actions/runs/35820485171) 为 SUCCESS；公网 API `dev14-20260923-mobile-review`，Web `dev13-20260923-final`。

## 环境与范围

- 公网工作台：`https://pivloom-69-5-7-187.sslip.io`；既有原站 `https://beats-steps-69-5-7-187.sslip.io` 保留。免费 HTTPS 入口已存在，不再把购买或提供品牌域名列为前置。
- 故障 UI 环境：`http://localhost:45231`，通过 SSH 访问回环 18013 的独立测试 API 与回环 18014 的预览服务。数据库为 `pivloom_e2e_test_20260923`；公共 Demo 数据库不注入故障。
- 数据库回归各有独立库：`pivloom_recovery_test_20260923`、`pivloom_repair_test_20260923`、`pivloom_executor_test_20260923`，不共享活动任务或全局生成槽。
- Supabase Auth / 私有 Storage 及 OpenSandbox 使用已授权主机服务；测试项目 UUID 隔离。模型、Provider 凭据与生产配置不打印到记录中。
- 用户已授权两个现有测试账号日额度提高至 100；配置通过 `DAILY_RUN_LIMIT_OVERRIDES` 按 owner 覆盖，其他账号保持默认 20。公网实际生效已验证：A/B 均为 100，见 [public-quota.json](../../artifacts/dev-13-2026-09-23/public-quota.json)。

## 已确认的缺陷与修复

1. 实际服务恢复函数读取 `run_id` 等字段，而迁移返回 `o_run_id` 等字段，跳过了真实销毁和解锁。已修映射；真实独立 PG + SDK、外部 OpenSandbox HTTP fixture 的公共 service 回归先 RED 后 GREEN，2/2 通过（57.17 秒），包括销毁失败保持 pending、后续确认后释放、重复扫描幂等。测试后 runs/projects/sandboxes/leases 均为 0。这不冒充 OS 进程强杀 E2E。
2. Builder 的实际模型请求没有包含持久化 handoff.failedChecks。已补失败行为及编译诊断；实际 Pi 请求回归先 RED 后 GREEN。
3. 新增隔离测试启动器的 Builder 产物边界：夹具在真实 Builder 结束后、可信编译/快照之前替换产物。产品 server 不加载夹具；生产启动拒绝 TEST_PROFILE 和程序化测试 adapter。Candidate 及启动边界共 19 项通过。
4. 构建失败进入修复、全部角色共享工具预算、当前版本源码种子及恢复失败清理：已完成下述独立 PostgreSQL 整链回归；真实模型与浏览器结果另列。

## 真实用例状态

| 用例 | 状态 | 注入与实际执行边界 |
|---|---|---|
| E16 构建失败后修复 | PASS | 首版 Builder 产物附加确定的 TS 语法错误；编译、后续 Builder、Reviewer、浏览器均真实 |
| E22 坏筛选发现并修复 | PASS | 首版产物换成可编译但筛选不生效的读书页；Reviewer 与后续修复均真实 |
| E23 两轮修复上限 | PASS | 每轮 Builder 产物保留同一坏筛选；真实 Reviewer 操作，核对 attempt 0/1/2 与旧 current |
| #14 公网上线回归 | PARTIAL | 复用既有公网正常路径证据，补当前修复影响的流程、活动 A 两轮修改及最终构建 |

E22 的早期准备记录：由内置浏览器创建项目 `8cb51c00-92a9-4e29-88b5-4e5dd52f32d7`，随后已执行下述真实任务。首次创建遭遇 SSH 代理连接重置；读取数据库确认没有创建后，经页面重试成功，没有重复项目。故障 manifest 绑定明确 owner/project、scenario、有效期和已应用 attempt；不通过用户 prompt 开启故障。

数据库断言经本地 SSH 往返明显缓慢，曾触发测试 runner 超时；这些不记为业务 PASS 或业务失败。后续将同样测试放到数据库所在主机执行，模型/沙箱协议 fixture 与真实模型 E2E 分开计数。

## 最终实测增补

- E22 专用筛选故障 PASS：Run `69655fa3-9673-44b5-9deb-8537be929905`，attempt0 Check failed，真实Builder修复后attempt1 Check passed（4/4），current=`923d04b3-37e6-408e-b5c5-d1643a5e41e8`。独立IAB确认已读1条、未读1条、全部2条。首版Builder产物由明确夹具替换，修复/检查/浏览器真实。
- E23 PASS：Run `a60eaecf-4302-4850-903b-f17f61acbaf6`，三次真实检查均failed，attempt仅0/1/2，终态needs_changes，无第三轮。原current不变；IAB恢复过期的原成功预览后筛选仍正常，未通过候选另列。界面已实测显示两轮上限提示。
- E16 PASS：Run `dc23760b-28a8-473b-b1e7-564d15723b52`，首版注入TS语法错误，真实编译失败；attempt1真实Builder修复、构建和Reviewer通过，current=`a3c38ec7-cccb-4ec8-80ec-9116d2fe4097`。独立IAB点击计数器验证0→1→2。
- 首次完整书单故障 Run `66c86596-cd48-4e0b-8342-f3c2e4a95026` 保留为FAIL：独立操作确认修复有效，但第二轮Reviewer耗尽400k预算，未promote。没有提高预算或把这个失败记为通过；专用故障场景与正常书单生成的验证分开。
- 实际Postgres集成：build-repair4项、recovery-service2项、executor5项、restore-cleanup2项通过。外部模型/沙箱传输fixture已在测试中标注，不代替上述真实模型E2E。
- API全回归256通过、49显式opt-in跳过；Web全回归74通过。后续preview精确撤销7/7、E23文案10/10专项通过；typecheck/lint、独立contracts/API/Web production build通过。
- 公网API已部署 `dev13-20260923-final`，013迁移已应用；两个测试owner配置100，其余20。Web 同一发布也已上线，Build ID `oDfz9vGxMaanEMOJ_k9gr`，包含两轮上限提示，见 [Web 构建记录](../../artifacts/dev-13-2026-09-23/web-build.json)。
- 公网 IAB 早期反复在 getTab/DOM/click/screenshot 调用超时；本地 IAB 完成上述修复验收。用户随后已明确允许使用任意浏览器，公网补验改用开发机独立 agent-browser Chromium；它与沙箱内的产品 Reviewer 是不同浏览器会话。此前 23 项 HTTP 只读补证继续只作为接口证据，不冒充 UI 验收。


## 最新公网结果

- API / Web：`dev13-20260923-final`；免费 sslip.io HTTPS 入口可用，原站点保留。CI：提交 `dbb22ac`、运行 `35813640800` 为 SUCCESS；其中外部 HTTP fixture 与真实 PostgreSQL 的边界仍按测试说明区分，不代表真实模型 E2E。
- 需求 A 第一轮修改：Run `e1e1d3a9-9b5b-4c7b-94ae-cb3084bbf142` 为 completed / attempt 0，current=`5f4319fb-8d2c-48a3-8185-2a635f58e0f6`，Check `cfee86b7-bdb4-4820-8448-4368a2400c1e` 的 5/5 行为通过。持久化证据见 [public-a-mod1-e1e1d3a9.json](../../artifacts/dev-13-2026-09-23/public-a-mod1-e1e1d3a9.json)。
- 独立浏览器实际操作同一版本：新增林舟、田禾两条记录；确认田禾；“已确认”只显示田禾；搜索“林”与“已确认”组合显示 0 条；“全部”与搜索“林”组合只显示林舟；空字段提交出现错误。以上是 root 执行者的实际观测，未编造截图文件。随后已独立复测错误邮箱：填写“邮箱校验”和 `not-an-email` 后提交，显示“邮箱格式不正确”，列表仍只有田禾/林舟，没有新增记录。证据：[错误邮箱 UI](../../artifacts/dev-14-2026-09-23/mod1-invalid-email-ui.txt)。
- 第一轮源码经工作台实际打开两个文件：[App.tsx](../../artifacts/dev-14-2026-09-23/mod1-App-ui.txt)、[style.css](../../artifacts/dev-14-2026-09-23/mod1-css-ui.txt)。第二轮生成中刷新后仍为同一 Run `0ae1ee09-4965-46c9-b9f3-d2f3a4b15b08`，current 仍是第一轮的 v11，林舟/田禾记录保留；未重复提交任务。
- 需求 A 第二轮修改已从 UI 提交：Run `0ae1ee09-4965-46c9-b9f3-d2f3a4b15b08`，本次状态交接为 planning。任务完成、最终 revision/check 和独立 UI 行为均尚待结果，不能由第一轮或书单多轮生成替代。
- 因此 #14 仍开放：收尾主路径是等待这次第二轮，再核对其新增目标、保留原有行为、实际源码与刷新/重开版本一致性。最新完整边界见[交付矩阵](2026-09-23-delivery-matrix.md)。

## 第二轮独立浏览器操作（12:04 增补）

公网 A Run `0ae1ee09-4965-46c9-b9f3-d2f3a4b15b08` 的候选 v12 / `5709d359-1feb-4edc-94a4-a5a29be15d71` 已由真实 Builder 构建，Reviewer 仍在执行。独立 Chromium 的空字段/错误邮箱校验、三条新增、确认、搜索与状态组合、统计3/1不随筛选变化均通过。实际点击“新标签页预览”，390px下 width/clientWidth/scrollWidth均390；刷新保留3条和确认状态。此刻仍不把未完成的 Reviewer 记为通过。

12:00 截止未完成第二轮，本轮没有按时关闭 #14；不重置原期限。

## 第二轮自动检查失败（12:07）

同一 Run 最终为 `failed` / `AGENT_OUTPUT_INVALID`，没有通过 Check，current 仍是 v11 `5f4319fb-8d2c-48a3-8185-2a635f58e0f6`。Reviewer 在一个行为报告上得到 `OBSERVATION_SCOPE` 拒绝后纠正成功；检查下一行为时首次再次提交无效，系统却因整场共享的纠正计数直接终止。候选 v12 `5709d359-1feb-4edc-94a4-a5a29be15d71` 独立 UI 操作与 390px 截图通过，且两份源码与 manifest 哈希一致，但仍是**未被接受的候选**。这次失败不记为正式 PASS，保留 [运行证据](../../artifacts/dev-14-2026-09-23/public-a-mod2-final.json)、[独立 UI 观察](../../artifacts/dev-14-2026-09-23/public-ui.json)与[只读 HTTP 补证](../../artifacts/dev-14-2026-09-23/public-final-readonly.json)。

## 12:40 后的结果与 Token 决策

- 公网修复版 `992b0d2` 修复检查者跨行为误用同一次纠正额度；Reviewer 专项 56/56 通过，完整 CI [35817640654](https://github.com/hengworkinggit/pivloom/actions/runs/35817640654) 成功。第一轮第二次尝试 `ed3e3a7b-d3fc-4403-b22b-91ac6d768978` 在协调者计划格式校验失败。随后 Run `1283e45e-3072-423e-9ed5-69d29692ab43` 产出候选 v13 `11726043-c884-4100-935f-9b7ddad574d5`，独立网页表单、统计、筛选、390px、刷新及两份源码读取通过；但 Reviewer 在累计40万 Token 额度末段停止，Run 为 `TOKEN_BUDGET_EXCEEDED`，v13未被接受。[HTTP 补证](../../artifacts/dev-14-2026-09-23/public-retry-readonly.json) 9项通过仅覆盖源码、SSE、B访问拒绝。
- 再次缩短需求的 Run `d198943f-f025-44d5-98bd-d1756528f605` 产出候选 v14 `2c1290a1-62be-472f-964d-736d21436e2d`，最终为 `CHECK_BLOCKED`，无正式验收通过；不可把候选算作 current。
- 用户明确取消产品累计 Token 限制。提交 `3328441` 将生产默认账本改为无限额度但保留用量记录，显式小额度仅用于测试失败路径。相关 token/wire/reviewer 71项通过，API build 与 lint 通过；30分钟运行截止与80工具调用上限保留。该提交的公网部署需等待最后一个失败候选预览于 12:48:44 到期，发布脚本在仍有沙箱时正确拒绝切换；最终发布状态以实际后续检查为准。
- #14仍保持开放：旧 current 为v11 `5f4319fb-8d2c-48a3-8185-2a635f58e0f6`，A第二轮缺正式 Reviewer Check。此前12:00及随后半小时截止均已错过，不将未通过项冒充完成。

## 最终通过（13:08）

- A 第二轮最终 Run `5c6cd082-a6e1-450d-ae5e-058dc0addb7c` 已 **completed**、attempt 0，current v15=`7f81b655-26bb-46ad-be31-c8510a4919a6`，Check `4a2bb313-59e1-4010-adb7-1159eea7f78b` **passed 5/5**。产品检查者两次真实调用 `browser_resize` 均成功；B07 在390×844实际读取 `scrollWidth=390`，B05确认状态刷新保留、B06搜索与筛选组合及统计口径均由检查者实际操作验证。[持久化运行证据](../../artifacts/dev-14-2026-09-23/public-a-final-pass.json)。
- 独立浏览器在同一 v15 通过：空表单中文校验、非法邮箱拒绝；新增林舟/田禾，确认田禾；已确认筛选仅田禾，搜索林+已确认为空，全部+搜索林仅林舟；统计始终2/1。新标签页实际390px测得 `innerWidth=390`、`scrollWidth=390`，[截图](../../artifacts/dev-14-2026-09-23/final-390.png)；刷新后两条记录与确认状态保持。[App.tsx](../../artifacts/dev-14-2026-09-23/final-App-ui.txt)和[style.css](../../artifacts/dev-14-2026-09-23/final-css-ui.txt)均从工作台代码页读取。
- 最终公网只读补证[9项通过](../../artifacts/dev-14-2026-09-23/public-final-passed-readonly.json)：两份源码与 manifest SHA 一致、认证 SSE 历史及指定 cursor 回放且不缓冲、B 访问 manifest/source/SSE 均404。本次 A/B 会话已精确注销；原站点回归200。源码哈希 `b32262c05a1b5cae13c1abd717509f73a75b88956adbf494d8af7bf62aa44a68`。
- 生产 API 的累计 Token 上限已按用户要求取消并实际发布，远端账本 `limitTokens=null`。Reviewer 视口工具专项80/80、Token/Reviewer相关71/71；完整 CI [35820485171](https://github.com/hengworkinggit/pivloom/actions/runs/35820485171) 成功。用户授权精确销毁的失败候选沙箱已远端确认、持久状态destroyed，成功current未受影响。
- 12:00及随后半小时期限均已错过；这里记录实际完成时间，不倒填达标时间。题面 D04/D05 的公开权限、材料副本和实际对外发送仍属单独交付动作，本仓库记录不冒充这些动作。
