# Foundation 补充验证：身份失效与凭据生命周期

日期：2026-09-22。目标环境：`pivloom-dev-e6d33625ef2b`。变更基线：`5d1ae44c35e7d2c6b52a18178bb68354fbcfff97` 加当前工作区。对应 DEV-02 / GitHub #3、DEV-14 / GitHub #15；本记录不将 #4 的完整生成联动标为通过。

## 凭据删除与版本引用

原实现只软删除模型配置。真实 HTTP DELETE 后查私有数据库，发现两个版本密文仍存在；新增回归先 RED（期望 0，实际 2），修复后 GREEN。

迁移 `003_model_credential_leases.sql` 新建 owner/profile/version 配对的服务端引用表，启用 FORCE RLS。引用记录只有 ID 和版本，不含明文密钥。删除配置立即阻止新任务引用，并只保留仍有活动引用的版本密文；释放最后一个引用后回收该已删除配置的凭据。配置历史元数据保留。

公共服务接口：

- `freezeInTransaction(client, ownerId, profileId, configVersion, referenceId)` 必须在 `database.owned` 内执行，与未来接受 Run 的事务一起提交；返回 `{id, profileId, configVersion, referenceId}`。
- `freezeForRun(ownerId, profileId, configVersion, referenceId)` 提供独立 owner 事务。
- `resolveLease(ownerId, leaseId)` 只在服务端临时返回固定版本的配置、密钥及受保护 fetch。
- `releaseForRun(ownerId, leaseId)` 幂等释放，按活动引用回收已删除配置的密文。

当前验证：

| 检查 | 实际结果 |
|---|---|
| 无引用配置删除 | 所有版本凭据行变为 0；删除后连接测试 404 |
| 版本冻结后轮换、删除 | 旧版本与旧密钥仍可由其 lease 解析；未引用的新版本密文已回收 |
| 删除后新任务引用 | 404，无法接受新引用 |
| 相同任务更换版本 | 409 `MODEL_LEASE_CONFLICT` |
| B 冻结、解析、释放 A 引用 | 全部 404；A 引用不受影响 |
| 接受事务回滚 | 引用行随事务回滚，没有孤儿引用 |
| 多个引用 | 释放一个后另一个仍可解析；最后释放后密文 0 行 |
| 重复释放 | 成功且不恢复引用 |

该生命周期测试为真实 HTTP / Supabase Auth / Postgres 测试；模型能力状态由测试准备步骤置为 verified，密钥为随机 fixture，不调用供应商，不作为真实模型连接证明。真实 Ark 连接与 G0 证据见原 foundation / G0 记录。

## I12 网络边界

5 项隔离网络测试使用真实本地 HTTP fixture，并仅在外部 DNS/连接适配层注入确定输入。生产默认仍为 Node DNS 与 HTTPS，没有测试环境开关，也没有放开 Base URL 验证。

- DNS 首次返回公开 IP，后续返回回环 IP：第一次实际连接参数固定为已验证的公开 IP，TLS servername 与 Host 保留原域名；第二次请求在连接前拒绝。
- 同次 DNS 返回公开和私网 IP：未建立连接。
- 上游实际返回 302 指向私网：拒绝，不发第二个请求。
- 上游保持连接且不返回响应：配置 1 秒超时后中止，fixture socket 关闭。
- Anthropic SDK 的 `/messages?beta=true` 被原样传递，其他 query 仍由安全测试拒绝。

这些是外部网络边界测试，不声称进行了真实 Anthropic 请求或公网 DNS 重绑定攻击。真实 HTTPS 供应商连接证据仍为 Ark。

## E02 服务端撤销真实会话

仅对 manifest 中 B 的已核对身份执行 Supabase `signOut({scope: 'global'})`；不删除账号、不操作 A、不修改浏览器 localStorage。

部署版本为 GoTrue `v2.196.0`。已核对官方 `internal/api/logout.go`、`internal/models/sessions.go` 与 `internal/api/auth.go`：global logout 删除该用户的会话，后续 getUser 拒绝不存在的 session_id。实际复核轮次，B 的 `auth.sessions` 行数从 1 变为 0；旧 JWT 直接请求 `/auth/v1/user` 返回 HTTP 403 / `error_code=session_not_found`。首次 SDK 断言使用 `error.code` 未取得该字段，随后以实际 HTTP 状态与正文错误码确认，未修改应用鉴权实现。

主任务随后在真实浏览器刷新 B：返回 `/login` 且私有内容清空；A 正常重登后仍看到原有两个项目和相同 ID。此证据是“服务端撤销会话导致身份失效”，不是等待 JWT 自然到期。

## 执行结果与复现

- `003` 迁移执行、再次执行校验 hash：PASS。
- `npm run test --workspace @pivloom/api`：35 PASS，4 个显式 opt-in 集成测试 SKIP（不将跳过计作通过）。
- 真实集成单独启用：4/4 PASS，128.78 秒；覆盖身份/项目、直接 schema/RLS、模型 API 与上述 lease 生命周期。
- 网络 fixture 加原安全测试：16/16 PASS。
- API typecheck、lint、build：PASS。
- 精确 manifest cleanup：PASS。清理后 manifest 项目/模型/对象计数均为 0；数据库 fixture 模型 0、A/B 凭据引用 0；A 保留 2 个原有项目，测试账号保留 2 个；唯一默认模型仍为“火山方舟 · GLM 5.3 Flash”。
- 独立检查所有已删除配置：没有活动引用却残留的凭据行数为 0。

真实集成复现（在 `apps/api`，仅已有明确目标环境和私有 manifest 时执行）：

```sh
node --env-file=.env.local --import tsx scripts/supabase/manage.ts migrate --environment-id pivloom-dev-e6d33625ef2b
PIVLOOM_IDENTITY_INTEGRATION=1 node --env-file=.env.local ../../node_modules/vitest/vitest.mjs run tests/identity/cloud-integration.test.ts
node --env-file=.env.local --import tsx scripts/supabase/manage.ts cleanup --environment-id pivloom-dev-e6d33625ef2b
```

fixture 配置显式 `isDefault:false`，不改变 UI 中的实际默认模型。清理只删除 manifest 记录且归属已核验的项目、模型/引用和对象，保留 A/B 测试账号。主任务创建的非 manifest 资源不会清理。

## 边界

#4 仍需把 Run 的接受事务接入 `freezeInTransaction`，在真实任务结束时释放，并验证幂等冲突及运行中修改/默认切换/删除不会改变已接受任务。本次验证的是提供给该流程的数据库契约；没有将真实生成页面联动提前标为完成。
