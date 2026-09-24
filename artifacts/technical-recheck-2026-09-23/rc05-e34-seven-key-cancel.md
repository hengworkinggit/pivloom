# RC-05 / E34 · 七键顺序与取消边界

关联 [#21](https://github.com/hengworkinggit/pivloom/issues/21)，承接[真实 Provider 正反例](rc05-real-reviewer.md)。本次用独立源码提交 `bbdb94b0399aa3b184c96fac171d06991f629ddc` 运行产品 `RemoteBrowser` 与 OpenSandbox `agent-browser 0.38.1`，没有修改生产服务。复核结束时公开 Web/API `/version` 仍为 `4733d3a2c860418f6c71a95535c800887d055be2`，因此七键结果是**隔离源码+真实沙箱验证**，不是已部署同 SHA E2E。

**正常键盘路径 PASS。** 使用同一浏览器 Session 的两个原生短 batch：第一批 ArrowUp、ArrowRight、ArrowDown、ArrowLeft、Space；从其新观察 ID 继续第二批 Enter、Backspace。7/7 每步 `success=true`，页面 `keydown`、`keyup` 事件各 7 次，顺序与请求完全一致；最终 HUD 为 `MODE:normal STATUS:PAUSED TRAIL:START>ArrowUp>ArrowRight>ArrowDown>ArrowLeft>Space>Enter>Backspace`。[前图](rc05-key-cancel/normal-before.png)和[后图](rc05-key-cancel/normal-after.png) SHA 不同；Console `messages=[]`、pageerror `[]`。原始批次开始/结束时间、事件、Session、SourceHash 和截图哈希见[完整七键结果](rc05-key-cancel/result-normal-cancel-eventread-failed.json)。`press` 的真实表现为每键一次 down/up，**未验证任意持续持键**。

补测揭示两项验收门槛，而不是把失败包装成通过：

1. 旧源码 `4733d3a` 的产品按键枚举漏了 `Backspace`，七键 batch 在 I/O 前被 `INVALID_BROWSER_ACTION` 拒绝；见[旧版复现](rc05-key-cancel/result-backspace-rejected.json)。`bbdb94b` 已补齐枚举与持久化 evidence schema；上述七键实测证实按键可用。
2. 六键放进单批曾越过 `RemoteBrowser` 15 秒动作上限，得到 `BROWSER_TIMEOUT`；见[超时记录](rc05-key-cancel/result-six-key-timeout.json)。按产品契约拆为 5+2 两个短 batch 后全部成功，不能把一次超时当作按键不支持。

**取消路径 NOT_RUN。** 目标是首个 ArrowUp 已到页面后取消四步长 batch，并证明 Right/Down/Left 未执行、浏览器关闭。第一次并发从沙箱内读取事件日志时，额外命令失败，未能建立首键门控；它的七键部分仍有效，取消部分无判定。随后尝试 OpenSandbox `endpoint(4173)` 的只读外部事件通道：初版夹具错误地用绝对 `/events` 覆盖代理路径，404，[错误拼接记录](rc05-key-cancel/result-endpoint-path-404.json)不计产品故障。修成保留 `/v1/sandboxes/{id}/proxy/4173` 前缀的相对路径并本地断言后，代理 GET 返回 502，长 batch 尚未启动；见[最后一次定点尝试](rc05-key-cancel/result.json)。没有可靠的首键观测，就不能声称“取消后续动作未执行”。不继续换框架或多开沙箱凑结果。

本次所有临时 OpenSandbox 均 `destroy.confirmed=true`，并用全新 SDK client 的 `connect/getInfo` 独立确认 HTTP 404；最后只读核对生产 `active_or_unclean=0`、`retained_sandboxes=0`。无生产项目、Run、数据库或 Storage 写入，未调用模型。[复现脚本](../../apps/api/tests/fixtures/canvas-negative/remote-key-cancel-probe.mts)仅含受控 Canvas、按键与只读事件通道，不含凭据。

所以 #21 目前有七键正常路径、已部署版本的四向/Space 与远端空白 Canvas 真 Provider `failed`，以及本地 menu/断线/假计分/碰撞失效真 Provider `failed`；但**中途取消防止后续动作**和其他负例在已部署统一适配器中的完整 E34 仍缺证。完整真实生成贪吃蛇 E42 仍归 #27。#21 保持打开。
