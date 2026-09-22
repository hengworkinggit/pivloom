# Issue tracker: GitHub

本项目正式规格和开发任务使用 [hengworkinggit/pivloom](https://github.com/hengworkinggit/pivloom/issues) 的 GitHub Issues，通过 `gh` CLI 操作。该选择来自用户本轮明确指示；标签使用技能默认词汇，映射见 [triage-labels](triage-labels.md)。

总 Spec 使用 `type:spec`，实现任务使用 `enhancement`、`ready-for-agent`、对应 `priority:p0` 或 `priority:p1`、`e2e-required`。规格就绪不代表依赖已完成；只领取全部阻塞项已完成的任务。

父子关系使用原生 sub-issues，阻塞关系使用原生 issue dependencies；正文同时保留 Parent 和 Blocked by，便于导出阅读。创建多行正文用 `--body-file`，保留换行。不修改或关闭源父 issue 来冒充子任务完成。

每个模块实现后立即执行其相关 E2E、补充集成断言与受影响回归，实际通过后才关闭。FAIL、BLOCKED、NOT_RUN 都不是通过；已有 Mock 检查不能替代正式测试。详见 [总 Spec](../specs/real-development-v1.md)。

使用可访问该仓库的 `hengworkinggit` 已有授权；多个 gh 账号并存时仅给本次子进程配置凭据，避免改变全局活动账号，不输出 token。

PRs as a request surface: no.

本地 `docs/tickets/real-development-v1` 保留本次创建正文和链接，发布后以 GitHub 的 issue 状态、原生依赖和最新评论为准。
