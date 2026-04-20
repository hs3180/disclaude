---
name: "PR Scanner v2"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — Schedule Prompt

定期扫描仓库的 open PR，发现新 PR 后创建状态文件、发送交互卡片、添加 GitHub Label。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行**: 3 个 reviewing 状态
- **状态超时**: 48 小时
- **状态目录**: `.temp-chats/`

## 前置依赖

- `gh` CLI（已认证）
- `npx tsx`（运行 scanner.ts）
- GitHub Label: `pr-scanner:reviewing`（需预创建）

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

**判断**: 如果 `available` 为 0，说明已有 3 个 PR 在 reviewing，**退出本次执行**。

### Step 2: 发现待审 PR

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates
```

**判断**: 如果返回空数组，说明没有新的 PR 需要处理，**退出本次执行**。

取候选列表的**第一个** PR 作为处理对象。记录其 `number`。

### Step 3: 获取 PR 详情

```bash
gh pr view {number} --repo hs3180/disclaude --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

### Step 4: 群创建（Phase 2 回退方案）

**Phase 1**: 不创建群聊，直接在当前 chatId 中发送卡片。

> Phase 2 将通过 `lark-cli im +chat-create` 创建独立讨论群，并更新状态文件的 `chatId` 字段。

### Step 5: 写入状态文件

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state --pr {number}
```

**判断**: 如果报错 "already exists"，说明该 PR 已被处理过，**跳过并选下一个候选**。

### Step 6: 发送 PR 详情 + 操作卡片

使用 `send_interactive` 发送以下卡片：

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "PR #{number} 待审查", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "**{title}**\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n### 📋 描述\n{description 前300字符}\n\n---\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve", "type": "primary"},
        {"tag": "button", "text": {"content": "❌ Request Changes", "tag": "plain_text"}, "value": "request_changes"},
        {"tag": "button", "text": {"content": "🔄 Close PR", "tag": "plain_text"}, "value": "close_pr"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{chatId}",
  "actionPrompts": {
    "approve": "[用户操作] 用户批准 PR #{number}。请执行以下步骤：\n1. `gh pr review {number} --repo hs3180/disclaude --approve` — 批准 PR\n2. `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved` — 更新状态\n3. `npx tsx schedules/pr-scanner/scanner.ts --action remove-label --pr {number}` — 移除 reviewing label\n4. 报告执行结果",
    "request_changes": "[用户操作] 用户请求修改 PR #{number}。请执行以下步骤：\n1. 询问用户需要修改的具体内容\n2. 使用 `gh pr review {number} --repo hs3180/disclaude --request-changes -b \"{用户的修改意见}\"` 添加 review\n3. 注意：不改变状态文件（state 保持 reviewing）",
    "close_pr": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. `gh pr close {number} --repo hs3180/disclaude` — 关闭 PR\n2. `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed` — 更新状态\n3. `npx tsx schedules/pr-scanner/scanner.ts --action remove-label --pr {number}` — 移除 reviewing label\n4. 报告执行结果"
  }
}
```

### Step 7: 添加 GitHub Label（兜底）

```bash
npx tsx schedules/pr-scanner/scanner.ts --action add-label --pr {number}
```

Label 操作失败**不阻塞**主流程，仅记录警告。

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `available` 为 0 | 退出本次执行，等待下次扫描 |
| 无候选 PR | 退出本次执行 |
| `create-state` 报已存在 | 跳过该 PR，选下一个候选 |
| `gh pr view` 失败 | 记录错误，跳过该 PR |
| Label 操作失败 | 记录警告，不阻塞 |
| `send_interactive` 失败 | 回退到纯文本消息 |

## 状态管理

### 状态文件

存储在 `.temp-chats/pr-{number}.json`，Schema 见 scanner.ts。

### Label 定义

| Label | 含义 | 何时添加 | 何时移除 |
|-------|------|----------|----------|
| `pr-scanner:reviewing` | 正在被 PR Scanner 跟踪 | `create-state` 后 | `mark` 到 approved/closed 后 |

### 状态转换

```
新 PR → check-capacity → list-candidates → gh pr view → create-state → send_interactive → add-label
                                                                                          ↓
                                                                                 [等待用户操作]
                                                                                          ↓
Approve → gh pr review --approve + mark approved + remove-label
Close   → gh pr close + mark closed + remove-label
Changes → gh pr review --request-changes（state 不变，保持 reviewing）
```

## 不包含

- 讨论群生命周期管理（Sub-Issue C / #2221）
- 群创建（Phase 2 实现）
- 文件锁（Sub-Issue D）

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts)
- Design: §3.2, §3.4
