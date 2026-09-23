# RC-02 · Pi 生命周期与停止验收

关联 [#18](https://github.com/hengworkinggit/pivloom/issues/18)。运行代码已以 `ee236fb38d5850aa50d2bfb43ec694220ca2cc89` 构建并部署，Web/API 公网版本接口一致；[CI](https://github.com/hengworkinggit/pivloom/actions/runs/35885920821) 通过。Pi 三包均固定 `0.86.1`，OpenSandbox JS SDK 为 `1.1.0`。Coordinator、Builder、Reviewer 都直接使用 Pi 会话与原生 retry、abort/idle、ToolDefinition 和 compaction；业务层保留异步事件落库 drain。停止闩锁借鉴 Dyad 开放目录并保留许可。

## 页面和远端实测

测试环境为服务器上的隔离 API 进程和 `pivloom_e2e_test_20260923`，浏览器从本地 Next 工作台实际登录测试账号 A 并点击停止。阶段门槛的模型 HTTP 为受控 fixture；PostgreSQL、Supabase Auth/Storage、Pi 循环和 OpenSandbox 均为真实组件。QA 使用独立 `agent-browser 0.36.0` 会话；Codex 内置浏览器在 RC-01 验收时两次初始化超时，故本轮沿用记录过原因的补充浏览器。测试进程不进入生产启动路径，也未修改正式 A 项目。

| 用例 | Run 与观察 | 结论 |
|---|---|---|
| E13 Coordinator | `e53b4a22-5d1d-4f52-86ee-3a8ba270f041`；模型阶段门槛后从工作台停止，Run/角色为 `cancelled`，cleanup `confirmed`，current 空且没有沙箱。[页面局部截图](rc02-e13-coordinator-outcome.png)。 | PASS（fixture 模型） |
| E13 Builder | `bd76da84-1457-4dc6-89a9-74183595e83d`；协调者完成后 Builder 模型等待中点击停止。Run 和 Builder 为 `cancelled`，候选沙箱 `destroyed`，current 空。 | PASS（fixture 模型、真实沙箱） |
| E13 Reviewer | `f6a2abc7-3627-4768-8ec0-54e88b74fdb4`；真实构建、候选源码和 Preview 就绪后，在检查者模型阶段停止。Run/Reviewer 为 `cancelled`，候选源码保留但未接受，沙箱最终销毁。此轮发现 cleanup 从 pending 转为 confirmed 后错误提示仍旧；修复后的完整页面复测为 `6f3ed874-f811-4edc-97f5-f4c59ff3d0dd`：Run `cancelled`、cleanup `confirmed`、沙箱 `destroyed`、current 空，Run 摘要、错误提示和对话结果一致；页面出现“资源清理已确认”。[结果卡片](rc02-reviewer-cleanup-confirmed.png) · [执行记录](rc02-reviewer-activity.png)。 | PASS（fixture 模型、真实构建/浏览器/沙箱） |
| E14 远端长命令 | `5a5b0d83-ebac-4851-9985-c98683c4fd2c`；工作台 Stop 后新沙箱销毁，连续两次读取远端周期输出均为 176 条。随后在同一项目先接受真正可点击的计数器基线 `1572655d-b393-453a-90b8-2c13c4c84fe2` / v3 `e2a19c90-3bbc-4978-9389-91126de9ff1c`（sourceHash `3ba0ac647d8f2ea566c786e03dfcc0d51458921c05e50696c022f9d7e09b5e9c`，Check passed 1/1，**fixture 模型，不算新样本生成**），再让增量 Run `1c180c55-6981-44fc-b984-be85f99d02f9` 的远端长命令及子进程运行后点击 Stop。新 Run `cancelled`、新沙箱 `destroyed`、周期输出 232→232；原 current 仍为 v3，原沙箱保持 active，私有 Preview 新请求 HTTP 200，按钮从 0 点到 1。[停止卡片](rc02-e14-outcome.png) · [旧版仍可操作](rc02-old-preview-after-stop.png)。 | PASS（fixture 模型、真实远端命令/预览） |

第一次本地转发数据库的 Builder 尝试 `fe79f4aa-aeeb-4cef-9e1e-eb4100fd3bc3` 在进入目标阶段前失败，未计入 E13；将测试 API 移至数据库所在服务器的隔离端口后重新执行了以上有效用例。临时 Preview 在测试 API 重启后按设计需要恢复；同项目 E14 在恢复并实测旧版后才发起新 Run。

另使用测试账号已保存的真实 Provider 配置运行 G0：在收到实际流内容后取消，传输观察到 abort，Pi 等待结束，停止后没有新增字节；真实长命令及迟到沙箱创建均销毁确认。[脱敏原始结果摘要](rc02-real-provider-abort.json)。用刻意无效的 key 向该 Provider 发起认证错误探针，实际返回 401，Pi 仅请求一次且未交接角色：[脱敏结果](rc02-provider-rejection.json)。独立的[真实远端命令适配器探针](rc02-real-remote-command.json)也通过；这些结果与 UI fixture 验收分别计数。

## 代码与状态门槛

- Builder 返回取消结果现进入 `finishCancelled`；Pi 原生 abort/idle 收口后才释放会话。工作台连续快速点击 Stop 只提交一次，明确失败后可重试。
- Reviewer 重试事件的 PostgreSQL 追加失败先有 RED 用例、修复后为 GREEN，不再把丢失事件的报告接受为通过。Pi 原生压缩替代最近两轮的手工裁剪；长会话压缩后的旧观察可按 ID 读回，压缩期间取消可收口。
- Pi 适配器测试覆盖连续错误→成功→下一轮再错误、退避期间取消、认证错误不重试，以及同一次官方 `edit` 工具调用中两处不相邻修改均生效。owner/路径限制仍由现有 Workspace 边界负责。
- 真实 PostgreSQL 与私有 Storage 的最终检查集成用例通过：取消先于提交时拒绝迟到报告，正常精确版本才可提升，事务失败不发布事件。该定向用例耗时约 353 秒；检查完用 Storage API 核对精确对象清理，不借不存在的测试库 `storage.objects` 表冒充验证。延迟 cleanup 的 repository 用例先 RED 后 GREEN，确认 `summary`、`error.message`、结果消息及项目锁同步更新。

验收数据已精确清理：第一批 2 个隔离项目、8 个 Run、7 条沙箱记录、3 个 Revision、1 份 Check、4 个 Storage 对象；最终页面复测的第二批 1 个项目、1 个 Run、1 条沙箱记录、1 个 Revision、1 个 Storage 对象。两次删除都先做范围与状态 dry-run、确认沙箱已销毁，再删除对象和数据库行并核对项目余量为 0。临时服务器进程、私有环境文件和 QA 浏览器会话均已关闭。生产测试账号 A、永久作品和原站点随后仍可访问。
