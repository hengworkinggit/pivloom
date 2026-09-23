# [RC-05] 复用原生批量动作完成 Canvas 游戏观察闭环

## Parent

[[Spec] Pivloom 技术复核：上游复用、五组验收、Canvas 与版本回滚 · #16](https://github.com/hengworkinggit/pivloom/issues/16)

## What to build

Reviewer能够在当前候选中发送正常四向键、空格和短动作序列，等待后重新观察Canvas与HUD；输入失败、空白画布或运行错误不能获得通过结论。

## Acceptance criteria

- [ ] 固定agent-browser0.38.1，直接采用press/wait/batch/screenshot及JSON argv语义；补齐上下两层键盘schema，不自造CDP/时序执行器。
- [ ] 每条batch动作的结果、时序、浏览器session、revision及后续观察可核对；作用域只限当前候选，出错停止并读取真实结果。
- [ ] 短动作后通过正常暂停或及时截图稳定观察，图像确实进入Reviewer；不得注入坐标、分数、作弊按钮或隐藏冻结状态。
- [ ] 如动作涉及按下/保持/释放，按原生能力明确测试并在异常/取消后释放输入；不能把仅press一次说成已验证任意持键游戏。
- [ ] 保存Canvas与整页/HUD证据及console/pageerror；空白Canvas、输入断线、假计分/不增长和只有菜单的负例必须failed/blocked。
- [ ] 继承历史小游戏recipe的方法时保留来源和许可，修正exit0不代表成功、文本状态不是视觉证明等边界。
- [ ] E34/E42及I10/I13在已部署适配器通过；本机原版9动作探针不能作为本票完成结果。

## Upstream reuse

采用 U05, U10, U11；按[固定源码与许可清单](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

不替换默认产品浏览器为另一套Playwright/Python框架，不强制DOM棋盘来降低验收难度。

## Testing and completion gate

- 关联UI/E2E：E34, E42。
- 关联集成：I10, I13。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/docs/E2E.md) · [技术方案](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/docs/specs/technical-recheck-v2.md)

## Blocked by

- [RC-04 · #20](https://github.com/hengworkinggit/pivloom/issues/20)
