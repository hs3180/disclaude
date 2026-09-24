# 文档索引

docs/ 只保留当前仍适用的设计契约、实现边界、安装迁移和运维指南。发布候选、
一次性验收输出、已取代方案和调研过程不再作为仓库文档长期保存；需要追溯时查看
对应的 Git 历史、Issue 或 PR。

## 当前设计与契约

- [Empty-turn session reset/replay](designs/empty-turn-session-reset-design.md)：当前已实现的空响应恢复边界。
- [REST IPC](designs/rest-ipc-design.md)：当前内部 HTTP 通信契约。
- [Skill format](skill-format-spec.md)：CLI Skill 的输入、输出、产物和生命周期契约。
- [Browser coordination](browser-coordination.md)：Agent 使用私有 IPC 协调浏览器的边界。
- [CardKit streaming](feishu-cardkit-rate-limit-methodology.md)：流式卡片节流的测量与参数约束。
- [Group-management E2E](group-management-e2e.md)：默认关闭、显式启用的群聊测试设计。

Research 沿用现有 Project 的工作目录约束；不要再创建独立的 Research workspace、
任务数据库、固定阶段或仪表盘。Feishu 文档和聊天是研究交互的主要界面，具体反馈
才使用卡片。

## 当前使用指南

安装、配置、浏览器服务、后端、日志、调度、环境变量和安全说明按主题分布在本目录；
README.md 和各主题文档是入口。涉及真实验收时，文档中的测试命令只说明边界，
不能把跳过、模拟或历史结果当作产品通过。
