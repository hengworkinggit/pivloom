# 发布与回滚

这些脚本用于已经准备好 Supabase、OpenSandbox、systemd 和宿主 Caddy 的单实例服务器。它们从当前 checkout 的构建结果打包，不依赖被忽略的开发脚本，不改动 Caddy、环境文件、数据库或原站点。当前公网入口和基础设施准备顺序见 [部署说明](../../docs/deployment-readiness.md)、[API 服务](../api/README.md)、[Supabase](../supabase/README.md)及[沙箱](../sandbox/README.md)。

## 构建

在仓库根目录使用 Node.js 24+、npm、Python 3.11+、SSH 和 curl。发布前从目标提交的干净 checkout 安装依赖并完成对应验收；不要将其他人的未提交修改带入发布。

```bash
npm ci
npm run typecheck
npm run lint
npm test
```

Web 的公开来源与 CSP 在构建时确定。通过受限的本机配置提供 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`，然后构建；只有 publishable key 可以进入浏览器。以下均是公开地址，不含服务管理密钥：

```bash
export NEXT_PUBLIC_APP_MODE=api
export NEXT_PUBLIC_SUPABASE_URL=https://pivloom-69-5-7-187.sslip.io
export PREVIEW_BASE_URL=https://preview-pivloom-69-5-7-187.sslip.io
export API_INTERNAL_ORIGIN=http://127.0.0.1:18010
export SUPABASE_INTERNAL_ORIGIN=http://127.0.0.1:54321
test -n "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
python3 infra/release/build.py

release="$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
python3 infra/release/package.py api "$release"
python3 infra/release/package.py web "$release"
```

`build.py` 只接受干净提交，先删除旧构建目录，再用同一提交构建 API 和 Web，并把提交 SHA 与构建时间写入各自的产物。通常 Next 的 `BUILD_ID` 等于该 SHA；若显式设置 `PIVLOOM_DEPLOYMENT_ID`，以 Next 的 deployment ID 优先规则为准，产物同时记录实际 `BUILD_ID`。`package.py` 核对工作树、产物提交与 Web `BUILD_ID` 后才打包。产物默认放在被忽略的 `.cache/releases/`，压缩包附 SHA-256 记录；打包器拒绝 `.env` / `.env.*` 及越出打包目录的链接。Web 包包含 standalone server、static 和 public 资源。

## 主机准备与迁移

- API 使用 [`infra/api/pivloom-api.service`](../api/pivloom-api.service)，Web 使用 [`pivloom-web.service`](pivloom-web.service)。先创建各自的系统账号、`/var/lib/pivloom-api` 和 `/var/lib/pivloom-web`，按账号赋权，再安装 unit。Web standalone 运行在 `127.0.0.1:18012`；API 和预览分别运行在 `127.0.0.1:18010/18011`。
- 私有环境文件保持在 `/etc/pivloom/api.env` 和 `/etc/pivloom/web.env`，由主机维护者设置权限。API 的 `APP_ORIGIN` 与 `PREVIEW_BASE_URL` 必须与 Web 构建来源一致；保留现有 `MODEL_CREDENTIALS_ENCRYPTION_KEY`，不能在发布时重新生成。用户 provider key 存在加密的数据库记录中，不写入这两个环境文件。
- 可用 `DAILY_RUN_LIMIT_OVERRIDES='{"<owner UUID>":100}'` 仅提高指定测试账号的日额度；每个 key 必须是 UUID，额度是 1–1000 的整数。当前两个测试账号为 100，其余账号仍用默认 20。不要改成全体用户无限额度，也不要把测试账号密码写入发布记录。
- 迁移使用独立的维护配置及管理员凭据；运行时 API 环境不放迁移管理员 URL。按目标环境 ID 执行现有工具，例如 `node --env-file=/path/to/private-maintenance.env --import tsx apps/api/scripts/supabase/manage.ts migrate --environment-id <配置中的环境ID>`。同一工具支持 `seed` / `verify`；其账号 manifest 仅保存到被忽略的 `.cache/identity`。主机上另外准备仅 root 可读的维护文件（例如 `/etc/pivloom/maintenance.env`，权限 0600），保存已有的 `MIGRATION_DATABASE_URL`，供发布时跨 owner 查询空闲状态；不使用受 RLS 限制的运行时连接冒充全局检查。不要重置已有数据库或删除持久卷。
- 生产启动项始终是编译后的 `apps/api/dist/server.js`。`NODE_ENV=production` 拒绝 `TEST_PROFILE` 与程序注入；独立故障启动器 `apps/api/scripts/testing/repair-server.mjs` 仅连接独立的 `_e2e_test_` 数据库，不打入发布包，也不替换公网 unit。
- 复用已有宿主 Caddy：原站点仍代理 3000，Pivloom 命名站点代理 Web 18012，预览按 Host 代理 18011 并保留请求 Host。逐版本预览证书的按需签发通过 API 的 `/api/v1/preview/tls-check?domain=` 限制为已保存版本。修改代理前备份，执行 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 后才 reload；失败恢复备份，不覆盖原站点。发布脚本本身不会修改这些路由。

## 发布

以下变量只包含主机、路径和公开 URL，不含登录密码。SSH 使用已配置的 key 或已有连接；脚本不存储 SSH 密码。

```bash
export PIVLOOM_SSH_TARGET=root@69.5.7.187
export PIVLOOM_PUBLIC_URL=https://pivloom-69-5-7-187.sslip.io
export PIVLOOM_EXISTING_SITE=https://beats-steps-69-5-7-187.sslip.io
# 此主机的 Node/npm 安装路径；其他主机可按实际路径覆盖。
export PIVLOOM_REMOTE_NODE=/usr/local/bin/node
export PIVLOOM_REMOTE_NPM_CLI=/opt/pivloom/tooling/npm/bin/npm-cli.js
export PIVLOOM_REMOTE_MAINTENANCE_ENV=/etc/pivloom/maintenance.env
# 保留数包含当前和切换前一版，范围 2–20；默认 4。
export PIVLOOM_RELEASE_KEEP=4
# 达到此已用百分比即拒绝新安装，范围 1–99；默认 85。
export PIVLOOM_DISK_MAX_PERCENT=85
# 可选：export PIVLOOM_SSH_CONTROL_PATH=/path/to/existing-ssh-control-socket

