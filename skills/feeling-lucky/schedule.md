---
name: "每日随机测试"
cron: "0 14 * * 1-5"
enabled: true
blocking: true
chatId: "{targetChatId}"
---

# 每日随机测试 — 定时执行

工作日每天 14:00 使用 `feeling-lucky` skill 进行随机 dogfooding 测试。

## 执行

使用 `feeling-lucky` skill 随机选择一个真实用例来测试。

参数：
- **目标群 chatId**: {targetChatId}

### 执行前检查

避免重复测试同一功能：

```bash
cat workspace/feeling-lucky/history.md 2>/dev/null | tail -10 || echo "No history"
```

- 如果最近 3 次测试过同一功能 → 选择下一个场景
- 记录本次测试的功能到 history

### 记录测试结果

将测试摘要追加到历史记录：

```bash
mkdir -p workspace/feeling-lucky
echo "- $(date +%Y-%m-%d): 测试了 [功能名] - [一句话结果]" >> workspace/feeling-lucky/history.md
```

## 安装说明

将此文件复制到 `schedules/feeling-lucky/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{targetChatId}` | 实际的目标群组 chatId |
