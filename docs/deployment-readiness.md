# 部署主机检查记录

> 最新执行状态：基础联合验证与 #2/#3/#4/#5/#6/#15 已完成，正式工作台已接入协调者、澄清与真实候选生成。#6 提交为 `964abd5`，候选尚未经过产品 Reviewer，不晋升 current。API 已与 Supabase、OpenSandbox 共置于服务器，前端继续本地开发；公网完整产品尚未发布。详见[联合验收](foundation-validation-2026-09-22.md)与 [DEV-05](planning-validation-2026-09-22.md)。

日期：2026-09-22。先完成授权SSH只读检查，随后部署并实测OpenSandbox/gVisor。此记录不保存主机密码或私钥。

## 初始只读检查（部署前快照）

| 项目 | 结果 |
|---|---|
| 系统 | Ubuntu 24.04 LTS，x86_64 |
| CPU / 内存 | 2 个逻辑 CPU，约 4 GiB 内存；检查时可用约 2.2 GiB |
| Swap | 约 2 GiB，检查时未使用 |
| 磁盘 | 根分区约 40 GiB，剩余约 25 GiB |
| Docker / Compose | CLI 已安装；Docker systemd 服务 inactive，尚未验证容器可运行 |
| Web 入口 | 现有 Caddy active，监听 80/443；管理入口仅回环地址 |
| 既有应用 | 已有 Next.js 监听 127.0.0.1:3000，另有服务监听回环 4318 |
| Pivloom 目录 | 尚无 /opt/pivloom |
| 虚拟化补查 | 无 /dev/kvm；CPU未暴露vmx/svm；kvm模块未加载，/dev/net/tun存在 |

以上表格是部署前快照。后续已启动Docker并部署内部沙箱服务，最新状态见下一节；未改动原Caddy站点配置。

## 沙箱首次部署后的状态（历史快照）

- Docker服务已运行；原无既有容器。新增独立gVisor systrap runtime，Docker默认runtime不变。
- /opt/pivloom/g0-sandbox保存锁定服务端、配置和镜像；pivloom-sandbox-g0.service active，管理接口只监听127.0.0.1:18080，约103MiB内存。
- 普通Docker与gVisor的文件/命令/React构建/Chrome/预览均通过；gVisor创建中取消、文件隔离、60秒TTL及系统服务创建/执行/销毁通过。临时容器与预览均已清理。
- 单沙箱限制1核/1GiB，gVisor cgroup峰值746.40MiB；旧站点193次探测无错误，swap始终为0；磁盘剩余约21GiB。
- Supabase尚未部署；该结果不证明Supabase与完整工作台/沙箱共同负载能容纳于4GiB。详见[实测记录](sandbox-g0-results.md)。

## 当前内部部署

Supabase DB/Auth/REST/私有 Storage 四个服务已运行并验收。API 使用独立 `pivloom-api.service` 和专用非 root 账号，仅监听回环 18010/18011；本地前端经 SSH 转发访问，部署说明见 [infra/api](../infra/api/README.md)。模型凭据仍由页面管理并加密存储，不放入部署环境变量。TRD 12.1 记录此开发阶段 systemd 例外，最终部署必须保持唯一执行器。

最新 30 分钟联合监测覆盖 API、Supabase、生成沙箱与保留预览：最低可用内存 1347.1 MiB，swap 为 0，原站点 350 次检查无失败。前端尚未迁入，该结果不替代最终公网完整负载验证。最终部署仍需完成 Reviewer、版本迭代、恢复与容量模块，以及真实公网 E2E；不得把内部 API 上线等同于产品交付。

预览隔离修复已部署到 `dev06-04`：每个 Revision 使用独立 origin，保留 `/p/<revisionId>/` 路径并核验 Host、版本与 capability。此前仅使用不同路径的共享来源不能隔离 localStorage，不能继续作为部署方案。

本地 `PREVIEW_BASE_URL=http://localhost:45311` 派生 `http://<revisionId>.localhost:45311`，工作台 localhost 地址保持不变；cookie 为 host-only、HttpOnly、`SameSite=None; Secure`。独立 IAB 夹具已证实 localhost 页面内嵌两个 `.localhost` 来源时，该 cookie 能完成认证。这是当前 IAB 的受信回环验证，真实产品修复回归仍待完成，不作为公网通过记录。

