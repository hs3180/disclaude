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
| `{instanceId}` | No | — | 实例标识（建议用目标仓库名，如 `disclaude`）。提供后路径用 `schedules/issue-solver-<id>/`，**支持同一 skill 实例化多个 schedule**（多仓库/多频道监控，互不覆盖，#4180）。留空则用默认单实例路径 `schedules/issue-solver/`。 |

### 2. 实例化 Schedule

使用 Glob 找到 skill 目录中的 `schedule.template.md` 模板，替换占位符后写入 workspace：

```
# 1. 定位模板（使用 Glob 工具搜索）
模板路径: skills/issue-solver/schedule.template.md

# 2. 读取模板内容（使用 Read 工具）

# 3. 替换所有占位符
```

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
| `{repo}` | 实际监控的 GitHub 仓库（如 `owner/repo`） |
| `{cron}` | 实际的 cron 表达式（默认 `0 */2 * * *`） |
| `{scheduleDir}` | 实例目录名：留空 `{instanceId}` 时为 `issue-solver`（默认单实例，向后兼容）；提供 `{instanceId}` 时为 `issue-solver-<instanceId>` |

**多实例支持（#4180）**：若需为不同仓库/频道各跑一份 Issue Solver，提供 `{instanceId}`（建议用目标仓库名，如 `disclaude`），则 `{scheduleDir}` = `issue-solver-disclaude`，目标路径变为 `schedules/issue-solver-disclaude/SCHEDULE.md`。多份实例互不覆盖（运行时按子目录名区分任务）。留空 `{instanceId}` 则维持默认单实例路径，行为不变。

```
# 4. 使用 Write 工具写入目标文件
目标路径: schedules/{scheduleDir}/SCHEDULE.md

# 5. 把 scan.mjs 复制到实例目录（模板第一步引用的就是 schedules/{scheduleDir}/scan.mjs）
cp skills/issue-solver/scan.mjs schedules/{scheduleDir}/scan.mjs
```

### 3. 验证

读取生成的 `schedules/{scheduleDir}/SCHEDULE.md`，确认：
- frontmatter 中无未替换的占位符
- `chatId` 为实际 chatId
- `enabled: true`

## 工具脚本

`scan.mjs` 是 skill 附带的扫描脚本，负责：
- 检查 `.runtime-env` 中的 GH_TOKEN 是否有效，过期则自动刷新
- 通过 GraphQL 一次性获取 issues + PRs + comments
- 过滤掉已有 PR 的 issue，输出候选列表（含完整 issue body 和评论）

脚本位置：`skills/issue-solver/scan.mjs`

## 关联

- Parent: #2945
- 参考: PR Scanner (`skills/pr-scanner/`)
- Issue: #3891
