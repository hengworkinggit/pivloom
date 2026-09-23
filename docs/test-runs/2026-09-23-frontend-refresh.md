# 前端改版验收（2026-09-23）

用户要求一小时内完成；实际超过截止时间。本记录按已经执行的结果填写，不把页面渲染当成业务功能通过。

| 要求 | 实现与实际操作 |
|---|---|
| 注册 | 公网 `/register` 提交隔离新账户后自动登录进入 `/projects`；自托管 Supabase 的 `GOTRUE_DISABLE_SIGNUP` 已从 true 改为 false（原配置备份在服务器 `compose.yml.before-signup-20260923`）。现行服务使用邮箱自动确认；不依赖手工创建账号。 |
| 个人信息与额度 | 公网新账户无项目时从带身份的 `/api/v1/me/quota` 获得 0/20（剩余20）；匿名请求401。修改称呼后刷新保持；修改密码、登出、用新密码登录通过。邮箱变更已提交到身份服务，数据库显示 pending confirmation；仍需邮件确认，不能称为已改成新邮箱。 |
| 模板与首页 | `/templates` 展示六个原创页面预览，支持分类与搜索；`/templates/event-signup` 显示大图、功能与需求草稿。首页的活动报名、读书清单、个人作品集改为预览卡片，点击先看详情；公网操作“使用模板”后项目草稿已带入对应需求。390px 下宽度和 scrollWidth 均为390。 |
| 中英/明暗 | 语言和主题选择跨路由保留。公网切英文后项目、工作台、模型设置、账户、注册和模板的主要界面文案切换；深色模式实测。用户写入的项目名、模型返回的内容及服务端错误文字保留原语言。 |
| 会话模型 | 参考 [DeepSeek Harness 的会话模型菜单](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-model-selection/src/client/ModelSelect.tsx)，改为输入区旁的紧凑入口、提供商分组和搜索菜单。公网切换到另一个模型后刷新仍保留，随后已恢复原模型；没有因此发起模型任务。 |
| 重复入口 | 正式模式及演示模式的“新建项目”按钮均已移除，仍保留主输入区唯一的创建动作。 |

视觉布局参考 [Atoms 模板目录](https://atoms.dev/zh/templates) 的分类、预览画面和卡片网格；模板画面由本仓库 HTML/CSS 绘制。[手机模板页](../../artifacts/dev-15-2026-09-23/templates-mobile.png)、[会话模型菜单](../../artifacts/dev-15-2026-09-23/model-menu.png)。

Web 75/75 测试、TypeScript、lint、生产构建通过；API 身份边界专项 2/2、TypeScript、lint、构建通过。网页和 API 使用同一授权服务器发布，原站点回归 HTTP 200。发布版本与最终 CI 以本任务最后的服务器及 GitHub 检查为准。
