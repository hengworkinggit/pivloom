# #29 持久排队：本地实现与上线顺序（2026-09-25）

状态：实现与本地真 PostgreSQL 验证完成；**生产迁移与部署尚未执行**。本记录只写已经真实跑过的结果，没有执行的步骤明确标为 `NOT_RUN`。

## 1. 本轮修掉的缺陷

初始的未提交实现（`scheduler.ts` / 迁移 020 / `accept` 改为落库 `queued`）在真库审计中发现五个问题，全部在本轮修复并用测试固定：

| 缺陷 | 后果 | 修复 |
|---|---|---|
| 领取后交接失败会永久占用 | claim 成功、`prepareDispatch` 抛异常且 park 也失败时，Run 停在 `accepted`、项目锁与一个容量名额被占；启动恢复只认别的 boot id，所以该项目要等下次重启才解开 | 新增 `nano.claim_stranded_runs(p_boot, grace)` + `repository.recoverStrandedClaims()`；调度器每轮先回收本 boot 超期未交接的领取，park 为 `needs_input` / `QUEUE_DISPATCH_STALLED` 并释放锁与名额 |
| 预览恢复与回滚绕过容量上限 | 两者建沙箱前不预约容量，容量 1 时能造出第 2、第 3 个活沙箱，而排队任务还在等 | `reserve_generation_capacity` 进入 `beginRestore` 与 `rollbacks.begin`；仓库新增 `reserveCapacity(ownerId)` 作为同一账本的显式入口 |
| 凭证租约泄漏 | 排队取消与 park 两条新出口不释放 accept 时建的 lease，用户删除模型配置后密文无法清理 | 两条出口都调用 `models.releaseInTransaction` |
| 派发不产生事件 | `queued → accepted` 没有事件，流式客户端会一直显示「已排队」直到下一个阶段更新 | `claim_next_queued_run` 在同一事务内写入 `run.accepted`（`dispatched: true`）事件 |
| 队列位次虚高 | 位次用全局 `row_number()`，把被同项目串行阻塞的任务也算进你前面 | 位次只统计真正可派发的先行任务；被阻塞行返回 `NULL`；派发排序与位次使用同一 `(last_dispatched, queued_at, id)` 键 |

另外修掉两处遗留：`accept` 的 23505 映射还在引用 019 已删除的 `one_global_generation` 索引；排队行的 `deadline_at` 曾写成 `now()`，使等待中的任务在 `Run.deadlineAt` 上看起来已经超时。

## 2. 锁顺序

`claim_next_queued_run` 与仓库的 `lockedRun` 现在都是**先项目、后 Run**。此前 claim 先锁 `runs` 再锁 `projects`，用户取消与并发 claim 存在 `40P01` 死锁窗口。

领取函数新增 `p_owner`：调度器传 `NULL`（全系统派发），owner 作用域的调用方必须传自己的 id，因此带 owner 的调用不可能领到别人的任务。

## 3. 本地验证（真 PostgreSQL）

环境：本机一次性 PostgreSQL 集群（`.cache/queue-rig`，端口 55441），从 `001` 到 `020` 全量迁移建立。

| 检查 | 结果 |
|---|---|
| 迁移从空库顺序应用 001→020 | 通过（两次重建均干净） |
| `apps/api/tests/generation/queue.integration.test.ts` | **9/9 通过**（原有 6 例 + 新增 3 例） |
| 新增：派发事件与 `deadline_at` 不早于排队时间 | 通过 |
| 新增：卡死领取被回收、项目锁与名额释放、后续任务可继续 | 通过 |
| 新增：恢复/回滚与排队任务共用同一容量账本，不满额时不超卖 | 通过 |
| `apps/api` typecheck / lint | 通过 |
| `apps/web` typecheck / 测试 | 24 文件 97 例通过 |
| 完整 `npm run build`（API + Next standalone） | 通过 |

`NOT_RUN`：生产迁移、生产部署、浏览器排队验收、真实模型生成。

## 4. 上线顺序（必须按此顺序）

生产库当前**还没有**迁移 020（`nano.runs` 的 state 约束里没有 `queued`，也没有 `claim_next_queued_run`）。新 API 会写入 `queued`，所以顺序不能颠倒：

1. 确认生产空闲：活动 Run、待确认清理、保留沙箱均为 0。
2. 应用迁移：`manage.ts migrate --environment-id pivloom-dev-e6d33625ef2b`（用维护连接；工具按 `schema_migrations` 的 sha256 校验，已执行的迁移不会重跑）。
3. 部署 API（新 unit 指向新链接并重启），核验 `/api/v1/version`。
4. 部署 Web，核验 `/version` 与页面可打开。
5. 核对公网 Web、API 与 GitHub HEAD 三处 SHA 一致。

回滚：迁移 020 只新增列、索引与函数并放宽约束，旧 API 不写 `queued`，因此迁移可先于代码存在；应用回滚只切换 `*-current` 链接，不逆向执行迁移。

## 5. 尚未完成

- 20 多个既有集成测试的助跑需要补 claim 步骤（`accept` 之后不再直接持有项目锁与容量）。改动进行中。
- 预览恢复与回滚目前是**拒绝**（可重试的 `SERVICE_BUSY`）而不是排队后自动开始；需求 6 的「按需休眠空闲预览以推进队列」也尚未实现。这两项按 #29 的完成门槛仍需补齐，或在票内明确记录为未完成。
