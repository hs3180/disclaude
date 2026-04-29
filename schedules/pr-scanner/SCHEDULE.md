---
name: "PR Scanner (Serial)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner - 串行扫描模式

定期扫描仓库的 open PR，串行处理，为每个 PR 创建讨论群聊。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **讨论超时**: 60 分钟

## 执行步骤

### 1. 检查是否有正在处理的 PR

**重要**: 由于 schedule 是无状态的，需要通过 GitHub Label 判断当前状态。

```bash
# 检查是否有带 pr-scanner:pending label 的 PR
gh pr list --repo hs3180/disclaude --state open \
  --label "pr-scanner:pending" \
  --json number,title
```

如果返回结果不为空，说明有 PR 正在等待用户反馈，**退出本次执行**。

### 2. 获取 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,labels,mergeable,statusCheckRollup,updatedAt
```

### 3. 过滤已处理的 PR

排除以下 PR：
- 已有 `pr-scanner:processed` label 的 PR
- 已被 review/approve 的 PR（暂不处理）

### 4. 选择第一个未处理的 PR

取过滤后的第一个 PR 作为处理对象。

### 5. 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

### 6. 创建群聊讨论 PR ⚡ 核心改动

使用 `start_group_discussion` 工具为该 PR 创建专门的讨论群聊：

```json
{
  "topic": "PR #{number} 讨论: {title}",
  "members": [],
  "context": "## 🔔 新 PR 检测到\n\n**PR #{number}**: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 🔍 CI 检查 | {ciStatus} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n### 📋 描述\n{description 前300字符}\n\n---\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})\n\n请在群聊中讨论后决定处理方式。",
  "timeout": 60
}
```

**注意**：
- `members` 留空，表示只邀请当前用户
- 群聊名称格式：`PR #{number} 讨论: {PR标题}`
- 讨论超时：60 分钟

### 7. 在群聊中发送 PR 详情交互卡片

群聊创建后，使用 `send_message` 发送 PR 详情卡片（含操作按钮）。

**卡片内容**（format: "card"）：
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
  "approve": "[用户操作] 用户批准 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr review {number} --repo hs3180/disclaude --approve --body 'Approved via PR Scanner'`\n2. 更新映射表状态为 reviewed\n3. 发送确认消息到当前群聊\n4. 添加 processed label 并移除 pending label",
  "deep_review": "[用户操作] 用户请求深度 Review PR #{number}。请执行以下步骤：\n1. 执行 `gh pr diff {number} --repo hs3180/disclaude` 获取完整 diff\n2. 分析代码质量、潜在问题、测试覆盖\n3. 将 Review 结果以结构化形式发回讨论群\n4. 不要执行任何 PR 操作，仅提供分析报告",
  "close": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude`\n2. 更新映射表\n3. 发送解散提示卡片到当前群聊"
}
```

### 7.1 PR 状态变更通知卡片（可选）

当检测到 PR 已 merged 或 closed 时，发送状态变更通知卡片：

**Merged 通知卡片**：
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

**Closed 通知卡片**：
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

**状态变更 actionPrompts**：
```json
{
  "disband": "[用户操作] 用户请求解散 PR #{number} 的讨论群。请执行以下步骤：\n1. 从映射表中删除 pr-{number} 条目\n2. 发送解散确认卡片\n3. 添加 processed label 并移除 pending label"
}
```

### 7.2 解散确认卡片

用户点击解散群按钮后发送的确认卡片：

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

> **注意**: 卡片模板中的 `{number}`, `{title}` 等占位符需在运行时替换为实际 PR 数据。`{ciStatus}` 应根据 `statusCheckRollup` 生成对应的 ✅/❌ 状态。`变更摘要` 由 Agent 调用 `gh pr diff` 后总结生成，不要直接输出原始 diff。

### 8. 添加 pending label

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:pending"
```

## 状态管理

### Label 定义

| Label | 含义 |
|-------|------|
| `pr-scanner:processed` | 已通过 scanner 处理完成 |
| `pr-scanner:pending` | 正在等待用户反馈 |

### 状态转换

```
新 PR → 创建讨论群聊 → 添加 pending label → 等待群聊讨论结论 → 执行动作 → 添加 processed label → 移除 pending label
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知
- 如果创建群聊失败，回退到在固定 chatId 中发送消息
- 如果添加 label 失败，记录错误但不影响流程

## 注意事项

1. **群聊讨论**: 为每个 PR 创建独立群聊，便于深入讨论
2. **串行处理**: 一次只处理一个 PR，避免并发问题
3. **无状态设计**: 所有状态通过 GitHub Label 管理，不依赖内存或文件
4. **用户驱动**: 等待群聊讨论结论后才执行动作，不自动合并或关闭

## 依赖

- gh CLI
- GitHub Labels: `pr-scanner:processed`, `pr-scanner:pending`
- MCP Tool: `start_group_discussion` (Issue #1155)
