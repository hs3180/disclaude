---
name: issue-solver
description: Issue Solver - creates a scheduled task to scan a GitHub repo for open issues, pick the best candidate, and submit a fix PR. Use when user wants to set up automated issue resolution. Keywords: "Issue Solver", "自动修 Bug", "solve issues", "issue solver", "issue solver 安装".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Issue Solver — Schedule 安装器

为指定 GitHub 仓库创建 Issue 扫描定时任务。将 schedule 模板实例化为可执行的 SCHEDULE.md。

**适用于**: 安装/配置 Issue Solver 定时任务 | **不适用于**: 直接执行扫描、提交 PR

## 安装步骤

### 1. 收集参数

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{repo}` | Yes | — | GitHub repo (owner/name) |
| `{controlChannelChatId}` | Yes | — | 控制频道 chatId（当前对话的 chatId） |
| `{cron}` | No | `0 */2 * * *` | 扫描频率（默认每2小时） |

### 2. 实例化 Schedule

将同目录下的 `schedule.md` 模板复制到 `schedules/issue-solver/SCHEDULE.md`，替换所有 `{placeholder}` 为实际值：

```bash
mkdir -p schedules/issue-solver
cp skills/issue-solver/schedule.md schedules/issue-solver/SCHEDULE.md
```

替换占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
| `{repo}` | 实际监控的 GitHub 仓库（如 `owner/repo`） |
| `{cron}` | 实际的 cron 表达式（默认 `0 */2 * * *`） |

### 3. 验证

读取生成的 `schedules/issue-solver/SCHEDULE.md`，确认：
- frontmatter 中无未替换的占位符
- `chatId` 为实际 chatId
- `enabled: true`

## 工具脚本

`scan.mjs` 是 skill 附带的扫描脚本，负责：
- 检查 `.runtime-env` 中的 GH_TOKEN 是否有效，过期则自动刷新
- 扫描 open issues，过滤掉已有 PR、skip 标签、评论中已解决的 issue
- 按评分排序，输出 top N 候选 issue

脚本位置：`skills/issue-solver/scan.mjs`

## 关联

- Parent: #2945
- 参考: PR Scanner (`skills/pr-scanner/`)
- Issue: #3891
