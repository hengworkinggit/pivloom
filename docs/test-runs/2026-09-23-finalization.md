# #13 / #14 收尾验收

状态：实施与验收中；未关闭 #13 / #14。基线 `ef590fa`，本次记录涉及其后的工作区修改。既有 #8–#12 保持关闭，本次仅补修复链路及上线回归发现的问题。

## 环境与范围

- 公网工作台：`https://pivloom-69-5-7-187.sslip.io`；既有原站 `https://beats-steps-69-5-7-187.sslip.io` 保留。免费 HTTPS 入口已存在，不再把购买或提供品牌域名列为前置。
- 故障 UI 环境：`http://localhost:45231`，通过 SSH 访问回环 18013 的独立测试 API 与回环 18014 的预览服务。数据库为 `pivloom_e2e_test_20260923`；公共 Demo 数据库不注入故障。
- 数据库回归各有独立库：`pivloom_recovery_test_20260923`、`pivloom_repair_test_20260923`、`pivloom_executor_test_20260923`，不共享活动任务或全局生成槽。
- Supabase Auth / 私有 Storage 及 OpenSandbox 使用已授权主机服务；测试项目 UUID 隔离。模型、Provider 凭据与生产配置不打印到记录中。
- 用户已授权两个现有测试账号日额度提高至 100；配置通过 `DAILY_RUN_LIMIT_OVERRIDES` 按 owner 覆盖，其他账号保持默认 20。部署后的实际生效尚待验证。

## 已确认的缺陷与修复

1. 实际服务恢复函数读取 `run_id` 等字段，而迁移返回 `o_run_id` 等字段，跳过了真实销毁和解锁。已修映射；真实独立 PG + SDK、外部 OpenSandbox HTTP fixture 的公共 service 回归先 RED 后 GREEN，2/2 通过（57.17 秒），包括销毁失败保持 pending、后续确认后释放、重复扫描幂等。测试后 runs/projects/sandboxes/leases 均为 0。这不冒充 OS 进程强杀 E2E。
2. Builder 的实际模型请求没有包含持久化 handoff.failedChecks。已补失败行为及编译诊断；实际 Pi 请求回归先 RED 后 GREEN。
3. 新增隔离测试启动器的 Builder 产物边界：夹具在真实 Builder 结束后、可信编译/快照之前替换产物。产品 server 不加载夹具；生产启动拒绝 TEST_PROFILE 和程序化测试 adapter。Candidate 及启动边界共 19 项通过。
4. 构建失败进入修复、全部角色共享工具预算、当前版本源码种子及恢复失败清理：正在完成 executor / repository 整链回归，尚不计 PASS。

## 待完成真实用例

| 用例 | 状态 | 注入与实际执行边界 |
|---|---|---|
| E16 构建失败后修复 | NOT_RUN | 首版 Builder 产物附加确定的 TS 语法错误；编译、后续 Builder、Reviewer、浏览器均真实 |
| E22 坏筛选发现并修复 | NOT_RUN | 首版产物换成可编译但筛选不生效的读书页；Reviewer 与后续修复均真实 |
| E23 两轮修复上限 | NOT_RUN | 每轮 Builder 产物保留同一坏筛选；真实 Reviewer 操作，核对 attempt 0/1/2 与旧 current |
| #14 公网上线回归 | NOT_RUN | 复用既有公网正常路径证据，补当前修复影响的流程、活动 A 两轮修改及最终构建 |

E22 已由内置浏览器创建空项目 `8cb51c00-92a9-4e29-88b5-4e5dd52f32d7`，尚未发起模型任务。首次创建遭遇 SSH 代理连接重置；读取数据库确认没有创建后，经页面重试成功，没有重复项目。故障 manifest 绑定明确 owner/project、scenario、有效期和已应用 attempt；不通过用户 prompt 开启故障。

数据库断言经本地 SSH 往返明显缓慢，曾触发测试 runner 超时；这些不记为业务 PASS 或业务失败。后续将同样测试放到数据库所在主机执行，模型/沙箱协议 fixture 与真实模型 E2E 分开计数。

## 最终实测增补

- E22 专用筛选故障 PASS：Run `69655fa3-9673-44b5-9deb-8537be929905`，attempt0 Check failed，真实Builder修复后attempt1 Check passed（4/4），current=`923d04b3-37e6-408e-b5c5-d1643a5e41e8`。独立IAB确认已读1条、未读1条、全部2条。首版Builder产物由明确夹具替换，修复/检查/浏览器真实。
- E23 PASS：Run `a60eaecf-4302-4850-903b-f17f61acbaf6`，三次真实检查均failed，attempt仅0/1/2，终态needs_changes，无第三轮。原current不变；IAB恢复过期的原成功预览后筛选仍正常，未通过候选另列。界面已实测显示两轮上限提示。
- E16 PASS：Run `dc23760b-28a8-473b-b1e7-564d15723b52`，首版注入TS语法错误，真实编译失败；attempt1真实Builder修复、构建和Reviewer通过，current=`a3c38ec7-cccb-4ec8-80ec-9116d2fe4097`。独立IAB点击计数器验证0→1→2。
- 首次完整书单故障 Run `66c86596-cd48-4e0b-8342-f3c2e4a95026` 保留为FAIL：独立操作确认修复有效，但第二轮Reviewer耗尽400k预算，未promote。没有提高预算或把这个失败记为通过；专用故障场景与正常书单生成的验证分开。
- 实际Postgres集成：build-repair4项、recovery-service2项、executor5项、restore-cleanup2项通过。外部模型/沙箱传输fixture已在测试中标注，不代替上述真实模型E2E。
- API全回归256通过、49显式opt-in跳过；Web全回归74通过。后续preview精确撤销7/7、E23文案10/10专项通过；typecheck/lint、独立contracts/API/Web production build通过。
- 公网API已部署 `dev13-20260923-final`，013迁移已应用；两个测试owner配置100，其余20。Web新增上限提示的发布执行中，以最终服务检查为准。
- #14保持未完成：本次公网IAB反复在getTab/DOM/click/screenshot调用超时；本地IAB可用并完成上述修复验收。公网HTTP 23项只读补证（源码/截图/SSE/隔离/持久化）不冒充UI验收。需求A两轮追加修改尚未执行，不能以已有书单多轮结果替代。CI配置已入库，实际Actions结果待push后核对。
