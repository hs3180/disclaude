---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# PR Scanner - Phase 2

定期扫描仓库的 open PR，为每个新 PR 创建独立的讨论群聊。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **模式**: 为每个 PR 创建独立群聊

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

其中 `prChats` 字段记录 PR 编号到群聊 ID 的映射：
```json
{
  "prChats": {
    "123": "oc_xxx",
    "456": "oc_yyy"
  }
}
```

### 3. 识别新 PR

对比当前 open PR 与历史记录，找出新增的 PR。

### 4. 处理每个新 PR

对于每个新 PR：

#### 4.1 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude --json title,author,body,state,mergeable,mergeStateStatus,statusCheckRollup
```

#### 4.2 创建讨论群聊

使用 `create_group_chat` 工具创建专属讨论群：

```json
{
  "topic": "PR #{number}: {title}",
  "members": ["{author_open_id}"]
}
```

记录返回的 `chatId` 到 `prChats` 映射中。

#### 4.3 发送 PR 信息到群聊

使用 `send_user_feedback` 发送 PR 详情卡片：

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"tag": "plain_text", "content": "PR #{number}"},
      "template": "{mergeable ? 'blue' : 'orange'}"
    },
    "elements": [
      {"tag": "div", "text": {"tag": "lark_md", "content": "**{title}**"}},
      {"tag": "hr"},
      {"tag": "div", "text": {"tag": "lark_md", "content": "👤 作者: {author}\n📊 状态: {mergeable ? '✅ 可合并' : '⚠️ 有冲突'}\n🔍 检查: {ciStatus}"}},
      {"tag": "hr"},
      {"tag": "div", "text": {"tag": "lark_md", "content": "📋 **描述:**\n{description}"}},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"tag": "plain_text", "content": "查看 PR"}, "url": "https://github.com/hs3180/disclaude/pull/{number}", "type": "primary"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{created_chat_id}"
}
```

### 5. 更新历史文件

将处理过的 PR 编号添加到 `processedPRs` 数组，更新 `prChats` 映射和 `lastScan` 时间戳。

## 示例输出

```
✅ PR #784 检测到
✅ 创建讨论群: PR #784: fix(logger): 修正日志分割结构
   群聊 ID: oc_abc123
✅ PR 信息已发送到群聊

✅ PR #783 检测到
✅ 创建讨论群: PR #783: feat(expert): 专家注册
   群聊 ID: oc_def456
✅ PR 信息已发送到群聊
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知到主群聊
- 如果历史文件损坏，重置并重新开始
- 如果创建群聊失败，记录错误并回退到发送通知到主群聊
- 如果发送到群聊失败，记录错误但继续处理其他 PR

## 使用说明

1. 复制此文件到 `workspace/schedules/pr-scanner.md`
2. 替换 `chatId` 为实际的飞书群聊 ID（用于错误通知）
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## 功能对比

| 特性 | Phase 1 | Phase 2 (当前) |
|------|---------|----------------|
| 通知方式 | 单一群聊通知 | 每PR独立群聊 |
| 讨论隔离 | ❌ | ✅ |
| 作者邀请 | ❌ | ✅ 自动邀请 |
| 群聊管理 | 不需要 | 自动创建和记录 |

## 未来扩展 (Phase 3)

- **Phase 3**: 支持交互式操作按钮（合并、关闭、请求修改）
- **Phase 4**: PR 关闭/合并后自动解散讨论群
