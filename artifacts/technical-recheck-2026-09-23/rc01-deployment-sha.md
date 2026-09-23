# RC-01 · Web/API 部署来源验收

结果：**E32 / I16 PASS**。完成于 2026-09-23 14:08 UTC。关联 [#17](https://github.com/hengworkinggit/pivloom/issues/17)。

| 核对项 | 实测 |
|---|---|
| 干净提交构建 | `bede579ad79bf63b53dbb2cb49840fceb38b67c3` 同次构建 Web/API；`99ff482e7cea6bf09673ed404ab7422a409946bb` Web 单独更新。构建前删除旧 `dist` / `.next`，产物 manifest 中提交与 `builtAt` 一致。 |
| 打包防伪 | 隔离 Git checkout 的 2 个测试先 RED 后 GREEN：拒绝无 manifest、旧提交 manifest、dirty checkout；接受匹配提交。正式包记录 `worktreeDirty=false`。 |
| Next 构建规则 | 正常构建 `BUILD_ID` 为完整提交 SHA。单独设定 `PIVLOOM_DEPLOYMENT_ID=rc01-precedence-check` 后，Next 产生自己的常量 `BUILD_ID`，manifest 保留原提交与该 deployment ID，打包器按此优先规则接受；该探针包没有部署。 |
| 首次部署 | API 和 Web 均为 `bede579…`。页面简写、`/version`、`/api/v1/version`、两份归档 manifest 一致。 |
| 独立切换 | 仅更新 Web 后，页面分别显示 `Web 99ff482e`、`API bede579a`；两个公网版本端点分别返回完整 `99ff482e7cea6bf09673ed404ab7422a409946bb` 与 `bede579ad79bf63b53dbb2cb49840fceb38b67c3`。响应均为 200、`Cache-Control: no-store`。 |
| 原包重启 | 分别重启 API 和 Web，重新读取版本接口；各自完整 SHA 与构建时间不变。 |
| UI | 真实浏览器登录测试账号 A，工作台桌面和 390×844 均能看到两个标识；分别点击复制按钮，页面显示成功状态。组件测试确认传给剪贴板的是完整 40 位 SHA；浏览器自身拒绝读取剪贴板，因此不把读取权限当作验证依据。390px 页面与版本栏的 `scrollWidth` 均为 390px。 |
| 回归 | 公网 API readiness、A 已发布的永久作品、原站点均为 HTTP 200。 |

开发验收优先尝试 Codex 内置浏览器；初始化连续两次超时（30 秒、60 秒），本次独立 UI 验收改用 `agent-browser 0.36.0` 的独立会话。产品内部 Reviewer 的浏览器不计入本项。截图仅截取版本栏，避免公开测试账号资料：[首次桌面](rc01-version-desktop.png)、[首次 390px](rc01-version-390.png)、[独立切换后桌面](rc01-version-split-desktop.png)、[独立切换后 390px](rc01-version-split-390.png)。

验证：[`bede579` CI](https://github.com/hengworkinggit/pivloom/actions/runs/35868503206) 和 [`99ff482` CI](https://github.com/hengworkinggit/pivloom/actions/runs/35870499681) 均成功，包含类型检查、lint、全套非外部环境测试、真实 PostgreSQL 恢复测试、干净构建和 API/Web 打包。计算器、贪吃蛇及其他技术复核项分别按其 issue 验收，本报告只证明部署版本来源及相关页面操作。
