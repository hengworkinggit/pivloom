# 前端开源参考与采用边界

核实日期：2026-09-22。以下为 GitHub 官方仓库的当日快照，星数只作为活跃度参考。当前实现是前端演示：接口、登录、生成、执行状态、检查结果均由本地 mock 提供。

## 仓库与结论

| 项目 | 当日 Stars | 许可证 | 本轮采用方式 |
| --- | ---: | --- | --- |
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | 124,330 | MIT | 改编 Button、Dialog 的组件组合方式；在本项目保留可修改的源码与版权声明 |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | 12,244 | MIT | 仅参考 composer 的布局、发送/停止切换、无障碍标签；不安装其聊天运行时 |
| [vercel/ai-elements](https://github.com/vercel/ai-elements) | 2,452 | Apache-2.0 | 仅参考消息层级、输入键盘行为、对话滚动体验；不复制源码、不接 AI SDK |

AI Elements 的 GitHub 仓库元数据返回 `NOASSERTION`，但[当前 LICENSE 文件](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/LICENSE)明确采用 Apache License 2.0；以上以文件内容为准。

## 具体借鉴点

1. **统一按钮语义。** 使用 `variant` / `size`、可见的键盘焦点、禁用状态，避免每个页面重新拼按钮。采用 Radix Slot 以保持链接和按钮的正确 HTML 语义。基础结构参考 [shadcn Button](https://github.com/shadcn-ui/ui/blob/98a1fe67b439324ddc857f47fbdce056600a4329/apps/v4/registry/new-york-v4/ui/button.tsx)，配色、间距和圆角适配 Pivloom。
2. **弹窗交互交给 Radix。** 保留 Portal、Overlay、Content、Title、Description、Close 的组合，由底层处理焦点和 Escape。视觉样式在本地调整，使用明确的中文标题与操作名。源码参考 [shadcn Dialog](https://github.com/shadcn-ui/ui/blob/98a1fe67b439324ddc857f47fbdce056600a4329/apps/v4/registry/new-york-v4/ui/dialog.tsx)。
3. **输入区维持稳定位置。** 参考 [assistant-ui Composer](https://github.com/assistant-ui/assistant-ui/blob/d9992c6a87dd1a23e9ff737b6c3aedd58a90c1d6/packages/ui/src/components/react/assistant-ui/elements/composer.tsx) 的输入区与操作区层级；同一位置呈现发送或停止，并同步修改可访问名称。本轮不加入附件、语音、模型选择、上下文用量等尚无业务实现的入口。
4. **完整处理中文输入。** 参考 [AI Elements PromptInputTextarea](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/prompt-input.tsx#L956) 的行为规范：Enter 发送、Shift+Enter 换行、输入法组合中不发送、禁用提交时键盘不能绕过。根据本地 mock 状态独立实现，不引入其附件、provider 和模型消息依赖。
5. **对话正文与状态分层。** 参考 [AI Elements Message](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/message.tsx#L37) 的用户消息块与助手正文区分，参考 [Conversation](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/conversation.tsx) 将滚动容器与正文分离。Pivloom 另行实现协调者、工程师、检查者的紧凑步骤记录，检查详情默认折叠；mock 检查结果明确标注为演示。

## 直接依赖、源码改编与交互参考

- **直接依赖：** React / Next.js、Tailwind CSS、`radix-ui`、`lucide-react`、`class-variance-authority`、`clsx`、`tailwind-merge`。实际版本以根目录 `package-lock.json` 为准。
- **源码改编：** shadcn Button / Dialog 的组件封装与组合模式。对应 MIT 声明见 [第三方 UI 说明](third-party-ui-notices.md)。Pivloom 的页面布局、项目卡片、执行过程和预览容器独立编写。
- **仅交互参考：** assistant-ui、AI Elements。没有安装这两个项目的运行时，没有因此引入模型请求、Agent SDK 或后端服务。

## 本轮取舍

采用轻量组件组合，方便后续替换 mock 接口；不把成熟聊天框架的整个状态系统搬进当前演示。UI 只覆盖 PRD 已确定的登录、项目列表、创建、对话工作台、预览、只读代码和运行异常状态。图标使用 Lucide，避免风格不同的手写图标混杂。

## 核实方法

使用 agent-reach 的 GitHub / `gh` 后端查询仓库信息、固定提交、目录树与相关源文件。先检查 `codebase-memory-mcp` 项目列表，三个远程 UI 仓库均未建立本地图索引；本轮只读少量公开组件，因此回退到 GitHub 目录 API 精确定位文件，再读取固定提交内容，没有将远程仓库全量克隆到项目。许可证来自固定提交的上游文件与安装包内的 LICENSE；没有将“参考过”写成“已复制”。
