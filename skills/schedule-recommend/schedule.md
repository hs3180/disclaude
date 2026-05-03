---
name: "智能推荐分析"
cron: "0 3 * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# 智能推荐分析 — 定时执行

每天凌晨 3 点分析用户交互记录，发现重复任务模式并推荐定时任务。

## 执行

使用 `schedule-recommend` skill 分析所有聊天的交互记录，识别可自动化的重复任务。

参数：
- **chatId**: {chatId}

### 筛选条件

- 至少出现 3 次的相似请求
- 请求发生在相似的时间段
- 任务适合定时执行（信息检索、报告生成、监控等）

### 不推荐的情况

- 一次性任务
- 需要用户交互的任务
- 依赖上下文的任务
- 需要实时决策的任务

## 安装说明

将此文件复制到 `schedules/recommend-analysis/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的 chatId |