bash infra/release/deploy.sh api "$release" ".cache/releases/api-$release.tar.gz"
bash infra/release/deploy.sh web "$release" ".cache/releases/web-$release.tar.gz"
```

在维护窗口执行，不同时接受新生成任务。脚本先在本地验证保留数和磁盘阈值，再以 SSH 参数显式传到远端，不依赖 SSH 转发环境变量。上传前先检查远端磁盘水位；达到阈值或无法读取水位时，不创建 incoming、不上传压缩包、不切换服务。上传后在解包、API 依赖安装/复制前再次检查水位。

脚本上传并核验压缩包摘要；API 在 Linux 上安装生产依赖，或在所有 workspace manifests 与 lockfile 完全相同时复制前一版依赖，不复用 macOS 的 `node_modules`。切换前检查活动 Run、待确认清理和保留沙箱；任一不为零即退出，等待正常结束或预览过期后再发布，不自动终止用户任务。

确认空闲后只切换该组件的 `*-current` 链接并重启相应服务，核验本地 readiness、公网登录页、同源 API 和原站点。任何切换后的失败会尝试恢复前一版并重新检查；没有前一版则停止失败服务。

验证成功后自动限制该组件的已识别 release 目录总数：始终保留当前目标和切换前一版，其余名额按目录时间从新到旧补齐。回滚到很老的目录时，回滚目标和回滚前版本仍受保护，二者都计入保留数。仅含匹配组件和完整提交 SHA 的版本 manifest 的直属目录参与清理；符号链接、文件和没有合法 manifest 的人工目录不删除，日志报告跳过数。失败部署不执行这次保留清理。回滚不上传、解包或安装依赖，因此不会因水位阈值而被禁止，但仍执行原有空闲和可用性检查。

日志逐阶段记录已用百分比、阈值与可用 KiB，并输出 `releaseRetention` JSON（保留数量、保护目录、删除目录、跳过数）。远端需要 Python 3 执行目录识别和清理；本地 `deploy.sh` 与同目录 `release-maintenance.sh` 一起使用，后者通过 SSH 标准输入传输，无须预装远端副本。

默认发布根目录是 `/opt/pivloom`，可通过 `PIVLOOM_REMOTE_ROOT` 覆盖，但 systemd 的 WorkingDirectory 也需同步。Node 默认是 `/usr/local/bin/node`；未指定 `PIVLOOM_REMOTE_NPM_CLI` 时调用主机 PATH 中的 npm。

## 回滚与验收

```bash
# 使用脚本输出的已存在上一版目录名；仍执行相同的空闲检查。
bash infra/release/deploy.sh api <previous-api-release> --rollback
bash infra/release/deploy.sh web <previous-web-release> --rollback

bash infra/release/verify-public.sh \
  pivloom-69-5-7-187.sslip.io \
  preview-pivloom-69-5-7-187.sslip.io \
  <已保存的revision-UUID>
```

回滚只切换应用，不逆向执行数据库迁移；发布前需确认迁移兼容上一版。公网探针只证明 HTTPS、路由、readiness、证书授权边界和原站点可用。403/404/410 的预览响应可证明 TLS 路由，但不能证明候选应用可用；登录、认证 SSE、两轮修改、真实修复、预览业务操作、源码一致性及 A/B 隔离仍必须按 [E2E](../../docs/E2E.md) 用真实身份和 Codex 内置浏览器验收，分别记录 PASS / FAIL / BLOCKED / NOT_RUN。

## CI 与人工发布门槛

本机可先运行无生产副作用的脚本回归：

```bash
python3 -m unittest infra/release/test_deploy.py infra/release/test_package.py
```

部署测试实际执行 `deploy.sh`，使用临时目录、隔离 SSH/df/systemctl/curl 等命令，验证高水位在写入前拒绝、远端配置传递、当前/前一版保护、回滚和健康检查失败。它不连接远端主机，也不表示生产部署已经通过。

[GitHub Actions CI](../../.github/workflows/ci.yml) 在 main push、PR 和手动触发时运行两个 job：Node.js 24 下的 `npm ci`、契约构建/typecheck、lint、单元测试及完整构建；以及 PostgreSQL 17.6 service 上的构建修复与重启恢复集成测试。后者创建两个独立的 `pivloom_*_test_ci` 数据库，执行全部实际迁移，测试自身生成随机加密 key；只提供最小 `auth.users` 外键 fixture，不冒充 Supabase Auth 联调。

CI 不使用用户/provider/SSH 密钥，不连接线上数据库，不自动部署。恢复套件的外部沙箱 HTTP 响应及修复套件的持久化输入明确使用 fixture；绿色 CI 不替代真实模型、真实沙箱及 Codex 内置浏览器验收。最终发布需同时具备该提交的 CI 成功记录和对应真实 E2E 记录。
