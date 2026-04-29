---
name: pr-scanner
description: PR Scanner - scans a GitHub repository for open PRs, creates discussion groups for new PRs, and tracks PR-to-chatId mappings. Triggered by schedule or manual invocation. Keywords: "PR Scanner", "扫描 PR", "scan pull requests", "PR review".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# PR Scanner — 映射表驱动扫描

扫描指定仓库的 open PR，通过映射表追踪已创建的讨论群，为新 PR 创建讨论群并写入映射，对已合并/已关闭 PR 检测状态变更。

## When to Use This Skill

**✅ Use this skill for:**
- Scanning open PRs in a GitHub repository
- Creating discussion groups for new PRs
- Tracking PR-to-chatId mappings via BotChatMappingStore

**❌ DO NOT use this skill for:**
- Sending interactive cards → Use `send_interactive` directly
- Disbanding groups → Use `disband-group` skill
- PR review / merge / close → Execute `gh` commands directly

**Keywords**: "PR Scanner", "扫描 PR", "scan PR", "PR review group"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Parameters

This skill accepts the following parameters (passed via schedule frontmatter or invocation context):

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `{repo}` | Yes | GitHub repository (owner/name) | `hs3180/disclaude` |
| `{controlChannelChatId}` | Yes | Chat ID for schedule execution context | `oc_xxx` |
| `{maxConcurrent}` | No | Max concurrent PR reviews (default: 3) | `3` |

## 配置

- **并发上限**: 最多同时 review `{maxConcurrent}` 个 PR（通过映射表中 `purpose: 'pr-review'` 的条目数判断，默认 3）

## 核心数据结构

映射文件路径: `workspace/bot-chat-mapping.json`（由 `BotChatMappingStore` 管理）

```json
{
  "pr-123": { "chatId": "oc_xxx", "createdAt": "2026-04-28T10:00:00Z", "purpose": "pr-review" },
  "pr-456": { "chatId": "oc_yyy", "createdAt": "2026-04-28T11:00:00Z", "purpose": "pr-review" }
}
```

- **Key 格式**: `pr-{number}`（可通过 `purposeFromKey()` 推断 purpose）
- **群名格式**: `PR #{number} · {title前30字}`（可通过 `parseGroupNameToKey()` 解析 key）

## 执行步骤

### 1. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

解析映射表中所有 `purpose: 'pr-review'` 的条目，提取已有的 PR number 列表和对应的 chatId。

**如果没有映射文件或文件为空**，视为空映射表（首次运行场景）。

### 2. 获取 Open PR 列表

```bash
gh pr list --repo {repo} --state open \
  --json number,title,author,headRefName
```

### 3. 过滤与分类

将获取到的 PR 分为两类：

- **新 PR**：PR number 不在映射表中（`pr-{number}` key 不存在）
- **已有群的 PR**：PR number 在映射表中存在

### 4. 处理已有群的 PR — 状态变更检测

对映射表中已有群的 PR，检查 PR 是否已关闭/已合并：

```bash
# 获取已关闭/已合并的 PR
gh pr list --repo {repo} --state closed \
  --json number,state
```

**如果 PR 已 merged**：记录日志，无需额外操作。解散必须由用户主动触发。

**如果 PR 已 closed (not merged)**：记录日志，无需额外操作。解散必须由用户主动触发。

**如果 PR 仍 open**：跳过，无需操作。

### 5. 处理新 PR — 创建讨论群

**并发检查**：统计映射表中 `purpose: 'pr-review'` 的条目数，如果 ≥ `{maxConcurrent}`，跳过新 PR 创建，下一轮扫描再处理。

对每个新 PR（按 number 升序）：

#### 5a. 创建讨论群

使用 `lark-cli` 创建群聊：

```bash
lark-cli im chat create \
  --name "PR #{number} · {title前30字}" \
  --description "PR #{number} 审查讨论群"
```

从返回结果中提取 `chatId`。

**如果创建失败**：记录错误，跳过此 PR，继续处理下一个。

#### 5b. 写入映射表

将新映射条目写入 `workspace/bot-chat-mapping.json`：

```json
{
  "pr-{number}": {
    "chatId": "{新建群的chatId}",
    "createdAt": "{ISO时间戳}",
    "purpose": "pr-review"
  }
}
```

**注意**：保留映射表中已有的所有条目，仅追加新条目。使用原子写入（先写临时文件再重命名）。

## 错误处理

| 场景 | 处理 |
|------|------|
| `gh pr list` 失败 | 记录错误，退出本次执行 |
| `gh pr view` 失败 | 跳过该 PR，继续处理下一个 |
| 映射文件读取失败 | 视为空映射表 |
| 映射文件写入失败 | 记录错误，群已创建但映射丢失（可通过群名重建） |
| 群创建失败 | 记录错误，跳过该 PR |

## 设计原则

1. **映射表是缓存**：所有数据可从飞书 API 重建（`lark-cli im chats list --as bot` + 群名规则匹配）
2. **用户驱动解散**：Bot 不自主解散群，所有解散操作必须由用户主动触发
3. **幂等操作**：重复扫描不会重复创建群（通过映射表过滤）
4. **无 GitHub Label 依赖**：所有状态通过映射表管理

## 依赖

- `gh` CLI — GitHub PR 操作
- `lark-cli` — 飞书群聊创建
- `workspace/bot-chat-mapping.json` — PR↔群映射表（BotChatMappingStore 格式）

## Schedule 模板

将以下内容安装到 `schedules/pr-scanner/SCHEDULE.md` 以启用定时扫描：

```markdown
---
name: "PR Scanner"
cron: "*/30 * * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# PR Scanner — 定时扫描

每 30 分钟执行一次 PR Scanner skill。

## 执行

使用 `pr-scanner` skill 扫描仓库 `{repo}` 的 open PR。

参数：
- **仓库**: {repo}
- **并发上限**: 3
```

安装前需要替换：
- `{controlChannelChatId}` → 实际的控制频道 chatId
- `{repo}` → 实际监控的 GitHub 仓库

## 关联

- Parent: #2945
- Depends on: #2947 (BotChatMappingStore), #2946 (移除 register_temp_chat)
