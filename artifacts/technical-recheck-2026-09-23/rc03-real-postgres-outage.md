# RC-03 · 真实本机 PostgreSQL 短时断线后的终态收口

关联 [#19](https://github.com/hengworkinggit/pivloom/issues/19)，执行于 2026-09-24（Asia/Shanghai）。这是**本机新建的独立 PostgreSQL 服务** `127.0.0.1:55439/pivloom_executor_test_rc03`，环境标识 `rc03-local-fault-e2e`，全量迁移 001–017；未停止生产 Supabase，也未新建远端 OpenSandbox。测试启用前同时严格校验数据库名称、端口、环境 ID、`pgdata` 路径和 `pg_ctl` 路径。用 `pg_ctl -m fast stop` 实际关闭服务至少 600 ms，随后启动同一服务；这不是仅在 repository 方法里抛一个错误。

新增的两项 opt-in 执行器集成测试分别让 Provider 在首轮返回不可重试 401，以及在 Builder 已开始后取消。Provider SSE、模型响应和沙箱传输是明确的 HTTP/进程 fixture；Pi、执行器、PostgreSQL 事务和服务中断/恢复路径是真实运行。失败终态产生 1 次真实数据库写入失败，恢复后总尝试 2 次并最终 `failed / MODEL_FAILED / cleanup confirmed`；Provider 调用保持 1 次。取消终态产生 2 次真实数据库写入失败，恢复后总尝试 3 次并最终 `cancelled / CANCELLED / cleanup confirmed`；Provider 调用保持 2 次。两者均释放项目锁，未重放模型；取消例的夹具远端已销毁。执行器隔离清理扫描设为 100 ms，取消例在数据库重启后 **123 ms** 收口。完整脱敏计数与 Run ID 见 [原始结果](rc03-real-pg-outage.json)。

定向测试 **2/2 PASS**；本地 PostgreSQL 已恢复到 accepting connections。真实远端销毁/独立 404 和浏览器清理状态分别见[同轮 OpenSandbox 报告](rc03-real-opensandbox-fault.md)。两种故障是分开注入：本例数据库断线未与真实 OpenSandbox 故障同时叠加；页面也未在这两个精确 Run 的断线过程中打开。因此 E40 的后端持久化/不重放子项通过，完整页面 E2E 仍需合并核对，不把分段证据写成一条全链 PASS。
