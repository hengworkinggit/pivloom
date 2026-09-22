# 轻量沙箱与本地 Agent 隔离方案

更新：2026-09-22。状态：OpenSandbox Docker + gVisor systrap已在用户服务器通过基础设施实测并选定。结果见[沙箱G0报告](sandbox-g0-results.md)。完整Pi/Supabase联调与联合容量仍为后续开发门槛。

## 当前选择

采用 **OpenSandbox Docker + gVisor systrap + 精简 Node/Chrome 镜像**。Pi 保留在可信 API 中，通过 WorkspacePort 调用隔离环境；模型密钥不进入生成应用。AIO Sandbox保留为其他集成路线，E2B云保留为未来外部算力选择，当前无需申请或购买。已选定并验证沙箱子系统，不等于整套产品已通过生产验收。

| 路线 | 可复用内容 | 本项目仍需承担 | 当前判断 |
|---|---|---|---|
| [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) Docker | 文件、命令、生命周期、限额、TTL、端点与 TypeScript SDK | 预览代理、owner/版本绑定、Chrome工具、清理确认 | 已通过本机基础设施实测，采用gVisor运行时 |
| [AIO Sandbox](https://github.com/agent-infra/sandbox) | 一个镜像含浏览器/CDP/VNC、Shell、文件、编辑器、MCP | 按任务创建容器、配额/回收、预览与凭据边界 | 接入快，但完整镜像并不保证低内存 |
| Docker Engine 直接适配 | 基础容器、进程、文件复制、资源控制 | 自己维护生命周期API、错误恢复、端点和TTL | 依赖少，开发责任更多 |

2026-09-22 GitHub API快照：OpenSandbox 15,449 stars，AIO 5,977，gVisor 19,383；三者均Apache-2.0。星数只作活跃度参考，不等于兼容性或容量验证。

OpenSandbox Docker模式的最小部署不要求KVM、Kubernetes、外置Postgres或Redis；服务端记录默认SQLite。Redis属于可选分布式功能。基础能力见[服务端架构](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.1.0/docs/architecture/control-plane/server.md)、[TypeScript SDK](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.1.0/sdks/sandbox/javascript/README.md)。

## 为什么 Pi、DSH、Codex 本地看起来更轻

| 项目 | 已核对的本地执行方式 | 对我们的启示 |
|---|---|---|
| Pi | 默认工具读写本机文件并调用Bash；容器和沙箱适配由集成方/扩展承担 | Pi不强制E2B，也无需换Agent框架才能用Docker |
| DeepSeek Harness | Linux bwrap→Landlock；macOS Seatbelt；Windows受限token/ACL。策略主要描述文件效果，不是完整多租户运行平台 | 可借鉴进程权限边界；完整独立环境仍需容器/远程执行 |
| Codex CLI | 当前Linux使用bubblewrap、user/PID/net命名空间及seccomp；filesystem受限策略不再沿用旧Landlock选项 | 同样无需KVM；本地CLI沙箱不会自动补齐在线预览和租户生命周期 |

来源：[Pi](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/README.md)、[DSH](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sandbox/sandbox-local/README.md)、[DSH策略范围](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/docs/subsystems/sandbox.md)、[Codex Linux](https://github.com/openai/codex/blob/e4dba902abb7775b747b03f1e9056ec6cdad403a/codex-rs/linux-sandbox/README.md)。

## 主机与版本限制

已检查服务器：2vCPU、3917MiB总内存、当时约2270MiB可用、25GiB磁盘空余；旧站点在线。无/dev/kvm，CPU未暴露vmx/svm。因此不能单靠调低E2B内存启动Firecracker。该事实不排除未来供应商开放嵌套虚拟化。

gVisor的systrap不依赖硬件虚拟化，官方推荐用于VM或无虚拟化支持的主机；它是用户态内核隔离，不等同Firecracker硬件微虚拟机。[平台说明](https://gvisor.dev/docs/architecture_guide/platforms/)

OpenSandbox有版本差异：release-1.1.0桥接端口默认发布到0.0.0.0；后续main新增docker.publish_host。G0锁定含该配置的提交15426df5d146d6ce7499a16bd1ed871e7242fe27，使用回环端口，不把main文档误套旧release。Docker预览端点可能含/proxy/4173，且不支持Kubernetes的secureAccess签名路由；必须验证静态资源路径和独立origin，不能直接替换E2B URL。

## G0实测范围与剩余门槛

以下沙箱子项已经执行，逐项成绩与版本见[报告](sandbox-g0-results.md)；第6项中的Supabase共存容量尚未执行。

1. 锁定并记录服务端提交、镜像digest、SDK、Node、Chrome和浏览器CLI版本。
2. SDK创建、文件读写/精确编辑、真实安装与React构建、失败退出码。
3. Chrome通过观察→填写→点击→观察验证页面，独立开发浏览器验证预览入口/iframe。
4. 长命令及子进程取消、创建中取消、TTL、销毁后端点失效，核对无遗留容器。
5. 两个任务隔离、管理端口私有、预览不给平台Key；gVisor兼容性单独记录。
6. 采样CPU/内存/磁盘与旧站点响应；单沙箱通过不等于Supabase加多个预览共存已通过，完整容量须联合实测。

探针fixture只用于确定沙箱与浏览器兼容性；真实Pi生成、Auth/Storage、正式UI E2E分别记录，不能互相代替。
