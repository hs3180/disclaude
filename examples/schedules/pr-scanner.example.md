---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# PR Scanner - Phase 1

定期扫描仓库的 open PR，发现新 PR 时发送通知到指定群聊。

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

2. 使用 `send_user_feedback` 发送通知：
   - PR 标题和编号
   - 作者
   - 状态（可合并/有冲突）
   - CI 检查状态
   - 链接

3. 更新历史记录

### 5. 更新历史文件

将处理过的 PR 编号添加到 `processedPRs` 数组，更新 `lastScan` 时间戳。

## 通知消息模板

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

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知
- 如果历史文件损坏，重置并重新开始
- 如果发送通知失败，记录错误但继续处理其他 PR

## 使用说明

1. 复制此文件到 `workspace/schedules/pr-scanner.md`
2. 替换 `chatId` 为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## 未来扩展 (Phase 2 & 3)

- **Phase 2**: 为每个 PR 创建独立群聊（需要 PR #423 ChatOps）
- **Phase 3**: 支持交互式操作按钮（需要 PR #412 FeedbackController）
