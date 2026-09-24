# RC-04 · Reviewer 图像输入与视觉能力

状态：实现、真实 Provider/OpenSandbox 图像链与同一 SHA 的生产模型设置 E31 均已复核。下文早期“发布门槛”记录最初未执行状态，最终补证见末节。

## 实现

- `browser_screenshot` 将实际 PNG 作为 Pi 官方 `ImageContent {type:"image",data,mimeType}` 返回，文本块保留 artifactId、SHA-256、revisionId、sourceHash、observationId 和浏览器会话。Pi 后续 Provider 请求保留 `image/png` 和完整图片数据。`screenshot_read` 允许长上下文压缩后按本轮 artifactId 重新读取同一候选图片。图片原文不写入活动事件或公开报告。
- Reviewer 只有在截图进入后续成功的 Provider 请求后，才能提交 `passed`；只有路径、hash、截图工件或 DOM 结果均不能冒充视觉观察。模型图像能力未验证时在 Provider I/O 前阻断，并保留 `blocked` 而非业务失败。
- 模型设置的流式、工具与图像状态分别报告。图像探针使用两张随机颜色的真实 PNG，颜色不在文本里；只有同一 Provider/base URL/model 的两个颜色都回答正确且两个图片出现在实际出站 payload 中才标记 `verified`。明确拒图为 `unsupported`，答错为 `failed`，传输无法判定为 `unknown`。冻结配置在接受任务前要求 `vision=verified`；临时改用另一个 modelId 必须先另存配置并重测。
- 复用边界：U03 直接使用 Pi 0.86.1 图像消息形状；U04 直接使用 Pi 原生 compaction；U10 只借鉴 OpenManus 的截图反馈顺序，不复制 Python/MCP 运行时或模型名单。

## 已执行证据

- I13 离线：Pi 出站请求包含两张真实 PNG 和正确 MIME，随机颜色识别成功、猜错与拒图不被误判。`model-vision-probe.test.ts` 3/3；Reviewer 截图→后续 Provider 请求、按工件重读、无图拒绝、compaction 后重读均通过。
- 实际配置连接探针：Ark `kimi-k2.7-code`、配置版本 2，Pi 真实请求验证 streaming、tools、vision 全部 `verified`；[脱敏结果](rc04-real-model-connection.json)。独立随机图片能力探针的实际回答和出站计数见[记录](rc04-real-provider-vision.json)。这两项只读，尚未修改生产配置。
- E33 独立真实链路：一次性 OpenSandbox 内 Chrome/agent-browser 打开 Canvas，实际点击后画面由黄色变红色；Reviewer 的两个 PNG 工件经过 Pi 发往真实模型，模型正确给出前后颜色并提交 `passed`。只把前四轮工具选择脚本化；浏览器、Canvas、截图和最终 Provider 视觉请求均是真实调用。[原始脱敏记录](rc04-e33-canvas.json)及[点击前](e33-1.png)、[点击后](e33-2.png)截图。沙箱销毁后独立 GET 返回 HTTP 404。
- E33 顺序复核：把上述两张真实浏览器截图分别作为 Pi `toolResult` 图片送入两次实际 Provider 请求；第一次回答 `YELLOW`，画面改变后第二次回答 `RED`，出站请求分别包含 1、2 张正确 MIME 的图片。[顺序请求记录](rc04-e33-sequential.json)。
- Reviewer 直接测试 64 项、Review 服务测试 10 项、API/Web typecheck 与 lint 均通过。集成数据库测试须在受控隔离库运行；生产账户和项目未被此轮测试改动。
- 隔离 `pivloom_executor_test_*` 数据库内的测试配置已通过产品 `testSaved` 服务真实调用并持久化 `vision=verified`；没有用 SQL 伪造 A 配置的能力。E40 Executor 集成单项 1/1 通过，合成模型配置及项目由该用例清理。Review/PostgreSQL/Storage 精确版本提交、owner 隔离与完整 PNG 回读单项 1/1 通过（222.87 秒）；其夹具 1 个项目、1 个 Run、2 个 Storage 对象全部确认清理。前次旧的 8 字节截图断言失败没有计为通过。

## 发布门槛

1. CI 通过并以相同提交 SHA 发布 API。部署脚本先确认无活动任务。
2. 用测试账号 A 的有效会话调用公开 `POST /api/v1/model-profiles/{id}/test`，只通过产品服务写入该配置版本的测试结果。核对返回及重新 GET 的 `vision=verified`，并确认 API SHA；不得直接修改数据库能力字段。
3. 发布 Web，同步核对 Web/API SHA。独立浏览器实际打开模型设置与工作台，检查 `unknown/verified/unsupported/failed` 的可读状态；用未验证配置或不同 modelId 提交时，应在创建 Run 前收到明确 422，不能留下半途项目。
4. 生产产品 Reviewer 再走一次隔离 Canvas 候选的 E33；核对 Run/Revision/sourceHash、截图工件、Check 和最终资源清理。上述生产 E31/E33 UI 项未执行前，本票不能关闭。

## 同一 SHA 生产与真实远端补证（2026-09-24）

- Web/API `4733d3a2c860418f6c71a95535c800887d055be2` 的 [CI](https://github.com/hengworkinggit/pivloom/actions/runs/35934415450) 两项全绿。独立生产浏览器在桌面和390px读取测试账号 A 已保存的 profile v2：实际 `modelId=kimi-k2.7-code`，streaming/tools/vision 均 verified、lastTest passed，工作台选择器与冻结配置可核对。[E31 只读页面和截图](rc04-production-e31-4733.md)。profile 显示名仍是旧的“火山方舟 · GLM 5.3 Flash”，但实际模型 ID 在详情与运行元数据中明确展示；测试没有更改用户配置或重新调用模型。
- 同一代码提交的独立工作树上，以已验证的真实 Provider 配置和真实 OpenSandbox 跑产品 `RemoteBrowser`/Pi Reviewer 受控 Canvas E33：原生四向键及 Space、前后两张 PNG 实际进入成功的模型请求，正例由真实模型给出 `passed`；Run/Revision/sourceHash/浏览器 Session、动作观察和动作后截图工件全部绑定。另一条独立远端空白 Canvas 例执行真实按键后，真实模型依据图像判 `failed`，未把 HUD 变化冒充画面。两条临时沙箱均 kill confirmed、独立 SDK getInfo 404。[原始正反例和清理记录](rc05-real-reviewer.md)。这些是受控候选而非正式生成贪吃蛇，完整玩法与其他负例归 #21/#27。
- 离线 ImageContent、图像能力真假探针、compaction 后截图重读和错误能力阻断仍由上述原始报告及当前 CI 回归覆盖；公开证据只含脱敏请求结构/图像工件，不含 Key/token。
