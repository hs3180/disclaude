# 文档索引

本目录只维护当前设计契约、安装配置和运维手册。一次性测试结果、旧方案
比较和实现过程记录应保留在对应的 GitHub issue / PR 中，不作为常驻文档。

## 设计与行为契约

- [内部 HTTP API](designs/rest-ipc-design.md)：服务 API、鉴权和进程边界。
- [空响应恢复](designs/empty-turn-session-reset-design.md)：何时重置会话、
  如何限制重试。
- [浏览器协调](browser-coordination.md)与
  [容器 CDP endpoint](cdp-endpoint.md)：Agent 访问边界和服务内部传输。
- [CLI Skill 格式](skill-format-spec.md)与
  [共享 Skill 注册表](skills-registry.md)：技能接口、发现和优先级。
- [CardKit 节流方法](feishu-cardkit-rate-limit-methodology.md)：当前测量
  过程与参数约束。

## 用户与运维手册

- [快速接入](quickstart.md)、[飞书应用配置](feishu-setup.md)、
  [workspace 设置与迁移](workspace-setup.md)、
  [运行环境变量](environment-variables.md)。
- 后端：[Codex](codex-backend.md)、[Codex 内置资源发现](codex-builtin-support.md)、
  [Pi](pi-backend.md)、[DeepSeek](dsh-backend.md)；交互：[Codex 输入卡片](codex-user-input.md)、
  [静态飞书卡片](static-card-v2.md)。
- 浏览器：[协调与安装](browser-coordination.md)、
  [容器部署](chromium-container.md)、[Linux 部署](chromium-linux-service.md)、
  [配置](chromium-setup.md)和[故障恢复](chromium-service-recovery.md)。
- 其他运维：[日志轮转](log-rotation.md)、[日志转发](log-forwarding.md)、
  [定时任务](schedules.md)、[自动压缩](auto-compaction.md)、
  [GPU 可选配置](gpu-setup.md)和[私有流程](security/private-actions.md)。
- [版本安装、升级与回滚](releases/git-install.md)；
  [0.5.1 服务迁移](migrations/0.5.1-service.md)。

当前发行版：[Disclaude 0.6.0](releases/0.6.0.md)。
