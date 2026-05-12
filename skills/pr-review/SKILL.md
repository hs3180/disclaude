---
name: pr-review
description: PR Review - scans open PRs, creates discussion groups for new PRs, performs code review, and sends review cards. Triggered by schedule or manual invocation. Keywords: "PR Review", "代码审查", "review PR", "PR 评审".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# PR Review — 映射表驱动的 PR 审查

扫描仓库的 open PR，通过映射表追踪已创建的讨论群，为新 PR 创建群并执行代码审查，发送审查摘要卡片。

**适用于**: 扫描 PR、创建讨论群、执行代码审查、发送审查卡片、追踪映射 ｜ **不适用于**: 解散群、merge/close PR

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{repo}` | Yes | — | GitHub repo (owner/name) |
| `{controlChannelChatId}` | Yes | — | Schedule execution context chatId |
| `{maxConcurrent}` | No | `3` | Max concurrent PR reviews |

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
gh pr list --repo {repo} --state open --json number,title,author,headRefName,updatedAt,additions,deletions,changedFiles
```

### 3. 过滤与分类

将获取到的 PR 分为两类：

- **新 PR**：PR number 不在映射表中（`pr-{number}` key 不存在）
- **已有群的 PR**：PR number 在映射表中存在

### 4. 已有群的 PR — 状态变更检测

```bash
gh pr list --repo {repo} --state closed --json number,state
```

merged/closed → 记录日志，不自动解散。open → 跳过。

### 5. 新 PR — 创建讨论群 + 执行审查

并发检查：映射表中 `purpose: 'pr-review'` 条目数 ≥ `{maxConcurrent}` 则跳过。

对每个新 PR（按 number 升序）：

#### 5a. 创建群

```bash
lark-cli im chat create --name "PR #{number} · {title前30字}" --description "PR #{number} 审查讨论群"
```

#### 5b. 写入映射

追加 `pr-{number}` 条目（chatId, createdAt, purpose: "pr-review"），原子写入。

#### 5c. 获取 PR 详情

```bash
gh pr view {number} --repo {repo} --json title,body,author,headRefName,baseRefName,additions,deletions,changedFiles,mergeable,labels,reviews,statusCheckRollup
```

#### 5d. 获取 PR Diff

```bash
gh pr diff {number} --repo {repo}
```

如果 diff 过大（超过 3000 行），只获取文件列表和统计：

```bash
gh pr diff {number} --repo {repo} --name-only
```

#### 5e. 执行代码审查

基于获取的 PR 详情和 diff，执行以下审查：

**审查维度**:

| 维度 | 检查项 |
|------|--------|
| **正确性** | 逻辑错误、边界条件、null/undefined 处理 |
| **安全性** | SQL 注入、XSS、命令注入、敏感信息泄露 |
| **性能** | N+1 查询、不必要的循环、内存泄漏 |
| **可维护性** | 命名规范、函数长度、重复代码 |
| **测试覆盖** | 是否有对应测试、测试是否充分 |
| **兼容性** | 破坏性变更、接口兼容、依赖升级风险 |

**审查结果格式**:

```
## PR #{number} 审查摘要

### 基本信息
- **标题**: {title}
- **作者**: {author}
- **分支**: {headRefName} → {baseRefName}
- **变更**: +{additions} / -{deletions} ({changedFiles} files)

### 变更概要
{1-2 句话总结 PR 的核心变更}

### 审查结论: {APPROVE / REQUEST_CHANGES / COMMENT}

### 发现的问题
| # | 严重度 | 文件 | 描述 |
|---|--------|------|------|
| 1 | 🔴 高 | file.ts:42 | 具体问题描述 |
| 2 | 🟡 中 | file.ts:100 | 具体问题描述 |
| 3 | 🟢 低 | file.ts:15 | 具体问题描述 |

### 建议
- 建议1
- 建议2
```

#### 5f. 发送审查卡片

使用 `mcp__channel-mcp__send_card` 将审查结果发送到 PR 对应的讨论群（5a 创建的群 chatId）。

卡片格式:

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"content": "PR #{number} 代码审查", "tag": "plain_text"},
    "template": "{APPROVE=green|REQUEST_CHANGES=red|COMMENT=blue}"
  },
  "elements": [
    {"tag": "markdown", "content": "**{title}**\n{author} · {headRefName} → {baseRefName}\n+{additions} / -{deletions} ({changedFiles} files)"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "**变更概要**: {summary}"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "**审查结论**: {conclusion}\n\n{issues_table}"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "**建议**:\n{suggestions}"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "查看 PR", "tag": "plain_text"}, "url": "https://github.com/{repo}/pull/{number}", "type": "primary"},
      {"tag": "button", "text": {"content": "Approve", "tag": "plain_text"}, "value": "approve-{number}", "type": "primary"},
      {"tag": "button", "text": {"content": "Request Changes", "tag": "plain_text"}, "value": "request-changes-{number}", "type": "danger"}
    ]}
  ]
}
```

#### 5g. 发送控制频道通知

使用 `mcp__channel-mcp__send_card` 向 `{controlChannelChatId}` 发送简要通知：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"content": "新 PR 审查完成", "tag": "plain_text"},
    "template": "turquoise"
  },
  "elements": [
    {"tag": "markdown", "content": "PR [#{number}]({pr_url}) *{title}* — 审查结论: **{conclusion}**\n讨论群已创建，{issues_count} 个问题已发现。"}
  ]
}
```

## 错误处理

- `gh` 命令失败 → 记录错误，跳过/退出
- 映射文件读取失败 → 视为空表
- 映射文件写入失败 → 记录错误（可通过群名重建）
- 群创建失败 → 跳过该 PR
- Diff 获取失败 → 仅基于 PR metadata 生成简要审查
- 卡片发送失败 → 记录错误，不影响映射写入

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **用户驱动解散** — Bot 不自主解散群
3. **幂等操作** — 映射表过滤防重复创建
4. **审查可降级** — diff 获取失败时仍提供基本审查
5. **渐进式增强** — 当前使用 SCHEDULE.md 驱动，未来可迁移到 NonUserMessage + project-bound ChatAgent 架构（Issue #3383）

## 依赖

`gh` CLI · `lark-cli` · `mcp__channel-mcp__send_card` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## Schedule 模板

见同目录下的 `schedule.md`。将其复制到 `schedules/pr-review/SCHEDULE.md`，替换 `{controlChannelChatId}` 和 `{repo}` 后启用。

## 关联

- Parent: #3383 (PR Review 临时群聊)
- Depends on: #2947 (BotChatMappingStore)
- Related: #2191 (临时群聊讨论), #393 (PR Scanner 设计)
- Evolves: `pr-scanner` skill（群创建 → 群创建 + 代码审查 + 卡片发送）
