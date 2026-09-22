# Pivloom 正式开发任务

总规格：[[Spec] Pivloom 正式开发：真实生成、固定三角色与逐模块 E2E](https://github.com/hengworkinggit/pivloom/issues/1)。共14张子issue；实现与正式测试均未因此完成。

按 `/to-spec` 与 `/to-tickets` 编写。每模块完成后立即执行对应E2E，再关闭issue；必需用例FAIL/BLOCKED/NOT_RUN不能视为完成。原生GitHub依赖与正文一致。

| 开发票 | 优先级 | 直接阻塞 |
|---|---|---|
| [DEV-01 · #2 G0：打通 Pi → 隔离沙箱 → 可操作预览的真实垂直探针](https://github.com/hengworkinggit/pivloom/issues/2) | P0 | 无 |
| [DEV-02 · #3 登录后创建、重开并隔离服务端项目](https://github.com/hengworkinggit/pivloom/issues/3) | P0 | 无 |
| [DEV-14 · #15 在页面配置自己的模型服务并验证连接](https://github.com/hengworkinggit/pivloom/issues/15) | P0 | [#3](https://github.com/hengworkinggit/pivloom/issues/3) |
| [DEV-03 · #4 从一个真实需求生成、保存并预览多文件应用](https://github.com/hengworkinggit/pivloom/issues/4) | P0 | [#2](https://github.com/hengworkinggit/pivloom/issues/2), [#3](https://github.com/hengworkinggit/pivloom/issues/3), [#15](https://github.com/hengworkinggit/pivloom/issues/15) |
| [DEV-04 · #5 执行中刷新与 SSE 断线后恢复同一个任务](https://github.com/hengworkinggit/pivloom/issues/5) | P0 | [#4](https://github.com/hengworkinggit/pivloom/issues/4) |
| [DEV-05 · #6 协调者澄清需求并向工程师交接可观察目标](https://github.com/hengworkinggit/pivloom/issues/6) | P1 | [#4](https://github.com/hengworkinggit/pivloom/issues/4) |
| [DEV-06 · #7 检查者实际操作候选应用并绑定检查结果](https://github.com/hengworkinggit/pivloom/issues/7) | P1 | [#6](https://github.com/hengworkinggit/pivloom/issues/6) |
| [DEV-07 · #8 同项目两轮真实修改与版本一致的源码查看](https://github.com/hengworkinggit/pivloom/issues/8) | P0 | [#7](https://github.com/hengworkinggit/pivloom/issues/7) |
| [DEV-08 · #9 停止真实模型、远端命令和候选资源](https://github.com/hengworkinggit/pivloom/issues/9) | P0 | [#7](https://github.com/hengworkinggit/pivloom/issues/7) |
| [DEV-09 · #10 失败后新建重试任务并恢复 API 重启中断状态](https://github.com/hengworkinggit/pivloom/issues/10) | P0 | [#9](https://github.com/hengworkinggit/pivloom/issues/9) |
| [DEV-10 · #11 沙箱过期后从已保存版本恢复预览](https://github.com/hengworkinggit/pivloom/issues/11) | P0 | [#9](https://github.com/hengworkinggit/pivloom/issues/9) |
| [DEV-11 · #12 容量、额度和超时约束下可控运行与资源回收](https://github.com/hengworkinggit/pivloom/issues/12) | P0 | [#10](https://github.com/hengworkinggit/pivloom/issues/10), [#11](https://github.com/hengworkinggit/pivloom/issues/11) |
| [DEV-12 · #13 检查失败后最多两轮真实修复与复查](https://github.com/hengworkinggit/pivloom/issues/13) | P1 | [#12](https://github.com/hengworkinggit/pivloom/issues/12) |
| [DEV-13 · #14 上线真实工作台并完成独立全链路验收](https://github.com/hengworkinggit/pivloom/issues/14) | P0 | [#5](https://github.com/hengworkinggit/pivloom/issues/5), [#8](https://github.com/hengworkinggit/pivloom/issues/8), [#13](https://github.com/hengworkinggit/pivloom/issues/13) |

## 执行顺序与边界

服务器沙箱基础设施、真实 Pi 生成、维护页面 iframe、模型实际输出后的取消、Auth/Storage、身份/项目及模型设置 UI、单沙箱联合容量均已通过。DEV-01/DEV-02/DEV-14 的本模块验收见[联合记录](../../foundation-validation-2026-09-22.md)，依赖它们的 DEV-03 尚未实现。先真实候选，再协调与检查；DEV-03 的候选子链路不能提前把完整 E04/E12 记 PASS，DEV-06 需复测。

Supabase优先自托管，代理准备服务URL/密钥、迁移与测试数据；用户模型通过设置页配置，保留Pi。域名仅为公网发布前置。OpenSandbox Docker + gVisor已经实测并部署内部服务，无需E2B账号；正式WorkspacePort/BrowserPort已通过真实探针，工作台生成尚未接入。原48h期限不重新计时。

## 测试规则

主流程用Codex内置浏览器；产品Reviewer用隔离沙箱中的agent-browser，Postgres/HTTP/取消用集成测试补证。每票有具体前置、动作和断言；Mock、fixture与真实执行分别记录，正式用例仍为NOT_RUN。当前范围E01–E31/I01–I12；不要求用户逐版本阅读长报告。

## 本地与远端

每个dev-xx文件是同步的issue正文；github-issues.json保存实际链接，plan.json保存拆分决策。发布后以GitHub状态、原生依赖和最新评论为准。测试记录格式见[E2E](../../E2E.md)，沙箱取舍见[评估](../../sandbox-options.md)，已通过项目见[实测](../../sandbox-g0-results.md)。
