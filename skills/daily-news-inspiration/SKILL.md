---
name: daily-news-inspiration
description: "Daily news inspiration question generator - browses latest social and tech news, extracts inspiration, and generates natural questions. Use when user asks for news-based questions, daily inspiration, or says keywords like \"新闻灵感\", \"每日提问\", \"时事提问\", \"新闻提问\", \"news inspiration\", \"daily news question\"."
allowed-tools: Read, Write, Glob, Bash, WebSearch
---

# Daily News Inspiration — Schedule 安装器

为指定群组创建每日新闻灵感提问定时任务。将 schedule 模板实例化为可执行的 SCHEDULE.md。

**适用于**: 安装/配置每日新闻灵感提问定时任务 | **不适用于**: 直接执行新闻浏览

## 安装步骤

### 1. 收集参数

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{targetChatId}` | Yes | — | 目标群组 chatId（发送提问的群组） |
| `{cron}` | No | `0 9 * * *` | 执行频率（默认每天上午 9:00） |

### 2. 实例化 Schedule

使用 Glob 找到 skill 目录中的 `schedule.md` 模板，替换占位符后写入 workspace：

```
# 1. 定位模板（使用 Glob 工具搜索）
模板路径: skills/daily-news-inspiration/schedule.md

# 2. 读取模板内容（使用 Read 工具）

# 3. 替换所有占位符
```

| 占位符 | 替换为 |
|--------|--------|
| `{targetChatId}` | 实际的目标群组 chatId |
| `{cron}` | 实际的 cron 表达式（默认 `0 9 * * *`） |

```
# 4. 使用 Write 工具写入目标文件
目标路径: schedules/daily-news-inspiration/SCHEDULE.md
```

### 3. 验证

读取生成的 `schedules/daily-news-inspiration/SCHEDULE.md`，确认：
- frontmatter 中无未替换的占位符
- `chatId` 为实际 chatId
- `enabled: true`

## 关联

- Issue #3765
- 参考: daily-soul-question (`skills/daily-soul-question/`)
