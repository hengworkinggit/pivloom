# DEV-07 · 同项目两轮真实修改与版本一致的源码查看

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F05/F06/F07/F08。

## What to build

用户在同一活动项目追加“状态筛选”和“统计及窄屏”，保留原有行为；预览与只读源码都来自正在查看的实际版本，重新登录仍能取回。

## Implementation decisions

- 普通修改从 current 的已保存快照构建新候选，输入 expectedCurrentRevisionId；旧成功版本仍可操作，candidate 不原地覆盖旧运行目录。
- Revision 不可变且每个 attempt 最多一个最终 snapshot；GET revisions files/file 只从授权 manifest 读文本，不能直接读取服务器路径。
- 文件树、选中文件、sourceHash、preview marker 与 revisionId 一致；编译产物、依赖、密钥不展示。前端选版本不按本地递增数字猜数据。
- 每轮重新录入预览业务测试数据；新 origin 不承诺迁移 localStorage。项目、聊天与源码的云端持久化必须独立验证。

## Acceptance criteria

- [ ] 同项目初版+两次修改都有独立 run/revision 和历史消息；两轮都保持新增、校验、确认与搜索。
- [ ] 状态筛选和搜索联合生效；总数/已确认数不随筛选改变；390px 生成应用无整页横向滚动。
- [ ] 查看真实源码可找到需求实现，刷新/重新登录后 hash 与内容一致；切文件不显示别的版本内容。
- [ ] 构建失败、保存失败或检查失败候选不替换已有成功版本；B 不能读取 A 的源码或任意路径。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| E07/E08/E09/E11 | 在A项目追加两个既定修改；每版本通过UI输入三条记录，再切筛选、搜索、统计、预览和代码；重新登录。 | v1/v2/v3 对应独立保存结果；筛选已确认=田禾1条，林+已确认=0，全部+林=1；总数3/确认1；版本内容可恢复。 |
| I05/I06/I09 + E25 源码子集 | 记录旧版本 hash，产生新候选并延迟旧结果；尝试越权/路径逃逸读取。 | 旧源码不变，marker/hash 不错配；未授权读取拒绝；candidate 不污染 current。 |
| E26 双层窄屏 | 分别验证390px工作台和390px生成应用容器。 | 工作台聊天/结果切换保留草稿；应用关键表单和筛选可用，两个检查分别留证。 |

## Blocked by

- [DEV-06 · #7](https://github.com/hengworkinggit/pivloom/issues/7)

## Out of scope

不做完整历史管理页、代码编辑、ZIP导出、回滚UI或跨版本业务数据库迁移。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。
