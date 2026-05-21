---
name: "每日随机测试"
cron: "0 11 * * 1-5"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# 每日随机测试 — 定时执行

工作日每天 11:00 使用 `self-experience` skill 进行随机 dogfooding 测试。

## 执行

使用 `self-experience` skill 随机测试一个功能。

参数：
- **目标群 chatId**: {controlChannelChatId}

### 检查最近测试记录

避免重复测试同一功能：

```bash
cat workspace/self-experience/history.md 2>/dev/null | tail -20 || echo "No history"
```

- 如果最近 3 次测试过同一功能 → 重新随机选择
- 记录本次测试的功能到 history

### 记录测试结果

将测试摘要追加到历史记录：

```bash
mkdir -p workspace/self-experience
echo "- $(date +%Y-%m-%d): 测试了 [功能名] - [一句话结果]" >> workspace/self-experience/history.md
```

## 安装说明

将此文件复制到 `schedules/self-experience/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的聊天群 chatId |
