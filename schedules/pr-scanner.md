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

### 7. 在群聊中发送讨论引导卡片

群聊创建后，使用 `send_message` 发送讨论引导卡片：

**卡片内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "💬 PR 讨论区", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "请在下方进行讨论，讨论结束后点击按钮通知我。"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 讨论结束，请总结结论", "tag": "plain_text"}, "value": "discussion_end", "type": "primary"},
      {"tag": "button", "text": {"content": "⏳ 需要更多时间讨论", "tag": "plain_text"}, "value": "need_more_time", "type": "default"}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "我会分析群聊消息，总结讨论结论，然后执行相应动作。"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "discussion_end": "[讨论结束信号] 用户表示讨论已结束。请执行以下步骤：\n1. 使用 collect_discussion_conclusion 工具获取群聊消息\n2. 分析消息内容，总结讨论结论\n3. 根据结论执行相应动作（merge/request_changes/close/later）\n4. 报告执行结果\n5. 添加 processed label 并移除 pending label",
  "need_more_time": "[用户请求] 用户需要更多时间讨论。请继续等待用户反馈，不要执行任何动作。"
}
```

### 8. 添加 pending label

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:pending"
```

### 9. 根据讨论结论执行动作 ⚡ 关键步骤

当用户点击"讨论结束"按钮后，使用 `collect_discussion_conclusion` 工具获取群聊消息，分析讨论内容，总结结论，然后执行相应动作：

#### 9.1 获取群聊消息

```json
{
  "chatId": "{讨论群聊ID}",
  "maxMessages": 100
}
```

#### 9.2 分析讨论结论

根据消息内容判断用户意图：

| 结论类型 | 关键词 | 执行动作 |
|----------|--------|----------|
| ✅ 合并 | "合并"、"通过"、"approve"、"可以合并" | 执行 merge |
| 🔄 请求修改 | "修改"、"需要改"、"有问题"、"fix" | 添加评论请求修改 |
| ❌ 关闭 | "关闭"、"不要了"、"放弃"、"reject" | 关闭 PR |
| ⏳ 稍后 | "稍后"、"待定"、"下次"、"hold" | 标记为稍后处理 |

#### 9.3 执行动作

**合并 PR**：
```bash
# 先检查 CI 状态
gh pr view {number} --repo hs3180/disclaude --json statusCheckRollup,mergeable

# 如果 CI 通过且无冲突，执行合并
gh pr merge {number} --repo hs3180/disclaude --merge --delete-branch
```

**请求修改**：
```bash
# 询问用户具体需要修改什么
# 然后添加评论
gh pr comment {number} --repo hs3180/disclaude --body "请修改以下内容：\n{用户提供的具体内容}"
```

**关闭 PR**：
```bash
gh pr close {number} --repo hs3180/disclaude --comment "{关闭原因}"
```

**稍后处理**：
```bash
# 不执行任何动作，仅更新 label
gh pr edit {number} --repo hs3180/disclaude --remove-label "pr-scanner:pending"
```

#### 9.4 完成处理

动作执行后：
```bash
# 添加 processed label
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:processed" --remove-label "pr-scanner:pending"

# 发送结果反馈到群聊
# 使用 send_message 工具发送执行结果
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
