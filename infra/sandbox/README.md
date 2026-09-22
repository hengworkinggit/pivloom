# OpenSandbox G0 工作镜像

本目录从 2026-09-22 真实验证环境收回构建上下文，包含 Dockerfile 和镜像内的实际 npm lockfile。没有平台密钥、主机地址或模型凭据。

**已运行并通过 G0 的镜像**是 `pivloom-g0:20260922`，本地 image ID 为 `sha256:6209e7d0901b95a0150e884afb8bef734c88e4017a544cc7b391ac3e8b4792c0`。本目录 Dockerfile 把原来的 `npm init + npm install --save-exact` 改为复制实际 package/lock 后执行 `npm ci`；**这个归档后的 Dockerfile 尚未重新构建验证**，不能声称产生过相同 digest。

## 构建与校验

从仓库根目录，在目标 Linux/Docker 主机执行：

```sh
docker build --tag pivloom-g0:checkout-v1 infra/sandbox
docker run --rm --entrypoint sh pivloom-g0:checkout-v1 -c 'node --version && chromium --version && agent-browser --version'
docker image inspect --format '{{.Id}}' pivloom-g0:checkout-v1
```

已验证版本：Node 24.13.0、Chromium 153.0.8010.52、agent-browser 0.38.1、React 19.2.4、Vite 8.3.0、TypeScript 5.9.3。Node 和 agent-browser 顶级版本固定，React 构建依赖使用导出的 lockfile。Debian apt 源及 agent-browser 的全局安装传递依赖尚未完整归档；重建后应记录真实版本和 image ID，再执行 G0，不能只因 tag 相同沿用旧成绩。

这个镜像只准备 `/workspace/package.json`、`package-lock.json`、`node_modules` 和工具。每次创建沙箱后，仓库中的 [`initializeReactWorkspace`](../../apps/api/src/runtime/generation.ts) 写入空 React 模板；[`template.ts`](../../apps/api/src/runtime/template.ts) 中的 `SOURCE_IO_SCRIPT`、`STATIC_PREVIEW_SCRIPT` 分别安装到该沙箱的 `/opt/pivloom`，无需服务器上的额外源码文件，也不依赖 Python。生成代码使用普通 UID，服务端源码守卫和静态服务文件由受控入口安装。

## 控制面版本与启动

已验证的 OpenSandbox 服务端提交为 `15426df5d146d6ce7499a16bd1ed871e7242fe27`；TypeScript SDK 为 1.1.0；execd 镜像为 `opensandbox/execd:v1.1.0`。服务需要 Docker、Python 环境及 SQLite 文件；本方案不需要外部数据库或 Redis，也不需要 `/dev/kvm`。

以下命令用于**新环境**准备，不应覆盖正在工作的控制面：

```sh
git clone --filter=blob:none --no-checkout https://github.com/opensandbox-group/OpenSandbox.git opensandbox-source
git -C opensandbox-source checkout 15426df5d146d6ce7499a16bd1ed871e7242fe27
python3 -m venv .cache/opensandbox-venv
.cache/opensandbox-venv/bin/python -m pip install ./opensandbox-source/server
python3 infra/sandbox/prepare_config.py --directory .cache/opensandbox-state
.cache/opensandbox-venv/bin/opensandbox-server --config .cache/opensandbox-state/config.toml
```

`prepare_config.py` 生成新的随机管理 Key，配置与 Key 文件权限为 0600，并拒绝覆盖已有配置。管理端点及沙箱发布端口仅绑定回环。模板不允许宿主目录挂载；G0 的 SDK 创建请求也不传挂载或模型凭据环境变量。

启动前需安装并注册 gVisor：已验证的是 `release-20260914.0`，`runsc` 的 Docker runtime 参数为 `--platform=systrap`。已部署主机注册了名为 `pivloom-g0-runsc` 的独立 runtime，没有改 Docker 默认 runtime。新环境将下面片段**合并**到已有 daemon 配置，并将 path 指向实际安装的该版本 `runsc`；不要用此片段覆盖整份配置：

```json
{"runtimes":{"pivloom-g0-runsc":{"path":"/usr/local/lib/pivloom-g0-gvisor/runsc","runtimeArgs":["--platform=systrap"]}}}
```

以 `runsc --version`、`docker info --format '{{json .Runtimes}}'` 核对安装；共享主机如需重新加载 Docker，由维护者安排，不属于 G0 测试脚本的自动操作。

应用只需要配置 `OPENSANDBOX_BASE_URL`、`OPENSANDBOX_API_KEY`、`OPENSANDBOX_IMAGE`。本地跨主机开发使用 SSH 隧道，SDK 开启 `useServerProxy=true`，浏览器只访问独立回环预览代理。使用方式见 [G0 维护入口](../../docs/g0-maintenance.md)。
