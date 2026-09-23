# [RC-07] 退出与切账号后撤销私有 Preview 访问

## Parent

[总Spec](../../specs/technical-recheck-github-spec.md)

## What to build

用户退出后旧私有Preview的新请求失效，同浏览器切换账号不会继承访问权；另一个有效会话继续可用，公开发布地址仍按既有规则匿名可读。

## Acceptance criteria

- [ ] 复用现有Supabase local signOut和已验证身份中的session_id；服务端验证登录session有效，不把JWT未过期/getUser成功当作即时撤销保证。
- [ ] 私有grant/Cookie限于owner、session和revision，普通API不接受它；凭据不进入生成应用、URL日志或公开报告。
- [ ] 退出当前session后，旧入口、Cookie、HTML、JS、marker及旧凭证新请求被拒；同浏览器B和独立B都不能读取A私有内容。
- [ ] 另一有效A会话不被误退出；A重新登录可从工作台取得新授权，Preview过期仍可恢复正确保存版本。
- [ ] 移植OpenHands资源Cookie作用域与匹配清除属性测试，不复制长期API key Cookie或仅清客户端却宣称服务端撤销。
- [ ] 在同构隔离环境验证A/B，不恢复已删除生产B，不破坏生产A；已下载内容不可远程抹除，验收针对新网络请求。
- [ ] E11/E25/E37和I09/I14实际通过，并单列公共发布匿名可读的正常结果。

## Upstream reuse

采用 U13, U14；按[固定源码与许可清单](../../../research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

不重造身份系统、全局下线所有设备或把公开发布可访问判成私有越权。

## Testing and completion gate

- 关联UI/E2E：E11, E25, E37。
- 关联集成：I09, I14。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](../../E2E.md) · [技术方案](../../specs/technical-recheck-v2.md)

## Blocked by

None (can start immediately).
