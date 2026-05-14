---
name: pr-review
description: PR Review - fetches PR details and sends a structured review card to the corresponding discussion group. Triggered after pr-scanner creates a group, or manually invoked. Keywords: "PR Review", "review card", "PR 详情", "审查卡片", "send review".
allowed-tools: Read, Bash, send_user_feedback
---

# PR Review — Review Card Sender

获取 PR 详情并发送结构化审查卡片到对应的讨论群。

**适用于**: 发送 PR review 卡片、PR 详情展示 ｜ **不适用于**: 扫描 PR、创建群、解散群

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{repo}` | Yes | — | GitHub repo (owner/name) |
| `{prNumber}` | Yes | — | PR number to review |
| `{chatId}` | No | — | Target chatId (if omitted, looked up from mapping) |

## 执行步骤

### 1. 获取 PR 详情

```bash
gh pr view {prNumber} --repo {repo} --json number,title,author,state,body,headRefName,baseRefName,additions,deletions,changedFiles,commits,url,labels
```

### 2. 获取 PR 文件变更列表

```bash
gh pr diff {prNumber} --repo {repo} --stat
```

提取变更文件名和变更统计。

### 3. 查找目标群 chatId

如果 `{chatId}` 未提供，从映射表查找：

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

查找 key `pr-{prNumber}` 对应的 `chatId`。如果未找到映射，报告错误并退出。

### 4. 发送 Review 卡片

使用 `send_user_feedback` 发送结构化卡片到目标群：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "PR #{number} Review"},
    "template": "blue"
  },
  "elements": [
    {
      "tag": "column_set",
      "flex_mode": "bisect",
      "background_style": "default",
      "columns": [
        {"tag": "column", "width": "weighted", "weight": 1, "vertical_align": "center",
         "elements": [{"tag": "markdown", "content": "**Author**\n{author}"}]},
        {"tag": "column", "width": "weighted", "weight": 1, "vertical_align": "center",
         "elements": [{"tag": "markdown", "content": "**Branch**\n{headRefName} → {baseRefName}"}]}
      ]
    },
    {"tag": "hr"},
    {
      "tag": "markdown",
      "content": "{body_summary}"
    },
    {"tag": "hr"},
    {
      "tag": "column_set",
      "flex_mode": "trisection",
      "background_style": "default",
      "columns": [
        {"tag": "column", "width": "weighted", "weight": 1, "vertical_align": "center",
         "elements": [{"tag": "markdown", "content": "**Files**\n{changedFiles}"}]},
        {"tag": "column", "width": "weighted", "weight": 1, "vertical_align": "center",
         "elements": [{"tag": "markdown", "content": "**+Additions**\n+{additions}"}]},
        {"tag": "column", "width": "weighted", "weight": 1, "vertical_align": "center",
         "elements": [{"tag": "markdown", "content": "**-Deletions**\n-{deletions}"}]}
      ]
    },
    {"tag": "hr"},
    {
      "tag": "markdown",
      "content": "**Changed files:**\n{file_list}"
    },
    {"tag": "hr"},
    {
      "tag": "action",
      "actions": [
        {"tag": "button", "text": {"tag": "plain_text", "content": "View on GitHub"}, "type": "primary", "url": "{pr_url}"},
        {"tag": "button", "text": {"tag": "plain_text", "content": "Approve"}, "type": "primary", "value": "approve_pr_{number}"},
        {"tag": "button", "text": {"tag": "plain_text", "content": "Request Changes"}, "type": "default", "value": "request_changes_{number}"}
      ]
    }
  ]
}
```

#### 字段说明

| 字段 | 来源 | 处理 |
|------|------|------|
| `{number}` | PR JSON | 直接使用 |
| `{author}` | PR JSON `author.login` | 直接使用 |
| `{headRefName}` | PR JSON | 分支名 |
| `{baseRefName}` | PR JSON | 目标分支 |
| `{body_summary}` | PR JSON `body` | 截取前 500 字符，超长则追加 "..." |
| `{changedFiles}` | PR JSON | 变更文件数 |
| `{additions}` | PR JSON | 新增行数 |
| `{deletions}` | PR JSON | 删除行数 |
| `{file_list}` | diff stat | 取前 20 个文件，格式：`- path/to/file.ts (+X/-Y)` |
| `{pr_url}` | PR JSON `url` | GitHub 链接 |
| `{labels}` | PR JSON | 如有 label，在 body 前追加标签行 |

#### Labels 展示

如果 PR 有 labels，在 body_summary 前追加一行：

```
Labels: `bug` `enhancement` `priority:high`
```

### 5. 状态变更通知（可选）

当检测到已有群的 PR 状态发生变更时（如 merged/closed），发送通知卡片：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "PR #{number} {state}"},
    "template": "{state == 'merged' ? 'green' : 'red'}"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "PR #{number} **{title}** has been **{state}**.\n\nThis discussion group can now be dissolved if no longer needed."
    },
    {"tag": "hr"},
    {
      "tag": "action",
      "actions": [
        {"tag": "button", "text": {"tag": "plain_text", "content": "View on GitHub"}, "type": "default", "url": "{pr_url}"},
        {"tag": "button", "text": {"tag": "plain_text", "content": "Dissolve Group"}, "type": "danger", "value": "dissolve_pr_{number}"}
      ]
    }
  ]
}
```

## 错误处理

- `gh pr view` 失败 → 记录错误，跳过
- 映射表中无 chatId → 记录错误，跳过
- `send_user_feedback` 失败 → 记录错误（群已创建，可手动发送）

## 设计原则

1. **只负责发送卡片** — 不扫描、不建群、不解散
2. **幂等操作** — 重复发送同一 PR 的卡片不会造成副作用
3. **可独立调用** — 不依赖 pr-scanner 的执行上下文
4. **映射表驱动** — 通过 BotChatMappingStore 查找 chatId

## 依赖

`gh` CLI · `workspace/bot-chat-mapping.json`（BotChatMappingStore） · `send_user_feedback` MCP tool

## 与 pr-scanner 的关系

- `pr-scanner` 负责扫描 PR、创建讨论群、写入映射表
- `pr-review` 负责发送审查卡片和状态变更通知
- 调度模板应先执行 `pr-scanner` 扫描流程，再对每个新 PR 调用 `pr-review` 发送卡片

## 关联

- Parent: #3383 (PR Review 临时群聊)
- Depends on: pr-scanner skill, BotChatMappingStore (#2947)
