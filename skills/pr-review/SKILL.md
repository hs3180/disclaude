---
name: pr-review
description: PR Code Review specialist - reviews a GitHub pull request, analyzes code changes, identifies issues, and sends a structured review card to the associated chat group. Triggered by scheduler after pr-scanner creates a discussion group, or manually invoked. Keywords: "PR Review", "代码审查", "review PR", "PR 代码审查".
allowed-tools: Read, Bash, Glob, Grep, send_user_feedback
---

# PR Review — 映射表驱动的代码审查

对已创建讨论群的 PR 执行代码审查，生成结构化 Review 报告，发送到关联的飞书群聊。

**适用于**: PR 代码审查、发送 Review 报告、检测潜在问题 ｜ **不适用于**: 扫描 PR、创建群、解散群

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{repo}` | Yes | — | GitHub repo (owner/name) |
| `{controlChannelChatId}` | Yes | — | Schedule execution context chatId |
| `{maxReviews}` | No | `3` | Max PR reviews per execution |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" or `**Chat ID for Feishu tools**: oc_xxx`)
- **Message ID**: Message ID (from "**Message ID:** xxx")

## Core Principle

**Read mapping table → Find PRs needing review → Analyze code → Send review card**

The skill identifies PRs that have discussion groups (tracked in `bot-chat-mapping.json`) but haven't been reviewed yet, performs code analysis, and sends a structured review to the associated chat group.

## Data Structures

### 映射文件

`workspace/bot-chat-mapping.json`（BotChatMappingStore）:
- **Key**: `pr-{number}` → `{ chatId, createdAt, purpose: "pr-review" }`

### Review 状态文件

`workspace/pr-review-status.json`（用于追踪哪些 PR 已审查）:
```json
{
  "pr-123": {
    "reviewedAt": "2026-05-08T10:00:00Z",
    "status": "reviewed",
    "headSha": "abc1234"
  }
}
```

状态说明：
- `reviewed`: 已完成审查（当 PR 有新 commit 时自动标记为 `stale`）
- `stale`: PR 有新提交，需要重新审查
- 无条目: 尚未审查

## 执行步骤

### 1. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

提取所有 `purpose: 'pr-review'` 条目，得到 PR number → chatId 映射。

如果映射表为空或没有 pr-review 条目，**直接结束**（无需 review 的 PR）。

### 2. 读取 Review 状态

```bash
cat workspace/pr-review-status.json 2>/dev/null || echo "{}"
```

### 3. 获取 PR 详细信息

对每个映射表中的 PR：

```bash
gh pr view {number} --repo {repo} --json number,title,author,state,headRefName,headRepository,body,additions,deletions,changedFiles,labels,reviews,mergeable,createdAt,updatedAt
```

**过滤条件** — 跳过以下 PR：
- PR state 不是 `OPEN`
- PR 已经被 merge 或 close
- 映射表条目数超过 `{maxReviews}` 限制（按 PR number 升序取前 N 个）

### 4. 检测是否需要 Review

对每个待审查 PR，检查：
1. **是否已审查**: 查 `pr-review-status.json` 中是否有该 PR 条目
2. **是否有新提交**: 比较记录的 `headSha` 与当前 HEAD SHA

```bash
gh pr view {number} --repo {repo} --json headRefName --jq '.headRefName'
# Then get HEAD SHA
gh api repos/{owner}/{repo}/pulls/{number} --jq '.head.sha'
```

**需要 Review 的情况**:
- 状态文件中无该 PR 条目（从未审查）
- 状态为 `stale`（有新提交）
- PR 的 `updatedAt` 在 review 之后

**跳过 Review 的情况**:
- 状态为 `reviewed` 且无新提交

### 5. 执行代码审查

对每个需要 review 的 PR，按以下步骤分析：

#### 5a. 获取 PR Diff

```bash
gh pr diff {number} --repo {repo}
```

如果 diff 太大（超过 5000 行），只审查最近 5 个文件的变更。

#### 5b. 获取变更文件列表

```bash
gh pr diff {number} --repo {repo} --name-only
```

#### 5c. 分析要点

对代码变更进行以下分析：

| 分析维度 | 检查项 |
|----------|--------|
| **代码质量** | 命名规范、代码可读性、函数复杂度 |
| **错误处理** | 异常捕获、边界条件、空值检查 |
| **安全问题** | 注入风险、敏感信息泄露、权限检查 |
| **性能问题** | 不必要的循环、内存泄漏、N+1 查询 |
| **测试覆盖** | 新增代码是否有对应测试 |
| **架构一致性** | 是否符合项目现有架构模式 |

#### 5d. 生成 Review 报告

生成结构化报告，包含以下部分：

1. **PR 概览**: 标题、作者、变更统计
2. **总体评估**: 🔴 需要修改 / 🟡 建议改进 / 🟢 可以合并
3. **关键发现**: 按严重程度排序的问题列表
4. **改进建议**: 具体的修改建议

### 6. 发送 Review 卡片

**CRITICAL**: 必须发送到 **PR 对应的群聊 chatId**（从映射表获取），而非 `{controlChannelChatId}`。

使用 `send_user_feedback` 发送卡片：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "PR Review #{number}"},
    "template": "blue"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**PR #{number}**: {title}\n**Author**: {author}\n**Changes**: +{additions}/-{deletions} in {changedFiles} files\n**Assessment**: {overall_assessment_emoji}"
    },
    {"tag": "hr"},
    {
      "tag": "markdown",
      "content": "### Key Findings\n{findings}"
    },
    {"tag": "hr"},
    {
      "tag": "markdown",
      "content": "### Suggestions\n{suggestions}"
    },
    {"tag": "hr"},
    {
      "tag": "action",
      "actions": [
        {"tag": "button", "text": {"content": "Approve", "tag": "plain_text"}, "value": "approve", "type": "primary"},
        {"tag": "button", "text": {"content": "Request Changes", "tag": "plain_text"}, "value": "request_changes"},
        {"tag": "button", "text": {"content": "View on GitHub", "tag": "plain_text"}, "value": "view_github"}
      ]
    }
  ]
}
```

