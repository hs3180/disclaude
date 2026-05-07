---
name: pr-review
description: "PR Review — scans open PRs, creates review discussion groups with interactive cards, generates review summaries, and tracks PR status changes. Triggered by schedule or manual invocation. Keywords: \"PR Review\", \"review PR\", \"PR 审查\", \"PR 评审\", \"PR 扫描\", \"scan PR\"."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# PR Review — 交互式 PR 审查与通知

扫描仓库的 open PR，为新 PR 创建审查群并发送 Review 卡片（含 Agent 生成的 diff 分析），追踪已有群的 PR 状态变更。

**适用于**: PR 审查、创建审查群、发送 review 卡片、diff 分析、状态变更通知
**不适用于**: 解散群、merge/close PR、代码执行

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{repo}` | Yes | — | GitHub repo (owner/name) |
| `{controlChannelChatId}` | Yes | — | Schedule execution context chatId |
| `{maxConcurrent}` | No | `3` | Max concurrent PR review groups |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx") — used as `{controlChannelChatId}`
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `pr-{number}` → `purposeFromKey()` 推断 purpose
- **群名**: `PR #{number} · {title前30字}` → `parseGroupNameToKey()` 解析 key

## 执行步骤

### 1. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

提取所有 `purpose: 'pr-review'` 条目的 PR number 和 chatId。文件不存在则视为空映射表。

### 2. 获取 Open PR 列表

```bash
gh pr list --repo {repo} --state open \
  --json number,title,author,headRefName,baseRefName,createdAt,updatedAt,additions,deletions,changedFiles,labels
```

### 3. 过滤与分类

将获取到的 PR 分为两类：

- **新 PR**：PR number 不在映射表中（`pr-{number}` key 不存在）
- **已有群的 PR**：PR number 在映射表中存在

### 4. 已有群的 PR — 状态变更检测

```bash
gh pr list --repo {repo} --state merged,closed --json number,state,title,closedAt,mergedBy \
  --jq ".[] | select(.closedAt > \"$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)\")"
```

对于映射表中已有群但 PR 已 merged/closed 的情况，发送状态变更通知卡片到该群。

### 5. 新 PR — 创建审查群 + 发送 Review 卡片

并发检查：映射表中 `purpose: 'pr-review'` 条目数 ≥ `{maxConcurrent}` 则跳过，在控制频道记录跳过原因。

对每个新 PR（按 number 升序）：

**5a. 获取 PR 详情**:

```bash
gh pr view {number} --repo {repo} \
  --json title,body,author,headRefName,baseRefName,additions,deletions,changedFiles,files,labels,url
```

**5b. 获取 PR diff 摘要**（限制行数避免 token 溢出）:

```bash
gh pr diff {number} --repo {repo} | head -300
```

**5c. Agent 分析 Diff**（关键步骤）:

基于 diff 内容，Agent 自主生成以下分析：

1. **Diff Summary**（1-3 句话）: 描述主要变更内容
2. **Review Focus**（2-4 个重点）: 建议审查的重点区域
3. **Risk Assessment**（可选）: 潜在的性能、安全或逻辑风险

**注意**:
- 分析应基于 diff 内容，不运行代码
- 如果 diff 超过 300 行，Agent 应基于已读取部分给出摘要并注明 "部分分析"
- 分析应简洁实用，避免冗长描述

**5d. 创建群**:

```bash
lark-cli im chat create --name "PR #{number} · {title前30字}" --description "PR #{number} 审查讨论群"
```

从输出中提取 chatId。

**5e. 写入映射**:

追加 `pr-{number}` 条目到 `workspace/bot-chat-mapping.json`：

```json
{
  "pr-{number}": {
    "chatId": "{创建的群 chatId}",
    "createdAt": "{ISO timestamp}",
    "purpose": "pr-review"
  }
}
```

使用 Read 工具读取现有文件，解析 JSON，追加条目，Write 工具原子写入。

**5f. 发送 Review 卡片**:

使用 `send_user_feedback` MCP 工具发送交互式卡片到新创建的群。

#### Review 卡片格式

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "🔍 PR Review #{number}"},
    "template": "blue"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**{title}**\n👤 **Author**: @{author}\n🌿 **Branch**: `{headRefName}` → `{baseRefName}`\n📊 **Changes**: +{additions} −{deletions} ({changedFiles} files)\n🏷️ **Labels**: {labels}"
    },
    {"tag": "hr"},
    {
      "tag": "markdown",
      "content": "## 📋 Diff Summary\n{agent-generated summary}"
    },
    {
      "tag": "markdown",
      "content": "## 🎯 Review Focus\n{agent-generated review suggestions}"
    },
    {"tag": "hr"},
    {
      "tag": "action",
      "actions": [
        {
          "tag": "button",
          "text": {"content": "查看 PR", "tag": "plain_text"},
          "type": "primary",
          "url": "{pr_url}"
        },
        {
          "tag": "button",
          "text": {"content": "查看 Diff", "tag": "plain_text"},
          "type": "default",
          "url": "{pr_url}/files"
        }
      ]
    }
  ]
}
```

### 6. 状态变更通知

对于已 merged/closed 的 PR，发送通知到对应群：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "✅ PR #{number} 已{merged/closed}"},
    "template": "green"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**{title}** 已被 {actor} {merged/closed}。\n\n本群可以继续讨论，或手动解散。"
    }
  ]
}
```

---

## 控制频道日志

在控制频道 (`{controlChannelChatId}`) 发送执行摘要：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "📊 PR Review 扫描报告"},
    "template": "blue"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**仓库**: {repo}\n**Open PRs**: {total_count}\n**新建审查群**: {new_count}\n**状态变更通知**: {status_change_count}\n**跳过（并发上限）**: {skipped_count}"
    }
  ]
}
```

---

## 错误处理

- `gh` 命令失败 → 记录错误，跳过/退出
- 映射文件读取失败 → 视为空表
- 映射文件写入失败 → 记录错误（可通过群名重建）
- 群创建失败 → 跳过该 PR
- 卡片发送失败 → 记录错误，不影响映射写入
- Diff 过大 → 截取前 300 行，标注 "部分分析"

---

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **用户驱动解散** — Bot 不自主解散群
3. **幂等操作** — 映射表过滤防重复创建
4. **Agent 自主分析** — Review 内容由 Agent 基于 diff 生成，非硬编码模板
5. **渐进增强** — 当前基于 SKILL.md 指令执行，未来可迁移至 0.4.0 SystemMessage + ChatAgent 架构

## 与 pr-scanner 的区别

| 维度 | pr-scanner (旧) | pr-review (新) |
|------|----------------|----------------|
| **功能** | 仅创建群 | 创建群 + Review 卡片 + 状态通知 |
| **分析** | 无 | Agent 自主分析 diff |
| **通知** | 无 | 状态变更通知到对应群 |
| **控制频道** | 无日志 | 发送扫描报告 |
| **架构兼容** | SCHEDULE.md | SKILL.md（可迁移至 0.4.0 ChatAgent） |

## 依赖

`gh` CLI · `lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）· `send_user_feedback` MCP tool

## Schedule 模板

见同目录下的 `schedule.md`。

## 关联

- Parent: #2191 (临时群聊讨论 v0.4.1)
- Depends on: #3329 (Message RFC 0.4.0)
- Supersedes: pr-scanner skill (旧方案，仅创建群无交互)
- Related: #3383 (PR Review 临时群聊 — 基于 Message + project-bound Agent)
