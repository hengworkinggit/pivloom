# RC-03 · 终态落库与清理复核（进行中）

关联 [#19](https://github.com/hengworkinggit/pivloom/issues/19)。核心修复提交 `bc6ab97cf4863407f44833e898023f4344ecf186` 的 [CI](https://github.com/hengworkinggit/pivloom/actions/runs/35901661230) 已通过；本轮页面夹具和后续证据尚未全部部署。**#19 保持打开**，下列未执行项不计 PASS。

## 已通过的隔离集成检查

- 真实 PostgreSQL + Pi + 受控 Provider/远端 HTTP：取消终态事务连续三次失败，执行器保留待落库责任，恢复后唯一 `cancelled`；同样注入失败终态事务，最终保留原 `MODEL_FAILED`，Provider 只请求一次，不重放模型或工具。
- 首次沙箱销毁失败时，Run 的 `cleanupState=pending` 与项目锁保留；远端恢复后在 Preview TTL 之前重试，确认销毁后才解锁。恢复 Preview 的失败写库第一次失败后也会重试，不二次构建。
- 重启恢复的真实 PostgreSQL 测试：首次远端清理失败，服务内定时对账在远端恢复后把旧 Run 从 `pending` 收成 `confirmed`。完整 API 单元套件 267 通过、54 跳过；根目录 typecheck、lint 通过。这里的故障远端是 HTTP fixture，不能代替 E30/E40 要求的真实 OpenSandbox 故障注入。

## 页面与运行状态

测试地址为本地 Next 工作台 `http://localhost:45231`，隔离 API、PostgreSQL 与真实 OpenSandbox；仅模型 HTTP 是明确的 fixture。账号 A 的正式项目未改动，所有本轮项目属于 `pivloom_e2e_test_20260923`。这不是正式部署，页面的 Web/API SHA 显示“未核实”。独立浏览器为 agent-browser；Codex 内置浏览器本轮 `getTab` 初始化在 30 秒后超时。

| 用例 | 实际结果 | 判定 |
|---|---|---|
| E15 · 模型错误与重试 | 测试 Provider 返回不可重试 401，首 Run `9eba0baa` 为 `failed/MODEL_FAILED`，页面显示脱敏原因与“以新任务重试”。点击后新 Run `7f9df52b` 精确关联旧 Run，实际 Pi/DB/OpenSandbox 构建与 Reviewer Check `passed`，v1 Preview 点击从 0 到 1。[失败页面](rc03-e15-failure.png) · [成功页面](rc03-e15-retry-success.png) · [交互结果](rc03-e15-preview-clicked.png) · [脱敏 DB 摘要](rc03-e15-e20.json)。 | **PARTIAL**：成功内容仍由模型 fixture 给出，尚未做真实 Provider 的成功重试。 |
| E20 · SSE 断开重连 | 活动的 `7f9df52b` 上由独立浏览器定点 abort 事件请求，UI 显示连接不可用并轮询，解除拦截后自动重新连接并显示同一 Run 的成功结果。数据库事件 31 条、ID 31 个互异，没新增 Run。[浏览器原始请求列表](rc03-e20-network.txt) · [DB 摘要](rc03-e15-e20.json)。 | **PASS**（模型内容为 fixture；真实浏览器/HTTP/SSE/PostgreSQL）。 |
| E18 · API 强制重启 | v1 成功时新修改 Run `7ab4685f` 在 Builder 模型等待态且候选沙箱已登记。强制终止仅隔离 API 后，新进程换 boot ID，旧 Run 变 `interrupted`，候选沙箱 `destroyed`、项目解锁；原 v1/sourceHash 与只读源码保留。[故障前状态](rc03-e18-before.json) · [重启后状态](rc03-e18-after-restart.json) · [中断页面](rc03-e18-interrupted.png) · [旧源码页面](rc03-e18-old-source-preserved.png)。页面新建 retry Run `11b3c2bd`，绑定旧 Run 和 v1；最终 v2 `4a9f8f3c` / Check `passed`，[DB 摘要](rc03-e18-after-retry.json)。 | **PARTIAL**：重启、关联、清理、源码与 DB 成功已实测；并行 #23 前端/API 热更新期间最终 UI 版本不一致，需在统一构建后重开页面补验。重试模型仍为 fixture。 |
| E30/E40 · 截止时间、清理和终态 DB 故障 | 上述取消/失败事务与首次 destroy 的隔离集成用例通过；页面尚未执行短 deadline、真实 OpenSandbox 首次销毁失败及 DB 短时故障场景。 | **NOT_RUN**（完整页面用例）。 |

#23/#24 验收后已清理本轮测试项目。7 条沙箱记录在数据库中均为 `destroyed`；一次 API 强杀留下的旧 v1 Preview 由官方 OpenSandbox kill/get 补回收并确认 404，#23 最后一次恢复沙箱也独立确认远端不存在。随后以精确 owner/project 前缀删除 4 个 Run、2 个 Revision、2 个 Check 和 4 个私有 Storage 对象；下载复核为 404，剩余项目 0。生产 Web/API 尚未部署 `bc6ab97`，旧正式作品未变更。

## 最终补证（2026-09-24）

上表是当时的隔离阶段结果，不能覆盖后来执行的真实补测。E30/E40 已在[短 deadline 与清理页面](rc03-e30-e40-local-fault.md)、[真实 OpenSandbox scoped 首次 destroy 失败→pending→近期 confirmed/独立404](rc03-real-opensandbox-fault.md)及[真实本机 PostgreSQL 断线后 failed/cancelled 终态幂等落库](rc03-real-postgres-outage.md)分别补齐。未重新调用模型来对账，故障范围只限合成 owner/Run/sandbox。

E18 按[原始契约的固定 SHA API SIGKILL 复核](rc03-e18-4733-acceptance.md)判 PASS：旧 accepted v1/7文件源码/current 不变，候选精确回收，浏览器显示中断并允许创建关联新 Run；新 Run 以明确模型 401 夹具结束，不将其写作成功 v2。E20 的断线自动重连与同一 Run 唯一事件仍沿用上表通过的独立浏览器/数据库原始记录。

E15 则另以[同一 9255399 Web/API 构建的真实 Provider 成功重试](rc03-e15-925-real-provider.md)完成：受控首轮 401 恰好一次、无沙箱；页面点击关联重试后，真实 Pi 三角色/真实 OpenSandbox 完成 5/5 组、7/7 子项、8 个 PNG 工件的 passed Check，Preview 实际点击 0→1→2→重置0。旧失败 Run 保留、唯一沙箱精确销毁并由新 SDK 查得404，合成身份/对象按清单清理。两个样本的 SHA、真实/fixture边界分别记录，不混作同一项目。这些补证满足 #19 直接验收；最终跨模块整链仍归 #28。
