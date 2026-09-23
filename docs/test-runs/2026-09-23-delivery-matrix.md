# 当前交付矩阵

更新：2026-09-23 13:08（Asia/Shanghai）。#13 已关闭；#14 工程链路最终通过，关闭状态以 GitHub Issue 为准。最终 API/Web 分别为 `dev14-20260923-mobile-review` / `dev13-20260923-final`，提交 `03b6da8` 的 [CI 35820485171](https://github.com/hengworkinggit/pivloom/actions/runs/35820485171) 为 SUCCESS。

| 门槛 | 当前证据与范围 | 剩余项 |
|---|---|---|
| E04/E05/E12/E21：真实生成与业务、两种需求、三角色 | A 初次+两轮修改、B 初次均走真实模型/沙箱/检查者；最终 A 第二轮 Run `5c6cd082-a6e1-450d-ae5e-058dc0addb7c` completed / Check `4a2bb313-59e1-4010-adb7-1159eea7f78b` 5/5；独立浏览器同版操作通过 | 本工程链路已闭环 |
| E08：报名第一次修改 | Run `e1e1d3a9-9b5b-4c7b-94ae-cb3084bbf142` completed；独立浏览器确认组合筛选、搜索、提交、必填错误；补输入 `not-an-email` 实见“邮箱格式不正确”且无新增记录 | 本轮通过，详见错误邮箱 UI 工件 |
| E09：报名第二次修改 | 最终 current v15 `7f81b655-26bb-46ad-be31-c8510a4919a6`，统计/390px/旧表单与筛选均通过产品 Reviewer 与独立浏览器；旧 v12–v14 失败历史如实保留 | PASS；不把旧候选误记为通过 |
| E06/E07/E10/E11/E17：版本、源码、刷新/登录持久化、预览恢复 | 最终两文件与 manifest SHA 一致，独立预览刷新保留数据；旧模块预览恢复/重登录记录与本次生成中刷新同 Run 证据保留 | 本轮无新增阻塞 |
| E16/E22/E23：真实修复及上限 | 真实编译失败→修复、筛选失败→修复通过、attempt 0/1/2 均失败后停止；旧 current 保留及明确两轮提示均已独立 IAB 验证 | 本模块已完成，见收尾记录与三个绑定 Run 工件 |
| 其它 E01–E31 适用用例 | 使用对应已关闭模块的实际报告；本轮没有重跑全部历史用例 | 不因本表或 CI 绿色将未记录子断言升级为 PASS |
| I01–I12 | 已有模块集成记录；本轮真实 PG build-repair 4、recovery-service 2、executor 5、restore-cleanup 2；公网身份/源码/工件/SSE 只读隔离补证 | 外部模型/远端进程/HTTP fixture 的通过只覆盖其标注边界；不得替代真实 UI/模型用例 |
| D01：在线入口 | 免费 HTTPS 工作台、真实 A/B 生成与两轮修改及独立公网浏览器可操作；API/Web 已发布 | PASS |
| D02：源码可运行 | 独立目录 npm ci 与 contracts/API/Web build 通过；CI 成功；迁移013、启动/回滚/配置说明入库 | 无本轮已知构建阻塞 |
| D03：功能说明 | README、收尾记录和本矩阵明确完成/失败历史/待执行；预览与服务边界见部署文档 | PASS |
| D04：访问与提交材料 | 仓库提交、在线入口和构建证据已有链接 | 题面要求的 public 权限、个人副本/署名材料未在本轮交接中提供核验结果；不能由部署/CI 推定完成 |
| D05：期限与发送 | 用户截止为 2026-09-23 12:00（Asia/Shanghai）；当前材料正在收尾 | 实际提交/发送需单独记录，当前文档不是发送证明 |

产品工程链路的 A 第二轮已通过。D04/D05 的仓库公开权限、材料副本及实际对外发送没有本轮证明，单独保持待执行；12:00和随后半小时截止均未按时完成。没有新增购买、域名或架构前置。

证据索引：[当前收尾记录](2026-09-23-finalization.md)、[既有公网验收](../../artifacts/dev-07-2026-09-23/public-acceptance.md)、[本轮公网只读补证](../../artifacts/dev-13-2026-09-23/public-readonly.json)、[A 修改1持久化](../../artifacts/dev-13-2026-09-23/public-a-mod1-e1e1d3a9.json)。

本次补验：[错误邮箱 UI](../../artifacts/dev-14-2026-09-23/mod1-invalid-email-ui.txt)、[App.tsx 页面源码](../../artifacts/dev-14-2026-09-23/mod1-App-ui.txt)、[style.css 页面源码](../../artifacts/dev-14-2026-09-23/mod1-css-ui.txt)。

最终证据：[A 第二轮完成与5项检查](../../artifacts/dev-14-2026-09-23/public-a-final-pass.json)、[最终9项HTTP补证](../../artifacts/dev-14-2026-09-23/public-final-passed-readonly.json)、[390px截图](../../artifacts/dev-14-2026-09-23/final-390.png)。
