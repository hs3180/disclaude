---
name: pr-review
description: PR Review - scans a GitHub repo for open PRs, creates temporary review groups for new PRs, performs code review, and sends interactive review cards. Triggered by schedule or manual invocation. Keywords: "PR Review", "代码审查", "review PR", "PR 审查", "code review".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# PR Review — 映射表驱动的临时群聊代码审查

扫描仓库的 open PR，为新 PR 创建临时审查群聊，执行代码审查并发送 review 卡片。对已有群的 PR 检测状态变更并通知。

**适用于**: PR 代码审查、创建审查群聊、发送 review 卡片、跟踪 PR 状态
**不适用于**: 解散群、merge/close PR

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

- **新 PR**: PR number 不在映射表中（`pr-{number}` key 不存在）
- **已有群的 PR**: PR number 在映射表中存在

### 4. 已有群的 PR — 状态变更检测

```bash
gh pr list --repo {repo} --state closed --json number,state
```

merged/closed → 记录日志，不自动解散。open → 跳过。

### 5. 新 PR — 创建审查群聊 + 代码审查

并发检查：映射表中 `purpose: 'pr-review'` 条目数 ≥ `{maxConcurrent}` 则跳过新 PR 创建。

对每个新 PR（按 number 升序）：

**5a. 创建群**:
```bash
lark-cli im chat create --name "PR #{number} · {title前30字}" --description "PR #{number} 审查讨论群"
```

**5b. 写入映射**: 追加 `pr-{number}` 条目（chatId, createdAt, purpose: "pr-review"），原子写入。

**5c. 获取 PR 详情**:
```bash
gh pr view {number} --repo {repo} --json title,body,author,additions,deletions,changedFiles,files,commits
gh pr diff {number} --repo {repo}
```

**5d. 执行代码审查**:

分析 PR 的变更内容，从以下维度评估：

- **代码质量**: 命名规范、可读性、代码结构
- **潜在 Bug**: 边界条件、空指针、类型安全
- **安全性**: 输入验证、注入风险、敏感信息泄露
- **性能**: 不必要的循环、内存泄漏、N+1 查询
- **测试覆盖**: 是否有对应的测试变更
- **API 设计**: 接口一致性、向后兼容性

**5e. 发送 Review 卡片**:

使用 `mcp__channel-mcp__send_card` 向新创建的群发送 review 卡片：

```json
{
  "card": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"content": "PR #{number} Review", "tag": "plain_text"},
      "template": "{review_color}"
    },
    "elements": [
      {"tag": "markdown", "content": "**{title}**\nAuthor: @{author} | +{additions}/-{deletions} | {changedFiles} files"},
      {"tag": "hr"},
      {"tag": "markdown", "content": "## Review Summary\n{review_summary}"},
      {"tag": "hr"},
      {"tag": "markdown", "content": "## Key Findings\n{findings_list}"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "View on GitHub", "tag": "plain_text"}, "value": "view_pr", "type": "primary"},
        {"tag": "button", "text": {"content": "Request Changes", "tag": "plain_text"}, "value": "request_changes", "type": "danger"}
      ]}
    ]
  },
  "chatId": "{pr_group_chatId}"
}
```

**Review 颜色规则**:
- 有严重问题 (security/critical bug) → `red`
- 有一般问题 (code quality/performance) → `orange`
- 无明显问题 → `green`

**5f. 发送详细评论**:

如果 diff 较大，拆分为多条消息发送关键文件的分析结果。重点关注：
- 变更量最大的文件
- 核心业务逻辑文件
- API/接口变更文件

### 6. 已有群 — 状态变更通知

对映射表中已有群的 PR：
```bash
gh pr view {number} --repo {repo} --json state,mergedAt,closedAt
```

如果状态从 open 变为 closed/merged：
```json
{
  "card": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"content": "PR #{number} Status Changed", "tag": "plain_text"},
      "template": "blue"
    },
    "elements": [
      {"tag": "markdown", "content": "PR #{number} `{title}` 已被 **{state}**"}
    ]
  },
  "chatId": "{pr_group_chatId}"
}
```

## Review 输出格式

每条 review 评论应包含：

### 结构化摘要
- **总体评估**: 1-2 句话概述 PR 质量
- **风险等级**: 高/中/低
- **建议**: Approve / Request Changes / Comment

### 发现列表
每条发现包含：
- **文件**: 文件路径
- **行号**: 相关行范围
- **类型**: bug / security / performance / style / suggestion
- **描述**: 问题描述
- **建议**: 修复建议

## 错误处理

- `gh` 命令失败 → 记录错误，跳过该 PR
- 映射文件读取失败 → 视为空表
- 映射文件写入失败 → 记录错误（可通过群名重建）
- 群创建失败 → 跳过该 PR
- Review 卡片发送失败 → 记录错误，不影响映射写入
- Diff 过大（>5000 行）→ 仅审查核心文件，摘要说明

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **用户驱动解散** — Bot 不自主解散群
3. **幂等操作** — 映射表过滤防重复创建
4. **CLAUDE.md 驱动行为** — Agent 行为由 SKILL.md 定义，不硬编码
5. **渐进式 review** — 先发摘要卡片，用户可追问详情
6. **Review 质量优先** — 重点关注安全性和正确性，风格建议次之

## 依赖

`gh` CLI · `lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## Schedule 模板

见同目录下的 `schedule.md`。将其复制到 `schedules/pr-review/SCHEDULE.md`，替换 `{controlChannelChatId}` 和 `{repo}` 后启用。

## 与 pr-scanner 的关系

本 skill 是 `pr-scanner` 的升级版，增加了：
- 代码审查能力（分析 diff、评估质量）
- 结构化 review 卡片（交互式、可点击）
- 状态变更通知
- 详细发现列表

当 `pr-scanner` schedule 迁移到 `pr-review` 后，可停用旧的 pr-scanner schedule。

## 关联

- Parent: #2191 (0.4.1 临时群聊)
- Parent: #3383 (PR Review 临时群聊)
- Depends on: BotChatMappingStore (#2947)
- Supersedes: pr-scanner skill (旧方案，仅扫描不审查)