## 对本项目的落实

该主机作为单实例 Demo 的部署目标，实际内存与并发余量仍需上线前测量。Pivloom 使用独立目录、服务名、网络和未占用端口，不能抢占现有 3000 端口或覆盖现有应用。

主机已有 Caddy，所以默认复用现有宿主 Caddy，为 Pivloom 增加独立域名站点并代理到独立 web/api 回环端口；不额外启动争抢 80/443 的第二个 Caddy。实施时先读取现有路由并备份，再 validate/reload，保留原站点可用。公网域名和 DNS 尚待配置，仅为上线前置；本地开发/E2E使用localhost或SSH隧道，不因域名未提供而阻塞。

公网预览另使用 `https://<revisionId>.<configured-preview-host>`，与工作台同 scheme、同 site（实际可注册域）但不同 origin，各 Revision 之间也不同 origin。保持 host-only、HttpOnly、`SameSite=Lax; Secure`，不设置 cookie Domain；同 Revision 恢复保持域名稳定。`PREVIEW_BASE_URL` 必须配置主机名，IPv4/IPv6 字面量不支持。上线前须实际验证子域 DNS、TLS 证书覆盖、Caddy 保留 Host、受限 CSP、iframe cookie 与静态资源，以及两个版本使用同名 localStorage key 时互不串用、各自刷新保留；不能要求用户清空浏览器数据来掩盖来源隔离问题。

数据库、身份与对象存储改为由代理部署自托管 Supabase，先裁剪未使用组件，再验证与既有服务共存。服务URL/Key由部署生成，不再要求用户开通Supabase云项目；不增加MinIO。

沙箱采用已实测OpenSandbox Docker + gVisor systrap，无需KVM或E2B账号。E2B Embed可裁剪内存配置，但仍依赖本机未暴露的硬件虚拟化，故本轮不采用；推荐12GiB不是硬性最低值。方案比较见[轻量沙箱评估](sandbox-options.md)，E2B依据见[Embed](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md)。

真实 API、自托管服务、模型/沙箱连接、迁移与测试身份已完成基础验收。后续仍需完成 Reviewer、版本迭代等产品模块、最终部署配置及公网 E2E；当前本地前端与远端 API 的开发组合不能被描述为完整产品上线。

## 公网部署现状（2026-09-23，dev07-16 / web-20260922-dev07-02）

前端已迁入宿主并与既有站点共存。工作台、API、SSE 与身份同源，预览每版本独立 origin：

| 入口 | 地址 | 回环端口 |
|---|---|---|
| 工作台（含同源 API/SSE/身份路径） | https://pivloom-69-5-7-187.sslip.io | Web 18012 → API 18010 / 身份网关 54321 |
| 预览（每版本一个 hostname） | `https://<revisionId>.preview-pivloom-69-5-7-187.sslip.io` | 预览网关 18011 |
| 原站点（未改动） | https://beats-steps-69-5-7-187.sslip.io | 3000 |

- Caddy 采用「命名站点各自管理证书 + 兜底 `:443` 站点按需签发」；按需签发前向 `GET /api/v1/preview/tls-check?domain=` 询问，只有真实存在的 revision 子域返回 200，其余 403，避免共享后缀被用来消耗证书签发配额。
- 验收结果与逐项证据见 `artifacts/dev-07-2026-09-23/public-acceptance.md`；可复跑的探针为 `.cache/development/verify-public.sh <workbench-host> <preview-host> [revisionId]`。
- 域名切换脚本：`.cache/development/switch-domain.sh <workbench-host> <preview-host>`（备份配置 → 改写来源 → 用新预览源重建前端 → 校验并 reload 代理 → 切换发布 → 自动回归）。
- 仍待落实：正式公网域名与 DNS（工作台主机 + 预览主机，预览需 `<revisionId>.<preview-host>` 泛解析）。当前 sslip.io 派生名已完成全部功能验收，但正式域名切换后需按本文前述条目复验 DNS、TLS 覆盖、Caddy 保留 Host、CSP、iframe cookie 与跨版本 localStorage 隔离。
