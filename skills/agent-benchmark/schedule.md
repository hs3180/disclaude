---
name: "Agent Framework Benchmark"
cron: "0 6 * * 1"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Agent Benchmark — 定时框架性能评估

每周一 06:00 执行一次 Agent Framework benchmark 分析。

## 执行

使用 `agent-benchmark` skill 分析过去 14 天的聊天记录，对比不同 Agent 框架/模型的表现。

参数：
- **分析范围**: 最近 14 天
- **评估维度**: 任务完成度、用户满意度、错误率、效率、独特能力

## 安装说明

将此文件复制到 `schedules/agent-benchmark/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
