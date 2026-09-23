# [RC-04] 让 Reviewer 真正读取截图并验证模型图像能力

## Parent

[总Spec](../../specs/technical-recheck-github-spec.md)

## What to build

用户在模型设置确认所选配置的图像能力，Reviewer获得当前候选的真实图片并基于图像作出判断；不支持图片时有明确状态，不会假装视觉验收成功。

## Acceptance criteria

- [ ] 按Pi官方ImageContent形式回传真实PNG/JPEG及正确MIME，同时保留artifact/observation/revision元信息；不是仅返回路径、URL、hash或artifact ID。
- [ ] 选定并冻结的实际Provider/base URL/model经过真实图像探针，使用只存在于图片中的变化信息验证，不用HTTP200或模型名单猜测。
- [ ] 模型设置和工作台区分unknown/verified/unsupported或失败；不支持时提示选择可用配置，不静默丢图或切换其他Provider。
- [ ] 模型input能力声明、实际出站图像、返回内容可用脱敏证据核对；API Key、token和图片中的私密内容不出现在公开报告。
- [ ] 长Reviewer会话/compaction后图片、MIME、工具声明与完整验收证据仍可读取；图像与当前revision/action对应。
- [ ] 移植OpenManus图片反馈顺序但拒绝硬编码多模态名单、MIME丢失和浮动Python/MCP运行时。
- [ ] E31/E33及I13/I21通过；离线ImageContent探针和真实Provider视觉能力分别记录，真实视觉未验证不得关闭。

## Upstream reuse

采用 U03, U04, U10；按[固定源码与许可清单](../../../research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

不以DOM版贪吃蛇替代Canvas；不新增通用多模型路由平台或把整套OpenManus当作Pi外层。

## Testing and completion gate

- 关联UI/E2E：E31, E33。
- 关联集成：I13, I21。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](../../E2E.md) · [技术方案](../../specs/technical-recheck-v2.md)

## Blocked by

- [RC-02 · 复用 Pi 原生生命周期并可靠停止三个角色](rc-02-pi-lifecycle.md)
