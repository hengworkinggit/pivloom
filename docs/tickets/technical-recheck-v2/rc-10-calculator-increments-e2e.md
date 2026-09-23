# [RC-10] 全新计算器完成真实生成及功能和视觉两轮增量

## Parent

[[Spec] Pivloom 技术复核：上游复用、五组验收、Canvas 与版本回滚 · #16](https://github.com/hengworkinggit/pivloom/issues/16)

## What to build

从一个空项目真实生成计算器，再在同一项目完成计算历史功能和明确视觉改版；逐轮证明完整旧功能、五组子检查、源码差异及Preview一致。

## Acceptance criteria

- [ ] 使用E2E已固定A0/A1/A2原始Prompt，开始时project无current和业务seed；TEST_PROFILE/产物替换关闭，三次用户提交分别记录。
- [ ] 真实Provider/model/configVersion、role调用、工具写入、构建与版本证据可关联；不得用预制计算器、测试答案或旧报名/书单替代。
- [ ] A0通过优先级/括号、小数、退格、除零后恢复、键盘和可用布局断言。
- [ ] A1确实新增历史记录/重用/清空和同origin刷新保留；A0全部required仍通过。
- [ ] A2实际呈现深色背景、橙色运算键、等宽结果区和390px可用布局；A0/A1全部行为保留。
- [ ] 每轮五组及全部子检查真实通过，完整文件diff可读且与Prompt吻合；project不变，baseRevision/current/Check/Preview marker一致。
- [ ] 运行中刷新恢复同一Run不重复提交；新独立浏览器和退出重登后平台项目、对话、版本和全部源码一致。
- [ ] E04/E05/E06/E07/E08/E09/E10/E11/E21/E26/E39完成后附逐轮完整证据才关闭；上游测试/模型自述不能替代。

## Upstream reuse

采用 U01, U02, U03, U04, U05；按[固定源码与许可清单](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

A的评审作品不作为本票新项目；失败/重试记录保留，不以修复attempt充当两轮用户增量。

## Testing and completion gate

- 关联UI/E2E：E04, E05, E06, E07, E08, E09, E10, E11, E21, E26, E39。
- 关联集成：I01, I04, I06, I13, I16, I18, I21。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/docs/E2E.md) · [技术方案](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/docs/specs/technical-recheck-v2.md)

## Prompts

> 做一个中文计算器网页，从空业务工程实现。支持数字、小数、加减乘除、括号和标准运算优先级；有清空、退格、等号按钮，也能用键盘数字、运算符、Enter、Backspace、Escape操作。除零和无效表达式有明确提示，清空后能继续计算。显示当前表达式和结果，手机窄屏按钮可操作。不要预写测试答案，不使用现成计算器页面。

> 在这个计算器中增加计算历史：记录算式和结果，可从历史重用结果，并有清空历史操作。当前浏览器刷新后历史保留。保留原来的四则、括号优先级、小数、键盘、清空退格、错误提示和恢复功能。

> 保留全部功能和计算历史，把页面改为深色背景、橙色运算键、等宽结果区；调整键盘间距和字号，使390px宽度下无需横向滚动且所有按键可用。只改变这里明确提出的视觉要求，不删减已有功能或校验。

## Blocked by

- [RC-01 · #17](https://github.com/hengworkinggit/pivloom/issues/17)
- [RC-03 · #19](https://github.com/hengworkinggit/pivloom/issues/19)
- [RC-05 · #21](https://github.com/hengworkinggit/pivloom/issues/21)
- [RC-06 · #22](https://github.com/hengworkinggit/pivloom/issues/22)
