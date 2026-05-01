---
name: "Agent 赛马报告"
cron: "0 9 * * 1"
enabled: true
blocking: true
chatId: "{chatId}"
---

# Agent 赛马报告 — 定时分析

每周一 09:00 执行一次 Agent Performance 分析。

## 执行

使用 `agent-race-report` skill 分析过去 7 天的 Agent 表现。

参数：
- **分析范围**: 最近 7 天
- **评估维度**: 效率、完成率、满意度、错误恢复、工具使用

## 安装说明

将此文件复制到 `schedules/agent-race-report/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{chatId}` | 实际的报告接收 chatId |

## 关联

- Issue: #1334
