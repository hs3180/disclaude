---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# PR Scanner - 完整版 (Phase 2)

定期扫描仓库的 open PR，发现新 PR 时创建群聊并发送通知。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **通知目标**: 配置的 chatId（用于错误通知）
- **默认成员**: 新建群聊时邀请的成员列表

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

#### 4.1 获取详细信息

```bash
gh pr view {number} --repo hs3180/disclaude --json title,body,author,state,mergeable,headRefName,baseRefName,commits,files
```

#### 4.2 创建群聊

使用 `create_discussion` 工具为该 PR 创建专属群聊：
- 群聊名称: `PR #{number}: {title}` (如果太长则截断)
- 初始成员: PR 作者 + 默认成员列表

#### 4.3 发送 PR 信息卡片

使用 `send_user_feedback` 发送包含 PR 详细信息的卡片：

```
## PR #{number}: {title}

**作者**: {author}
**分支**: {headRefName} → {baseRefName}
**状态**: {mergeable ? '✅ 可合并' : '⚠️ 有冲突'}
**检查**: {ciStatus}

### 描述
{body}

### 文件变更
{files}

### 操作建议
- 审核代码变更
- 检查 CI 是否通过
- 确认是否有冲突
- 决定是否合并

🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})
```

#### 4.4 更新历史记录

将 PR 编号和对应的 chatId 记录到历史文件中。

### 5. 更新历史文件

将处理过的 PR 编号添加到 `processedPRs` 数组，更新 `lastScan` 时间戳，保存 `prChats` 映射。

## 历史文件结构

```json
{
  "lastScan": "2026-03-04T00:00:00Z",
  "processedPRs": [100, 101, 102],
  "prChats": {
    "100": "oc_xxxx",
    "101": "oc_yyyy"
  }
}
```

## 错误处理

- 如果 `gh` 命令失败：记录错误，发送错误通知到配置的 chatId
- 如果创建群聊失败：回退到只发送通知到配置的 chatId
- 如果历史文件损坏：重置并重新开始
- 如果发送通知失败：记录错误但继续处理其他 PR

## 使用说明

1. 复制此文件到 `workspace/schedules/pr-scanner.md`
2. 替换 `chatId` 为实际的飞书群聊 ID（用于错误通知）
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## 依赖状态

| 依赖 | 状态 | 说明 |
|------|------|------|
| Scheduler 基础设施 | ✅ 已有 | cron 调度 |
| ChatOps | ✅ 已有 | PR #423 已合并 |
| send_user_feedback | ✅ 已有 | 发送卡片通知 |
| FeedbackController | ⏳ 可选 | Phase 3 交互按钮 |

## 未来扩展 (Phase 3)

- 添加交互式操作按钮（合并、关闭、请求修改）
- 支持 PR 状态变更检测（新增评论、CI 完成等）
- 支持自动合并符合条件的 PR
