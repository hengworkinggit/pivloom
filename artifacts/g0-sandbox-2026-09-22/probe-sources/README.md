# 实际沙箱探针源码

这些是2026-09-22在已授权服务器执行的维护者探针，不是正式产品实现或一键部署器。React应用为固定fixture。

- probe.mjs：创建沙箱、文件/构建/预览/取消与清理；交互阶段等待维护者完成独立浏览器操作。
- command.mjs：向当前登记沙箱执行指定验证命令并记录输出；只供可信维护者使用，不可暴露为产品HTTP接口。
- lifecycle.mjs：创建中取消、两个沙箱文件隔离、TTL回收。
- monitor.py：采样cgroup/宿主内存与既有站点响应。

依赖锁定版本和运行时配置见 ../../../docs/sandbox-g0-results.md。脚本假设已有 /opt/pivloom/g0-sandbox、已构建工作镜像、SDK和仅限回环的管理服务，并从服务器受限control-key文件读取凭据；此目录不包含该Key。

在远端SDK client目录中曾使用 node probe.mjs gvisor、node lifecycle.mjs；monitor.py需要读本次测试容器的cgroup。运行会创建和销毁标记测试资源，先核对目标和容量。探针最后一次保存的iframe文字仍有旧端口说明，真实验收URL以报告为准。

原始结果已单独保留；不要覆盖记录后将新的测试冒充为本次结果。
