---
name: "PR Scanner"
cron: "*/30 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner - 映射表驱动扫描模式

定期扫描仓库的 open PR，基于映射表 `bot-chat-mapping.json` 判断处理状态，为新 PR 创建讨论群聊并发送审查卡片，对已关闭/合并的 PR 发送状态变更通知。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **最大并发 Review 数**: 3
- **映射表文件**: `workspace/bot-chat-mapping.json`

## 执行步骤

### 1. 获取 Open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,headRefName,baseRefName
```

如果命令失败（网络错误、gh 认证过期），**退出本次执行**并发送错误通知到 chatId。

### 2. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

映射表格式：
```json
{
  "pr-123": { "chatId": "oc_xxx", "createdAt": "2026-04-28T10:00:00Z", "purpose": "pr-review" },
  "pr-456": { "chatId": "oc_yyy", "createdAt": "2026-04-28T11:00:00Z", "purpose": "pr-review" }
}
```

如果文件不存在或 JSON 解析失败，视映射表为空 `{}`。

### 3. 分类 PR

将步骤 1 获取的 PR 列表分为两类：

- **新 PR**：PR number 不在映射表中的 PR（即没有 `pr-{number}` 键）
- **已有群 PR**：PR number 在映射表中已有 chatId 的 PR

### 4. 处理已有群 PR — 状态变更检测

对每个**已有群 PR**，检查其当前状态：

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json state,mergedAt,closedAt,title,headRefName,baseRefName
```

#### 4a. PR 已 Merged

如果 `state` 为 `MERGED`：

使用 `send_user_feedback` 向该 PR 的讨论群（映射表中的 chatId）发送合并通知卡片：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "✅ PR #{number} 已合并", "tag": "plain_text"}, "template": "turquoise"},
  "elements": [
    {"tag": "markdown", "content": "**{title}** 已成功合并到 {baseRef} 分支。"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "解散群", "tag": "plain_text"}, "value": "disband", "type": "danger"}
    ]}
  ]
}
```

```json
{
  "disband": "[用户操作] 用户请求解散 PR #{number} 的讨论群。请执行以下步骤：\n1. 从映射表中删除 pr-{number} 条目\n2. 发送解散确认卡片"
}
```

#### 4b. PR 已 Closed（未合并）

如果 `state` 为 `CLOSED` 且非 merged：

使用 `send_user_feedback` 向该 PR 的讨论群发送关闭通知卡片：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "❌ PR #{number} 已关闭", "tag": "plain_text"}, "template": "red"},
  "elements": [
    {"tag": "markdown", "content": "**{title}** 已关闭，未合并。"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "解散群", "tag": "plain_text"}, "value": "disband", "type": "danger"}
    ]}
  ]
}
```

```json
{
  "disband": "[用户操作] 用户请求解散 PR #{number} 的讨论群。请执行以下步骤：\n1. 从映射表中删除 pr-{number} 条目\n2. 发送解散确认卡片"
}
```

#### 4c. PR 仍为 Open

不做任何操作，继续下一个 PR。

### 5. 处理新 PR — 并发控制

检查当前映射表中 `purpose: "pr-review"` 的条目数量：

```bash
# 统计当前活跃的 PR Review 群数量
cat workspace/bot-chat-mapping.json | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  const count = Object.values(data).filter(v => v.purpose === 'pr-review').length;
  console.log(count);
"
```

- 如果活跃 Review 群数量 **≥ 3**：跳过新 PR 处理，本次扫描结束（下次扫描时再处理）
- 如果活跃 Review 群数量 **< 3**：可处理的新 PR 数量 = 3 - 当前活跃数

### 6. 为新 PR 创建讨论群

对每个待处理的新 PR（不超过并发限制），执行以下步骤：

#### 6a. 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

#### 6b. 创建讨论群

使用 `create-pr-group` skill 创建群聊：

```bash
PR_NUMBER={number} \
PR_TITLE="{title}" \
MAPPING_FILE="workspace/bot-chat-mapping.json" \
npx tsx skills/create-pr-group/create-pr-group.ts
```

**成功输出**：脚本会输出 `CHAT_ID=oc_xxxxx`，从中提取 chatId。

**失败处理**：
- 如果脚本退出码非 0，记录错误日志，跳过该 PR，继续处理下一个
- 不影响其他 PR 的处理流程

#### 6c. 发送 PR 详情卡片

群聊创建成功后，使用 `send_user_feedback` 向新创建的群聊发送 PR 详情卡片：

先获取 PR diff 生成变更摘要：
```bash
gh pr diff {number} --repo hs3180/disclaude
```

