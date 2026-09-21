# API 与 Agent 服务

后端应用目录，计划采用常驻 Fastify 服务，集成 Pi SDK、E2B、agent-browser 和 Supabase。

负责身份与归属校验、任务状态机、三个角色的独立会话、远程工具、持久化、预览生命周期及 SSE。与前端同仓维护，可以独立构建和部署。

目前仅建立目录，尚未初始化服务或安装依赖。实现依据：[TRD](../../docs/TRD.md)、[E2E](../../docs/E2E.md)。
