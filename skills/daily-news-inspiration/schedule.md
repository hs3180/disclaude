---
name: "每日新闻灵感提问"
cron: "0 9 * * *"
enabled: true
blocking: true
chatId: "{targetChatId}"
---

# 每日新闻灵感提问 — 定时执行

每天上午 9:00 使用 `daily-news-inspiration` skill 浏览最新新闻，生成灵感提问。

## 执行

使用 `daily-news-inspiration` skill 浏览新闻并生成提问。

参数：
- **目标群 chatId**: {targetChatId}

### 执行前检查

执行前先检查今天是否已经发送过新闻提问：

```bash
cat workspace/chat/{chatId}.md 2>/dev/null | tail -100 || echo "No chat history"
```

- 如果今天已有新闻灵感提问 → 跳过（避免重复）
- 如果群内最近 2 小时内有超过 10 条消息 → 跳过（群组已活跃，不打扰）

### 主题轮换

按星期偏好不同新闻类型：

| 星期 | 偏好类型 |
|------|----------|
| 周一 | 科技前沿 / AI 动态 |
| 周二 | 社会热点 / 政策趋势 |
| 周三 | 产品发布 / 行业变化 |
| 周四 | 开源动态 / 技术社区 |
| 周五 | 轻松话题 / 跨界创新 |

## 安装说明

将此文件复制到 `schedules/daily-news-inspiration/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{targetChatId}` | 实际的目标群组 chatId |
