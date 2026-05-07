---
name: "智能推荐分析"
cron: "0 3 * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# 智能定时任务推荐分析 — 定时执行

每天凌晨 3 点使用 `schedule-recommend` skill 分析用户交互记录，发现重复任务模式并推荐定时任务。

## 执行

使用 `schedule-recommend` skill 分析交互模式并生成推荐。

参数：
- **目标群 chatId**: {controlChannelChatId}

### 获取聊天记录

```bash
ls workspace/chat/*.md 2>/dev/null || echo "No chat files found"
```

如果 `workspace/chat/` 目录不存在或为空，跳过本次执行。

### 分析与推荐

对每个聊天记录分析过去 30 天的交互，识别：
- **重复性任务**: 至少出现 3 次的相似请求
- **时间模式**: 任务通常在什么时间被请求
- **任务特征**: 是否适合自动化（自包含、有明确成功标准、可独立运行）

### 记录分析结果

将结果追加到 `workspace/data/recommend-history.json`，避免重复推荐相同模式。

## 安装说明

将此文件复制到 `schedules/recommend-analysis/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
