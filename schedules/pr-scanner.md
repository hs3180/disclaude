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

### 6. 创建群聊讨论 PR

使用 `start_group_discussion` 工具为该 PR 创建专门的讨论群聊：

```json
{
  "topic": "PR #{number} 讨论: {title}",
  "members": [],
  "context": "## 🔔 新 PR 检测到\n\n**PR #{number}**: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 🔍 CI 检查 | {ciStatus} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n### 📋 描述\n{description 前300字符}\n\n---\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})",
  "timeout": 60
}
```

**注意**：
- `members` 留空，表示只邀请当前用户
- 群聊名称格式：`PR #{number} 讨论: {PR标题}`
- 讨论超时：60 分钟

### 7. 添加 pending label

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:pending"
```

### 8. 在群聊中发送讨论引导消息

群聊创建后，使用 `send_message` 发送讨论引导消息：

**消息内容**：
```
## 🎯 讨论指南

请针对这个 PR 进行讨论，讨论完成后请明确说明你的决定：

- **✅ 合并**: 说"合并吧"、"可以合并"等
- **🔄 请求修改**: 说明需要修改的内容
- **❌ 关闭**: 说"关闭吧"、"不需要了"等
- **⏳ 稍后**: 说"稍后处理"、"先放着"等

讨论完成后，Agent 会分析聊天记录，提取你的决定并执行相应操作。
```

### 9. 等待并分析群聊结论 ⚡ 核心逻辑 (Issue #1152)

**重要**: 这是 #1152 的核心实现 - 通过总结群聊结论来决定动作，而不是按钮点击。

当用户在群聊中表示讨论完成时（如说"就这样吧"、"决定了"、"执行吧"等），你需要：

1. **分析聊天记录**: 回顾群聊中的所有讨论内容
2. **提取用户意图**: 判断用户最终的决定是什么
3. **执行相应动作**:

| 用户意图 | 执行命令 |
|----------|----------|
| ✅ 合并 | `gh pr merge {number} --repo hs3180/disclaude --merge --delete-branch` |
| 🔄 请求修改 | `gh pr comment {number} --repo hs3180/disclaude --body "{修改内容}"` |
| ❌ 关闭 | `gh pr close {number} --repo hs3180/disclaude` |
| ⏳ 稍后 | 移除 pending label，不执行其他操作 |

4. **更新 Label**: 执行动作后，添加 `pr-scanner:processed` label 并移除 `pr-scanner:pending` label

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:processed" --remove-label "pr-scanner:pending"
```

5. **报告结果**: 在群聊中报告执行结果

## 状态管理

### Label 定义

| Label | 含义 |
|-------|------|
| `pr-scanner:processed` | 已通过 scanner 处理完成 |
| `pr-scanner:pending` | 正在等待用户反馈 |

### 状态转换

```
新 PR → 创建讨论群聊 → 添加 pending label → 等待群聊讨论结论 → 分析结论并执行动作 → 添加 processed label → 移除 pending label
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
5. **结论分析**: Agent 分析聊天记录提取用户意图，而不是简单的按钮点击

## 依赖

- gh CLI
- GitHub Labels: `pr-scanner:processed`, `pr-scanner:pending`
- MCP Tool: `start_group_discussion` (Issue #1155)
