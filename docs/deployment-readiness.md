# 部署主机检查记录

> 最新执行状态：基础联合验证与 #2/#3/#4/#5/#15 已完成，正式工作台已接入真实候选生成；#6 协调者模块仍在验收。API 已与 Supabase、OpenSandbox 共置于服务器，前端继续本地开发；公网完整产品尚未发布。详见[联合验收](foundation-validation-2026-09-22.md)与 [DEV-05](planning-validation-2026-09-22.md)。

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

## 对本项目的落实

该主机作为单实例 Demo 的部署目标，实际内存与并发余量仍需上线前测量。Pivloom 使用独立目录、服务名、网络和未占用端口，不能抢占现有 3000 端口或覆盖现有应用。

主机已有 Caddy，所以默认复用现有宿主 Caddy，为 Pivloom 增加独立域名站点并代理到独立 web/api 回环端口；不额外启动争抢 80/443 的第二个 Caddy。实施时先读取现有路由并备份，再 validate/reload，保留原站点可用。公网域名和 DNS 尚待配置，仅为上线前置；本地开发/E2E使用localhost或SSH隧道，不因域名未提供而阻塞。

数据库、身份与对象存储改为由代理部署自托管 Supabase，先裁剪未使用组件，再验证与既有服务共存。服务URL/Key由部署生成，不再要求用户开通Supabase云项目；不增加MinIO。

沙箱采用已实测OpenSandbox Docker + gVisor systrap，无需KVM或E2B账号。E2B Embed可裁剪内存配置，但仍依赖本机未暴露的硬件虚拟化，故本轮不采用；推荐12GiB不是硬性最低值。方案比较见[轻量沙箱评估](sandbox-options.md)，E2B依据见[Embed](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md)。

后续部署前仍需完成真实 API、容器构建/部署文件与健康检查、自托管服务配置、模型/沙箱连接验证、迁移、测试身份和公网 E2E。本机现有 Mock 前端不能被描述为完整真实产品上线。
