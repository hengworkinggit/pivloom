# 沙箱 G0 实测结果

日期：2026-09-22。结论：**选用 OpenSandbox Docker + gVisor systrap 作为本轮沙箱后端，Pi 保留；E2B 不再是开发前置。**

这次通过的是沙箱基础设施子探针。测试应用是明确标注的 React fixture，未使用模型生成；完整 Pi 工具接入、Supabase Auth/Storage 联调和两者共存容量仍是 G0 后续门槛，#2 保持打开。仓库API草稿仍有旧E2B类型、依赖及环境占位，正式适配在DEV-01继续完成；本次没有把配置文档修改冒充为代码迁移。

## 实测环境与版本

- 用户授权服务器：Ubuntu24.04、2vCPU、3917MiB内存，无/dev/kvm，无vmx/svm；保留原Caddy和Next站点。
- OpenSandbox服务端提交：15426df5d146d6ce7499a16bd1ed871e7242fe27；TypeScript SDK @alibaba-group/opensandbox 1.1.0。
- gVisor：release-20260914.0，显式systrap；Docker注册独立runtime pivloom-g0-runsc，默认runtime未更改。
- Node24.13.0、Chromium153.0.8010.52、agent-browser0.38.1、React19.2.4、Vite8.3.0、TypeScript5.9.3。
- 工作镜像pivloom-g0:20260922：sha256:6209e7d0901b95a0150e884afb8bef734c88e4017a544cc7b391ac3e8b4792c0；Docker报告镜像大小588,672,597字节。安装缓存、构建层、gVisor和源码占用另计。
- Execd镜像：opensandbox/execd:v1.1.0，digest sha256:6cf7dba2f21f0b536e100563d841ac58a9f31c2b0a081b7ac76796a24d6f47e2。

## 结果

| 检查 | 普通Docker | Docker + gVisor |
|---|---|---|
| SDK创建沙箱，缓存镜像就绪 | PASS，1.182秒 | PASS，1.697秒 |
| 文件写入、读回、修改 | PASS | PASS |
| TypeScript检查 + React/Vite构建 | PASS，3.393秒 | PASS，4.293秒 |
| 沙箱内真实npm ci后再次构建 | 未单独复测 | PASS，npm输出安装用时11秒；构建通过 |
| 非零退出码 | PASS，准确返回7 | PASS，准确返回7 |
| Chrome观察、填表、提交、勾选 | PASS | PASS；含390×844截图 |
| Codex内置浏览器独立操作 | PASS，添加/完成/刷新 | PASS，跨origin iframe内添加/完成/筛选/刷新 |
| 长命令及其子进程取消 | PASS，running=false且子进程stopped | PASS，running=false且子进程stopped |
| 沙箱销毁 | PASS | PASS |
| 创建途中取消 | — | PASS，已分配资源在create完成前取消并销毁 |
| 两个沙箱文件隔离 | — | PASS |
| TTL自动销毁 | — | PASS，60秒TTL，创建返回后约59.7秒观察到销毁 |

最终docker ps -a为空；两次预览的映射端口与临时预览代理端口均返回连接拒绝。管理端口只绑定127.0.0.1，生成容器无特权模式、无宿主挂载、无Docker socket、无平台或模型密钥。这里验证了具体边界，没有把一次smoke描述为完整安全审计。

## 资源口径

两个主沙箱均限制1CPU/1GiB、pids512。961个约每秒采样点中，普通Docker的cgroup内存峰值为764.88MiB，gVisor为746.40MiB；该口径包含cgroup计费的文件缓存，不能当作纯进程RSS。

宿主MemAvailable最低1442.3MiB，swap使用始终为0。193次旧站点HTTP探测无错误，最大响应耗时52.2毫秒。数据量有限，两个峰值的小差别不能证明gVisor更省内存或给出生产并发上限。

Supabase尚未运行于本次环境；不能据此宣称整套产品加多个预览已能稳定塞入4GB。下一步先部署裁剪Supabase并进行联合容量测试，再继续依赖该环境的正式模块。

## 验证中发现的适配点

1. 此服务端沙箱TTL最小60秒；最初45/20秒的探针参数被拒绝，修正后才执行到期测试。
2. Docker端口分配区间至少100个端口。采用19000–19199并全部绑定127.0.0.1；“有200个候选端口”不代表对公网开放200个端口。
3. gVisor运行时新写入文件不能依赖docker cp读取；截图通过OpenSandbox files.readBytes成功导出。正式源码快照和工件统一走文件API。
4. Docker预览地址包含/proxy/4173，需要受控反向代理正确映射根路径及/assets。实际验证了代理后的跨origin iframe。
5. Codex内置浏览器对本次127.0.0.1导航返回ERR_BLOCKED_BY_CLIENT；localhost入口正常。未关闭浏览器安全保护。独立验收实际使用localhost:45244与localhost:45243，fixture外框文字中的旧端口标注不参与来源判定。
6. gVisor与OpenSandbox自带network_policy/egress组合另有上游限制。本次未启用该组合；公开多租户前的网络策略须独立验证，不能把文件隔离等同网络隔离。

## 已保留的基础设施

内部服务由pivloom-sandbox-g0.service管理，监听127.0.0.1:18080；服务凭据由代理生成并存于服务器权限受限文件，不出现在仓库或本文。服务启动后约103MiB内存；改由系统服务启动后，SDK创建、执行与销毁smoke通过；未携带管理Key的请求返回401，健康接口200，测试结束无遗留容器。原站点配置未改。临时测试容器均已清理。

## 原始记录

- [汇总数据](../artifacts/g0-sandbox-2026-09-22/summary.json)
- [普通Docker记录](../artifacts/g0-sandbox-2026-09-22/report-runc.json)
- [gVisor记录](../artifacts/g0-sandbox-2026-09-22/report-gvisor.json)
- [生命周期记录](../artifacts/g0-sandbox-2026-09-22/lifecycle.json)
- [gVisor浏览器操作](../artifacts/g0-sandbox-2026-09-22/browser-gvisor.jsonl)
- [390px截图](../artifacts/g0-sandbox-2026-09-22/g0-gvisor-390.png)
- [清理核对](../artifacts/g0-sandbox-2026-09-22/cleanup.json)
- [系统服务smoke](../artifacts/g0-sandbox-2026-09-22/managed-service.json)
- [实际探针源码与使用边界](../artifacts/g0-sandbox-2026-09-22/probe-sources/README.md)

本报告不将fixture成绩计入正式产品E01–E31，也不关闭未完成的开发issue。