**卡片中必须使用 PR 对应群聊的 chatId**。

### 7. 更新 Review 状态

审查完成后，更新 `workspace/pr-review-status.json`：

```json
{
  "pr-{number}": {
    "reviewedAt": "{ISO timestamp}",
    "status": "reviewed",
    "headSha": "{current_head_sha}"
  }
}
```

### 8. 发送汇总到控制频道

最后，向 `{controlChannelChatId}` 发送简要汇总：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "PR Review Summary"},
    "template": "green"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**Reviewed**: {count} PRs\n**Skipped**: {skipped} (already reviewed or closed)\n**Details**: {summary_list}"
    }
  ]
}
```

## Error Handling

| Error | Action |
|-------|--------|
| Mapping file missing | Log warning, skip (PR scanner creates mapping) |
| `gh pr view` fails | Log error, skip this PR |
| `gh pr diff` fails | Send error notification to control channel |
| Status file write fails | Log warning (non-critical, can re-review) |
| Card send fails to PR chat | Try control channel as fallback |
| No PRs need review | Send "no pending reviews" to control channel |

## Design Principles

1. **幂等性** — 重复执行不会产生重复 review（状态文件过滤）
2. **映射表是 source of truth** — PR chatId 从映射表获取，不硬编码
3. **增量审查** — 只审查新 PR 或有新提交的 PR
4. **分组发送** — Review 卡片发到 PR 对应的群聊，汇总发到控制频道
5. **安全优先** — 发现安全问题优先标记

## Dependencies

- `gh` CLI — GitHub operations
- `send_user_feedback` — Card sending
- `workspace/bot-chat-mapping.json` — PR-to-chatId mapping (maintained by pr-scanner)
- `workspace/pr-review-status.json` — Review status tracking (maintained by this skill)

## Relationship

- **Upstream**: `pr-scanner` skill creates groups and mappings
- **This skill**: Reviews code and sends review cards
- **Parent Issue**: #3383 (PR Review 临时群聊)
- **Related**: #2191 (临时群聊讨论 v0.4.1)

## Schedule Template

See `schedule.md` in this directory. Combine with `pr-scanner` schedule for full automation:

1. `pr-scanner` runs every 30 min → creates groups for new PRs
2. `pr-review` runs every 30 min (offset by 15 min) → reviews PRs with groups

## DO NOT

- ❌ Create or dissolve groups (use pr-scanner skill)
- ❌ Send review cards to wrong chatId
- ❌ Modify the bot-chat-mapping.json (read-only for this skill)
- ❌ Auto-approve or auto-merge PRs
- ❌ Post review comments directly to GitHub (only send Feishu cards)
- ❌ Skip the review status check (causes duplicate reviews)
