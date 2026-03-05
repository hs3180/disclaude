---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# PR Scanner - Phase 1 & 2

定期扫描仓库的 open PR，发现新 PR 时发送通知并支持交互式处理。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **通知目标**: 配置的 chatId

## 执行步骤

### 1. 获取当前 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open --json number,title,author,updatedAt
```

### 2. 读取历史记录

读取 `workspace/pr-scanner-history.json` 文件，获取已处理的 PR 列表。

如果文件不存在，创建初始结构：
```json
{
  "lastScan": "",
  "processedPRs": [],
  "prChats": {}
}
```

### 3. 识别新 PR

对比当前 open PR 与历史记录，找出新增的 PR。

### 4. 处理每个新 PR

对于每个新 PR：

1. 获取详细信息：
   ```bash
   gh pr view {number} --repo hs3180/disclaude
   ```

2. 使用 `send_user_feedback` 发送带交互按钮的卡片（Phase 2）

3. 使用 `wait_for_interaction` 等待用户操作（Phase 2）

4. 根据用户选择执行操作（Phase 2）

5. 更新历史记录

### 5. 更新历史文件

将处理过的 PR 编号添加到 `processedPRs` 数组，更新 `lastScan` 时间戳。

## Phase 1: 通知模式（基本）

仅发送通知，无交互：

```
🔔 新 PR 检测到

PR #{number}: {title}

👤 作者: {author}
📊 状态: {mergeable ? '✅ 可合并' : '⚠️ 有冲突'}
🔍 检查: {ciStatus}

📋 描述:
{description}

🔗 链接: https://github.com/hs3180/disclaude/pull/{number}
```

## Phase 2: 交互模式（Human-in-the-Loop）

使用 `send_user_feedback` 发送带按钮的卡片，然后使用 `wait_for_interaction` 等待用户操作：

### 2.1 发送交互式卡片

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"tag": "plain_text", "content": "🔔 新 PR 检测到"},
      "template": "blue"
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**PR #{number}: {title}**\n\n👤 作者: {author}\n📊 状态: {status}\n🔍 检查: {ciStatus}\n\n[查看 PR](https://github.com/hs3180/disclaude/pull/{number})"
        }
      },
      {
        "tag": "action",
        "actions": [
          {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "✅ 合并"},
            "type": "primary",
            "value": "merge_{number}"
          },
          {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "💬 评论"},
            "type": "default",
            "value": "comment_{number}"
          },
          {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "⏳ 稍后"},
            "type": "default",
            "value": "later_{number}"
          },
          {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "❌ 关闭"},
            "type": "danger",
            "value": "close_{number}"
          }
        ]
      }
    ]
  },
  "format": "card",
  "chatId": "当前聊天的 chatId"
}
```

**重要**: 记录返回的 `messageId`，用于后续的 `wait_for_interaction` 调用。

### 2.2 等待用户交互

```json
{
  "messageId": "发送卡片后返回的消息 ID",
  "chatId": "当前聊天的 chatId",
  "timeoutSeconds": 300
}
```

### 2.3 根据用户选择执行操作

`wait_for_interaction` 返回的 `actionValue` 格式为 `{action}_{pr_number}`，解析后执行对应操作：

| actionValue | 操作 |
|-------------|------|
| `merge_{number}` | 合并 PR |
| `comment_{number}` | 请求用户输入评论内容 |
| `later_{number}` | 跳过，稍后处理 |
| `close_{number}` | 关闭 PR |

### 2.4 更新卡片状态（可选）

操作完成后，使用 `update_card` 更新卡片显示结果：

```json
{
  "messageId": "卡片消息 ID",
  "card": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"tag": "plain_text", "content": "✅ PR 已处理"},
      "template": "green"
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**PR #{number}** 已被 {action}\n\n处理人: {userId}"
        }
      }
    ]
  },
  "chatId": "当前聊天的 chatId"
}
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知
- 如果历史文件损坏，重置并重新开始
- 如果发送通知失败，记录错误但继续处理其他 PR
- 如果 `wait_for_interaction` 超时，记录并跳过该 PR

## 使用说明

1. 复制此文件到 `workspace/schedules/pr-scanner.md`
2. 替换 `chatId` 为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## 实现状态

| Phase | 功能 | 状态 |
|-------|------|------|
| Phase 1 | 基本扫描 + 通知 | ✅ 可用 |
| Phase 2 | 交互式操作按钮 | ✅ 可用 (Issue #532 已实现) |
| Phase 3 | 为每个 PR 创建独立群聊 | ⏳ 需要 ChatOps API |
