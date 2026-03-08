---
name: "PR Scanner (Serial)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner - 串行扫描模式

定期扫描仓库的 open PR，串行处理，一次只处理一个 PR。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **通知目标**: 配置的 chatId

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

### 6. 发送 PR 信息到群聊

使用 `send_user_feedback` 发送格式化的 PR 信息：

```markdown
## 🔔 新 PR 检测到

**PR #{number}**: {title}

| 属性 | 值 |
|------|-----|
| 👤 作者 | {author} |
| 🌿 分支 | {headRef} → {baseRef} |
| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |
| 🔍 CI 检查 | {ciStatus} |
| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |

### 📋 描述
{description 前500字符}

---
🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})
```

### 7. 添加 pending label

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:pending"
```

### 8. 提供操作选项（交互式卡片）

如果支持交互式卡片，发送操作选项：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "PR 处理决策", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "请选择处理方式："},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 合并", "tag": "plain_text"}, "value": "merge:{number}", "type": "primary"},
      {"tag": "button", "text": {"content": "🔄 请求修改", "tag": "plain_text"}, "value": "request_changes:{number}", "type": "default"},
      {"tag": "button", "text": {"content": "❌ 关闭", "tag": "plain_text"}, "value": "close:{number}", "type": "danger"},
      {"tag": "button", "text": {"content": "⏳ 稍后", "tag": "plain_text"}, "value": "later:{number}", "type": "default"}
    ]}
  ]
}
```

## 状态管理

### Label 定义

| Label | 含义 |
|-------|------|
| `pr-scanner:processed` | 已通过 scanner 处理完成 |
| `pr-scanner:pending` | 正在等待用户反馈 |

### 状态转换

```
新 PR → 添加 pending label → 等待用户反馈 → 执行动作 → 添加 processed label → 移除 pending label
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知
- 如果发送通知失败，记录错误但继续
- 如果添加 label 失败，记录错误但不影响流程

## 注意事项

1. **串行处理**: 一次只处理一个 PR，避免并发问题
2. **无状态设计**: 所有状态通过 GitHub Label 管理，不依赖内存或文件
3. **用户驱动**: 等待用户反馈后才执行动作，不自动合并或关闭

## 依赖

- gh CLI
- GitHub Labels: `pr-scanner:processed`, `pr-scanner:pending`
