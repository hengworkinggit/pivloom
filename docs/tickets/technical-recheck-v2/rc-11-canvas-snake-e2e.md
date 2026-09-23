# [RC-11] 全新 Canvas 贪吃蛇通过真实模型和浏览器验收

## Parent

[[Spec] Pivloom 技术复核：上游复用、五组验收、Canvas 与版本回滚 · #16](https://github.com/hengworkinggit/pivloom/issues/16)

## What to build

在另一个空项目真实生成Canvas贪吃蛇，并通过正常输入、画布图像与HUD证明游戏可玩；同时核对计算器等其他项目未被改动。

## Acceptance criteria

- [ ] 使用E2E固定贪吃蛇原始Prompt，新project无业务seed、fixture关闭；真实模型调用、写入、构建和检查与结果Revision可关联。
- [ ] 实际使用Canvas，进入gameplay看到蛇和食物；不得换DOM棋盘、书单、预制游戏或只截菜单来替代。
- [ ] 正常四向键输入有效且禁止立即反向穿过自身；通过观察画面和实际移动吃到食物，长度与分数对应增长。
- [ ] 正常Space暂停/继续可验证；碰墙和自碰导致结束；重开恢复当前棋盘/分数，同浏览器最高分按需求持久化。
- [ ] 短动作batch、等待、正常暂停和真实截图形成闭环；Reviewer实际收到图像，状态文本仅辅助，不注入分数/坐标或隐藏时钟作弊。
- [ ] 五组完整子检查及独立QA通过；空白Canvas、输入断线、只加分不增长、碰撞无效等隔离负例必须failed/blocked。
- [ ] 源码功能与计算器明显不同，完整manifest/Check/Preview一致；别的project/current/对话/源码不被改变。
- [ ] E12/E33/E34/E42和相关图像/浏览器/版本集成断言通过；Provider视觉未验证或任何玩法未实操均不得关闭。

## Upstream reuse

采用 U03, U05, U10, U11；按[固定源码与许可清单](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

不要把OpenManus测试fixture或历史游戏脚本exit0当真实玩法通过；不额外引入Python Agent运行时。

## Testing and completion gate

- 关联UI/E2E：E12, E33, E34, E42。
- 关联集成：I06, I10, I13, I16, I20, I21。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/docs/E2E.md) · [技术方案](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/docs/specs/technical-recheck-v2.md)

## Prompts

> 做一个中文贪吃蛇小游戏，使用Canvas绘制棋盘、蛇和食物。方向键四向控制，不能立即反向穿过自己；支持开始、空格暂停/继续、游戏结束后重新开始。吃食物时蛇变长且分数增加，碰墙或撞到自己结束；显示当前分数、最高分和操作说明，最高分在同一浏览器刷新后保留。不要提供测试专用加分、改坐标或跳过碰撞按钮。

## Blocked by

- [RC-01 · #17](https://github.com/hengworkinggit/pivloom/issues/17)
- [RC-03 · #19](https://github.com/hengworkinggit/pivloom/issues/19)
- [RC-05 · #21](https://github.com/hengworkinggit/pivloom/issues/21)
- [RC-06 · #22](https://github.com/hengworkinggit/pivloom/issues/22)
