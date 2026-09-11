---
name: pr-scanner
description: "PR Scanner - creates a scheduled task to scan a GitHub repository for open PRs and create discussion groups. Use when user wants to set up PR scanning for a repo. Keywords: \"PR Scanner\", \"扫描 PR\", \"scan pull requests\", \"PR review\"."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# PR Scanner — Schedule 安装器

为指定 GitHub 仓库创建 PR 扫描定时任务。将 schedule 模板实例化为可执行的 SCHEDULE.md。

**适用于**: 安装/配置 PR 扫描定时任务 ｜ **不适用于**: 直接执行扫描、发卡片、解散群

> schedule 模板会在映射表中记录 `workdir` 字段（PR 分支的临时目录路径），PR 关闭时自动清理。

## 安装步骤

### 1. 收集参数

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{repo}` | Yes | — | GitHub repo (owner/name) |
| `{controlChannelChatId}` | Yes | — | 控制频道 chatId（当前对话的 chatId） |
| `{maxConcurrent}` | No | `3` | 最大并发 PR 讨论群数 |
| `{cron}` | No | `0 */6 * * *` | 扫描频率（默认每6小时） |

### 2. 实例化 Schedule

将同目录下的 `schedule.template.md` 模板复制到 `schedules/pr-scanner/SCHEDULE.md`，替换所有 `{placeholder}` 为实际值：

```bash
mkdir -p schedules/pr-scanner
cp disclaude/skills/pr-scanner/schedule.template.md schedules/pr-scanner/SCHEDULE.md
```

替换占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
| `{repo}` | 实际监控的 GitHub 仓库（如 `owner/repo`） |
| `{maxConcurrent}` | 并发上限（默认 `3`） |
| `{cron}` | 实际的 cron 表达式（默认 `0 */6 * * *`） |

### 3. 验证

读取生成的 `schedules/pr-scanner/SCHEDULE.md`，确认：
- frontmatter 中无未替换的占位符
- `chatId` 为实际 chatId
- `enabled: true`

## 关联

- Parent: #2945
- Depends on: #2947 (BotChatMappingStore), #2946 (移除 register_temp_chat)
