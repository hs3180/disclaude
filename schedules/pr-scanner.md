---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
createdAt: "2026-03-08T00:00:00.000Z"
---

# PR Scanner

定期扫描仓库的 open PR，发现新 PR 时创建群聊并发送通知。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **通知目标**: 配置的 chatId（Phase 1）或为每个 PR 创建独立群聊（Phase 2）

## 执行步骤

### 1. 获取当前 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open --json number,title,author,updatedAt,mergeable,statusCheckRollup
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
   gh pr view {number} --repo hs3180/disclaude --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
   ```

2. **创建群聊** (Phase 2):
   - 使用 `create_discussion_chat` MCP 工具为该 PR 创建独立群聊
   - 群聊名称: `PR #{number}: {title 前30字符}`
   - 如果创建失败，使用配置的 `chatId` 发送通知

3. 发送 PR 信息通知：
   - PR 标题和编号
   - 作者
   - 分支信息 (head → base)
   - 状态（可合并/有冲突）
   - CI 检查状态
   - 变更统计 (+additions/-deletions, changedFiles files)
   - 链接

4. 更新历史记录

### 5. 更新历史文件

将处理过的 PR 编号添加到 `processedPRs` 数组，更新 `lastScan` 时间戳。

## 通知消息模板

```
🔔 新 PR 检测到

PR #{number}: {title}

👤 作者: {author}
🌿 分支: {headRef} → {baseRef}
📊 状态: {mergeable ? '✅ 可合并' : '⚠️ 有冲突'}
🔍 检查: {ciStatus}
📈 变更: +{additions} -{deletions} ({changedFiles} files)

📋 描述:
{description 前500字符}

🔗 链接: https://github.com/hs3180/disclaude/pull/{number}
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知到 chatId
- 如果历史文件损坏，重置并重新开始
- 如果发送通知失败，记录错误但继续处理其他 PR

## 使用说明

1. 将 `chatId` 替换为实际的飞书群聊 ID（用于接收通知）
2. 设置 `enabled: true`
3. 调度器将自动加载并执行

## 实现状态

| Phase | 功能 | 状态 |
|-------|------|------|
| Phase 1 | 基本扫描 + 通知 | ✅ 可用 |
| Phase 2 | 为每个 PR 创建群聊 | ✅ 可用 |
| Phase 3 | 交互式操作按钮 | ❌ 不计划实现 |

详见: `docs/designs/pr-scanner-design.md`
