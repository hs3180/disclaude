---
name: pr-scanner
description: PR Scanner - scans a GitHub repository for open PRs, creates review groups for new PRs, performs automated review, and sends review cards. Triggered by schedule or manual invocation. Keywords: "PR Scanner", "扫描 PR", "scan pull requests", "PR review".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# PR Scanner — 映射表驱动的 PR 扫描与审查

扫描仓库的 open PR，为新 PR 创建审查群、执行自动 review、发送审查卡片，并通过映射表追踪已创建的群。

**适用于**: 扫描 PR、创建审查群、自动 review、追踪映射 ｜ **不适用于**: 解散群、merge/close PR

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{repo}` | Yes | — | GitHub repo (owner/name) |
| `{controlChannelChatId}` | Yes | — | Schedule execution context chatId |
| `{maxConcurrent}` | No | `3` | Max concurrent PR review groups |

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
gh pr list --repo {repo} --state open --json number,title,author,headRefName
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

### 5. 新 PR — 创建审查群并 Review

并发检查：映射表中 `purpose: 'pr-review'` 条目数 ≥ `{maxConcurrent}` 则跳过。

对每个新 PR（按 number 升序）：

#### 5a. 创建审查群

```bash
lark-cli im chat create --name "PR #{number} · {title前30字}" --description "PR #{number} 审查讨论群"
```

#### 5b. 写入映射

追加 `pr-{number}` 条目（chatId, createdAt, purpose: "pr-review"），原子写入。

#### 5c. 获取 PR 详细信息

```bash
gh pr view {number} --repo {repo} --json title,body,author,headRefName,baseRefName,mergeable,additions,deletions,changedFiles,labels
```

#### 5d. 获取 PR Diff

```bash
gh pr diff {number} --repo {repo}
```

如果 diff 过大（超过 3000 行），只获取文件列表和统计信息：

```bash
gh pr diff {number} --repo {repo} --stat
```

#### 5e. 生成 Review 摘要

基于 PR 信息和 diff，生成结构化 review 摘要：

**Review 维度**:
1. **变更概要**: 哪些文件被修改，总体变更规模
2. **关键改动**: 核心逻辑变更、新增功能、删除的功能
3. **潜在问题**: 可能的 bug、安全隐患、性能问题
4. **测试覆盖**: 是否包含测试、测试是否充分
5. **代码质量**: 命名、结构、是否有明显的代码异味

**Review 分级**:
- ✅ **Approve**: 变更清晰、测试充分、无重大问题
- ⚠️ **Request Changes**: 存在需要修复的问题
- 💬 **Comment**: 有建议但不阻塞合并

#### 5f. 发送 Review 卡片

使用 `send_interactive` MCP 工具向审查群发送 review 卡片：

```
title: "PR Review #{number}"
context: "repo: {repo}"

question: |
  ## {title}

  👤 {author} · 🌿 {headRef} → {baseRef}
  📊 +{additions} -{deletions} ({changedFiles} files)

  ### Review 结果: {分级}

  **变更概要**: ...
  **关键改动**: ...
  **潜在问题**: ...
  **建议**: ...

  🔗 https://github.com/{repo}/pull/{number}

options:
  - text: "💬 详细审查"
    value: "review-detail-{number}"
  - text: "✅ 看起来不错"
    value: "review-approve-{number}"
  - text: "⏭️ 跳过"
    value: "review-skip-{number}"
```

如果 `send_interactive` 不可用，使用 `send_card` 发送静态卡片。

#### 5g. 向控制频道汇报

向 `{controlChannelChatId}` 发送简要通知：

```
✅ PR #{number} 审查群已创建
- Review: {分级}
- 文件变更: {changedFiles} files (+{additions}/-{deletions})
- 审查群: 已发送 review 卡片
```

## 错误处理

- `gh` 命令失败 → 记录错误，跳过/退出
- 映射文件读取失败 → 视为空表
- 映射文件写入失败 → 记录错误（可通过群名重建）
- 群创建失败 → 跳过该 PR
- Diff 获取失败 → 使用 PR body 作为 review 输入
- 卡片发送失败 → 记录错误，不阻塞后续 PR 处理

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **用户驱动解散** — Bot 不自主解散群
3. **幂等操作** — 映射表过滤防重复创建
4. **无 Label 依赖** — 状态全在映射表
5. **渐进式 Review** — diff 过大时降级为摘要 review
6. **非阻塞卡片** — Review 卡片提供操作按钮，但不自动执行合并/关闭

## 依赖

`gh` CLI · `lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）· MCP send_card/send_interactive 工具

## Schedule 模板

见同目录下的 `schedule.md`。将其复制到 `schedules/pr-scanner/SCHEDULE.md`，替换 `{controlChannelChatId}` 和 `{repo}` 后启用。

## 关联

- Parent: #2945, #3383
- Depends on: #2947 (BotChatMappingStore), #2946 (移除 register_temp_chat)
- Related: #2191 (临时群聊讨论)
