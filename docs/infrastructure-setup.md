# 正式开发与 E2E 基础设施分工

> 最新执行状态：2026-09-22基础联合验证已通过：真实Pi四工具生成、OpenSandbox/gVisor构建与Chrome、跨来源iframe交互和刷新、Auth/Storage、BYOK页面、单沙箱与Supabase共同负载。正式工作台生成尚待接入，模块完整E2E仍按各票门槛执行。详见[联合验收](foundation-validation-2026-09-22.md)。

更新：2026-09-22。已完成沙箱基础设施实测并部署内部OpenSandbox服务；API/契约/适配器仅部分实现，身份、数据库、Pi联调和正式产品E2E仍未通过。

## 当前决定与待验证项

- **Supabase 改为优先自托管**：开发代理在用户已授权服务器上部署 Postgres、Auth、私有 Storage 及必要依赖，裁掉未使用服务。服务地址、数据库密码和 API Key 由部署过程生成、配置，不要求用户申请 Supabase 云项目。
- **模型改为用户页面配置（BYOK）**：设置中填写 Provider、Base URL、API Key、模型名称，测试、保存、更新和删除；不要求普通用户编辑 .env.local。Pi 的 pi-ai 继续负责模型通信。
- **本地开发与本地 E2E 不依赖域名**：使用 localhost，远程基础设施可通过 SSH 隧道访问；公网 HTTPS/DNS 留到上线阶段。
- **沙箱选定OpenSandbox Docker + gVisor systrap**：授权主机无需KVM即可运行，文件/命令/React构建/Chrome/iframe/取消/TTL/清理已实测通过。内部服务已部署；完整Pi与Supabase联合验收仍待完成。见[实测记录](sandbox-g0-results.md)。

已授权主机为 2 核、约4 GiB内存，已有 Caddy/Next.js，必须保留原服务。完整 Supabase 官方最低资源为2核/4GB，裁剪后与工作台及沙箱的共存容量仍须实测；不能承诺全部放进4GB。详见[主机检查](deployment-readiness.md)。

## 用户输入与代理责任

| 项目 | 用户提供 | 代理负责 |
|---|---|---|
| Supabase | 已有服务器权限已提供 | 部署、生成URL/密钥、迁移、Auth、私有bucket、备份和容量验证 |
| 模型 | 在设置页面提供自己的服务配置；首个方舟配置已提供 | UI、Pi兼容验证、加密存储、owner隔离、配置版本和测试 |
| 沙箱 | 无需申请E2B或购买套餐，服务器权限已提供 | 部署OpenSandbox/gVisor、生成管理配置；完成正式WorkspacePort/BrowserPort适配和联合容量验证 |
| 域名 | 公网部署阶段提供可用入口或DNS权限 | 本地先用localhost/隧道；上线处理HTTPS、代理和原站回归 |

OpenSandbox管理Key是平台基础设施凭据，由部署代理生成和配置；模型 Key 属于各登录用户，通过模型设置页面管理。两种配置不能混作同一个用户流程。

## 模型凭据与配置

正式模型设置要求见 PRD F15、TRD 6.3 和 DEV-14。元数据与加密凭据按 owner 隔离；后端生成并安全保存独立于数据库的加密主密钥。浏览器只回显掩码，密钥不持久化到 localStorage，不进入日志、Run、SSE 或沙箱。服务级主密钥/数据库/OpenSandbox配置可以使用受保护的环境配置或秘密文件，由部署代理维护。

每次Run固定所选profile及配置版本；编辑、默认切换、删除不改变已接受任务的配置。连接测试走真实Pi请求，能力未测即unknown；图片存储能力不等于已经实现附件聊天/多模态输入。

首个模型配置：火山方舟 Coding Plan，Base URL https://ark.cn-beijing.volces.com/api/coding/v3，模型 glm-5.3-flash；密钥不写入文档，兼容协议、流式和工具调用尚待实测。不得自动改用其他计费端点，也不把单个用户的Key设成其他用户共享默认值。

## 部署与测试准备

1. 核对现有服务、容量、端口与Docker状态；隔离目录、网络和持久卷，复用宿主Caddy。自托管采用正式Docker部署配置，不把本地开发CLI栈直接暴露公网。
2. 自动生成服务凭据及实例标识，执行版本化迁移、私有schema/RLS/bucket和owner校验；测试脚本按实例标识与地址核对目标，不能只接受托管supabase.co URL。
3. 幂等创建A/B测试身份，随机密码保存到被忽略的受限本地文件；用户无需手工建表、注册测试账号或造测试数据。
4. 按测试owner/prefix及资源manifest精确清理；全库reset只允许本次创建的可丢弃环境，不对共享或评审数据执行。
5. 正常生成用例从UI真实提交，不通过seed制造成功项目；环境级故障用隔离实例，不因自托管就降低测试门槛。
6. 每模块完成后立即执行对应Codex内置浏览器E2E及集成验证，PASS/FAIL/BLOCKED/NOT_RUN分别记录。

## 对象存储

使用Supabase Storage私有bucket保存源码快照、检查截图和诊断工件，数据库记录归属、引用和哈希。自托管可用持久卷支持的文件存储后端；同时设计备份与恢复。当前不另部署MinIO。用户上传附件、音视频等仍需另行实现产品流程。

## 已部署的沙箱

OpenSandbox内部管理服务监听服务器127.0.0.1:18080，由pivloom-sandbox-g0.service管理；管理Key保存于受限服务器文件。Docker使用独立gVisor systrap runtime，默认runtime未改变。测试容器和临时预览已清理，服务保留供后续适配。当前无需E2B账号或Key。管理端点、文件、命令、构建、浏览器和生命周期结果见[实测记录](sandbox-g0-results.md)。

## 准备完成的判定

必须实际验证迁移、A/B登录、跨owner拒绝、Storage上传/读回/删除、模型工具调用、沙箱启停及Chrome操作；同时测试旧站点共存和资源余量。只写配置或返回HTTP 200不算完成。沙箱替换必须先通过等价WorkspacePort/BrowserPort与真实E2E，不能以“更轻量”省略隔离、取消、版本绑定或持久化。