然后基于 PR 信息生成变更摘要，并发送卡片：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔍 PR Review #{number}", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "📝 **标题**: {title}\n👤 **作者**: @{author}\n🔀 **分支**: {headRef} → {baseRef}\n📏 **变更**: +{additions} -{deletions} ({changedFiles} files)"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "**📊 CI 检查**: {ciStatus}\n**合并状态**: {mergeable ? '✅ 可合并' : '⚠️ 有冲突'}"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "📋 **变更摘要**:\n{agent 根据 gh pr diff 生成的变更摘要}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve", "type": "primary"},
      {"tag": "button", "text": {"content": "💬 Review", "tag": "plain_text"}, "value": "deep_review", "type": "default"},
      {"tag": "button", "text": {"content": "❌ Close", "tag": "plain_text"}, "value": "close", "type": "danger"}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "🔗 查看完整 PR: https://github.com/hs3180/disclaude/pull/{number}"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "approve": "[用户操作] 用户批准 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr review {number} --repo hs3180/disclaude --approve --body 'Approved via PR Scanner'`\n2. 更新映射表中 pr-{number} 的状态为 reviewed\n3. 发送确认消息到当前群聊",
  "deep_review": "[用户操作] 用户请求深度 Review PR #{number}。请执行以下步骤：\n1. 执行 `gh pr diff {number} --repo hs3180/disclaude` 获取完整 diff\n2. 分析代码质量、潜在问题、测试覆盖\n3. 将 Review 结果以结构化形式发回讨论群\n4. 不要执行任何 PR 操作，仅提供分析报告",
  "close": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude`\n2. 从映射表中删除 pr-{number} 条目\n3. 发送解散确认卡片到当前群聊"
}
```

### 7. 解散确认卡片（供 actionPrompts 中 disbanded 后使用）

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "👋 讨论结束", "tag": "plain_text"}, "template": "grey"},
  "elements": [
    {"tag": "markdown", "content": "PR #{number} 的讨论已结束，本群将在超时后自动解散。\n\n感谢参与讨论！"},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "映射表条目已清理，群聊将在超时后由系统自动解散。"}
    ]}
  ]
}
```

## 完整扫描流程图

```
┌──────────────────────────────────────────────────┐
│  1. gh pr list → 获取所有 Open PR                  │
└────────────────────────┬─────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────┐
│  2. 读取 bot-chat-mapping.json                    │
└────────────────────────┬─────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────┐
│  3. 分类：新 PR vs 已有群 PR                        │
└────────┬───────────────────────────┬─────────────┘
         │                           │
         ▼                           ▼
┌────────────────────┐  ┌──────────────────────────┐
│ 4. 已有群 PR：      │  │ 5. 新 PR：               │
│    检查 PR 状态     │  │    检查并发限制 (≤3)     │
│    → merged: 通知   │  │                          │
│    → closed: 通知   │  └────────────┬─────────────┘
│    → open: 跳过     │               │
└────────────────────┘               ▼
                         ┌──────────────────────────┐
                         │ 6. 为新 PR 创建讨论群：    │
                         │    a. 获取 PR 详情        │
                         │    b. create-pr-group     │
                         │    c. 发送 PR 详情卡片    │
                         └──────────────────────────┘
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `gh` 命令失败（网络/认证） | 退出本次执行，不发送通知 |
| 映射表文件不存在 | 视为空映射表 `{}`，正常执行 |
| 映射表 JSON 解析失败 | 记录警告，视为空映射表 |
| `create-pr-group` 脚本失败 | 跳过该 PR，继续处理其他 PR |
| `send_user_feedback` 失败 | 记录错误日志，继续处理其他 PR |
| lark-cli 不可用 | 脚本会自行报错，按脚本失败处理 |

## 注意事项

1. **映射表驱动**: 所有状态通过 `bot-chat-mapping.json` 管理，不再使用 GitHub Label
2. **并发控制**: 最多同时 review 3 个 PR（通过映射表中 `purpose=pr-review` 的条目数判断）
3. **幂等设计**: `create-pr-group` 脚本内置幂等性，重复执行不会重复创建群
4. **用户驱动**: 所有群操作（关闭、解散）必须用户主动触发，Bot 不自主解散群
5. **状态自愈**: 映射表丢失后可通过 `lark-cli im chats list --as bot` + 群名规则重建
6. **卡片占位符**: 模板中的 `{number}`, `{title}` 等占位符需在运行时替换为实际 PR 数据。`{ciStatus}` 应根据 `statusCheckRollup` 生成对应的 ✅/❌ 状态。变更摘要由 Agent 调用 `gh pr diff` 后总结生成，不要直接输出原始 diff

## 依赖

- `gh` CLI（GitHub CLI，已认证）
- `lark-cli`（飞书 CLI 工具）
- `create-pr-group` skill（`skills/create-pr-group/create-pr-group.ts`）
- `bot-chat-mapping.json`（映射表，位于 `workspace/bot-chat-mapping.json`）
- MCP Tool: `send_user_feedback`（发送消息到飞书群聊）
