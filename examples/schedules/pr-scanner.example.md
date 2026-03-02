---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# PR Scanner - Phase 2 (with Group Chat Creation)

定期扫描仓库的 open PR，发现新 PR 时创建专属群聊并发送通知。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **通知目标**: 配置的 chatId（用于错误通知和 fallback）
- **群聊创建**: 为每个新 PR 创建专属讨论群

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
   gh pr view {number} --repo hs3180/disclaude --json number,title,author,state,body,mergeable,statusCheckRollup,url
   ```

2. **创建专属群聊**（使用 `create_discussion_chat` 工具）：
   - 群聊名称: `PR #{number}: {title}` (标题过长时截断)
   - 成员列表: 暂时为空（用户可手动加入）

3. **存储群聊映射**：
   将 `{prNumber: chatId}` 添加到 `prChats` 字段

4. **发送 PR 信息到新群聊**（使用 `send_user_feedback`）：
   ```markdown
   ## PR #{number}: {title}

   **作者**: {author}
   **状态**: {mergeable ? '✅ 可合并' : '⚠️ 有冲突'}
   **CI 检查**: {statusCheckRollup}

   ### 描述
   {body}

   ### 快捷操作
   - 🔗 [查看 PR]({url})

   ---
   💡 这是一个自动化创建的 PR 讨论群。您可以在这里讨论 PR 的内容。
   ```

5. 更新历史记录

### 5. 更新历史文件

将处理过的 PR 编号添加到 `processedPRs` 数组，更新 `lastScan` 时间戳，更新 `prChats` 映射。

## 历史文件结构

```json
{
  "lastScan": "2026-03-02T10:00:00Z",
  "processedPRs": [439, 437, 436],
  "prChats": {
    "439": "oc_xxxx",
    "437": "oc_yyyy"
  }
}
```

## 通知消息模板

### PR 讨论群消息

```
## PR #{number}: {title}

**作者**: {author}
**状态**: {mergeable ? '✅ 可合并' : '⚠️ 有冲突'}
**CI 检查**: {statusCheckRollup}

### 描述
{body}

---

🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})

💡 这是一个自动化创建的 PR 讨论群。
```

### Admin 通知（错误或 fallback）

```
⚠️ PR Scanner 通知

{消息内容}
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知到 admin chat
- 如果群聊创建失败，回退到发送通知到 admin chat
- 如果历史文件损坏，重置并重新开始
- 如果发送通知失败，记录错误但继续处理其他 PR

## 使用说明

1. 复制此文件到 `workspace/schedules/pr-scanner.md`
2. 替换 `chatId` 为实际的飞书群聊 ID（用于 admin 通知）
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## 未来扩展 (Phase 3)

- **交互式操作**: 支持通过按钮执行 PR 操作（合并、关闭等）
- **自动邀请**: 根据 PR 作者和 reviewer 自动邀请成员
- **状态更新**: PR 状态变化时更新群聊消息

## 依赖

- ✅ Scheduler 基础设施
- ✅ `send_user_feedback` 工具
- ✅ `create_discussion_chat` 工具 (Phase 2)
- ⏳ `wait_for_interaction` 工具 (Phase 3)
