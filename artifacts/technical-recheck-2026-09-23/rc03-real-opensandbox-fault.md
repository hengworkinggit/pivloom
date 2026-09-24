# RC-03 · 真实 OpenSandbox 首次销毁失败与近期恢复

关联 [#19](https://github.com/hengworkinggit/pivloom/issues/19)。执行于 2026-09-24（Asia/Shanghai），工作树基线 `1a5a1be`，本机 Web/API 使用同一源码但不是正式发布产物，页面显示 SHA“未核实”。只使用新建的本机 PostgreSQL `pivloom_executor_test_rc03_real`、独立测试 owner/项目；远端通过现有 `127.0.0.1:45320` 隧道连接**真实 OpenSandbox**。生产 A 账号、已有项目与发布站点未访问或修改。测试开始前另一验收沙箱已获官方销毁确认和独立 404，SDK 只读清单为 0 条活跃沙箱。

## 故障与实际结果

本次测试 Run 为 `9f81dc13-ca6f-41dc-abdc-13b526895106`，新建真实沙箱 `bab0f914-d472-43b4-b06a-a42fbbc41b98`。Coordinator 通过 Pi 接受固定五组计划；Builder 到达真实沙箱初始化后的模型边界才发起取消。Provider 响应是受控 fixture，实际发出 2 次模型请求；**没有调用真实 Provider**。

隔离反向代理仅针对该 sandbox ID 的 DELETE 返回 503，其它 sandbox 的 DELETE 一律拒绝。终态 repository 边界第一次 `finishCancelled` 人为抛错，第二次在真实 PostgreSQL 完成事务。此时数据库为 `cancelled / cleanup_pending / CANCELLED`，项目 `operation_id` 仍指向本 Run；官方 SDK 从管理器读取该沙箱仍 Running。销毁请求被拒 8 次、终态事务尝试 2 次；向同一项目重试得到 `PROJECT_BUSY`。独立 Chromium 的 [待回收页面](rc03-real-os-pending.png)显示“远端资源回收尚未确认”“正在清理执行资源”，发送按钮禁用；点击重试提示项目仍有执行或清理操作。

解除此唯一 sandbox ID 的 503 后，执行器配置为每 100 ms 扫描待回收资源；本轮在下一次 5 秒观察内自行收口，代理仅向真实管理器转发 1 次 DELETE。数据库成为 `cancelled / confirmed / CANCELLED`，沙箱记录 `destroyed`，项目锁为 NULL；Provider 调用数仍为 **2→2**。脚本所用管理器确认不存在后，**另起全新 SDK 管理器**再次 `getSandboxInfo` 得 HTTP 404，活跃沙箱清单为 0。脱敏 [原始状态、最终数据库记录与独立远端查询](rc03-real-os-fault.json)可逐项核对。

重新打开页面后，[确认回收页面](rc03-real-os-confirmed.png)显示“资源清理已确认”“准备好你的下一个想法”。点击“以新任务重试”创建 Run `47e28001-b8a6-4e9e-9b81-2ab7eb4e0759`，数据库 `retry_of` 指向原 Run。新 Run 因预先限定的 Provider 401 fixture 很快失败，**没有创建第二条沙箱**；它只证明重试入口、关联和解锁，不证明真实模型成功生成。

## 判定与边界

- 真实 OpenSandbox 的创建、限域销毁失败、pending 期间远端仍活、近期自动销毁、独立 404 与项目解锁：**PASS**。
- 短 deadline：先前[隔离 PostgreSQL/远端 fixture 测试](rc03-e30-e40-local-fault.md)已通过；本次真实沙箱使用用户取消触发同一清理路径，不把取消写成真实 deadline 演练。
- 本条真实沙箱 Run 的第一次终态写入由 repository 边界夹具阻断，第二次为真实 PostgreSQL 事务；它本身不是数据库服务断线。同轮另有[真实本机 PostgreSQL 断线两终态测试](rc03-real-postgres-outage.md)通过，但与本条远端场景分开执行，页面亦未在那两个精确 Run 的故障过程中打开。
- E15 的真实 Provider 成功重试、E18 统一部署 SHA 的最终 UI、完整 E30 同一浏览器发起短 deadline 均未在本轮执行；#19 保持开放。

证据取完后关闭独立浏览器、本机 Web/API，确认该真实沙箱 404/活跃数 0；本机测试数据库进程停止。没有部署、推送或关闭 Issue。
