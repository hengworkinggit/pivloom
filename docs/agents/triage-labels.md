# Triage labels

采用 `/to-spec`、`/to-tickets` 所附默认词汇，缺少的标签仅在使用时创建。

| 技能角色 | GitHub 标签 | 含义 |
|---|---|---|
| needs-triage | needs-triage | 尚待明确范围与决策 |
| needs-info | needs-info | 缺少必要输入 |
| ready-for-agent | ready-for-agent | 规格明确；开始前仍须确认阻塞项和环境前置 |
| ready-for-human | ready-for-human | 需要人处理的任务 |
| wontfix | wontfix | 明确不实现 |

辅助标签：`type:spec` 表示总规格，`enhancement` 表示实现，`priority:p0`/`priority:p1` 表示已选范围优先级，`e2e-required` 表示关联 E2E 实测通过才可关闭。P1 的固定三角色是本轮已选范围，不能静默放弃。
