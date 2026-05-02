---
name: "Agent Framework 赛马报告"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "{controlChannelChatId}"
---

# Agent Framework 赛马报告 — 每周定时执行

每周一 10:00 执行 Agent Framework 赛马报告，分析过去一周各 Agent 框架的工作质量。

## 执行

使用 `agent-race-report` skill 分析各 chat 的聊天记录，对比不同 Agent 框架的表现。

参数：
- **分析周期**: 最近 7 天
- **评估维度**: 响应效率、任务完成、用户满意度、工具效率、错误韧性
- **特别关注**: 各框架的独特特性（无法赛马的部分）

## 安装说明

将此文件复制到 `schedules/agent-race-report/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的报告输出频道 chatId |
