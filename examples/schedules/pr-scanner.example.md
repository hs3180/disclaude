---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# PR Scanner - Phase 2 (群聊创建版)

定期扫描仓库的 open PR，发现新 PR 时**为每个 PR 创建独立群聊**进行讨论。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **功能**: Phase 2 - 为每个新 PR 创建独立群聊

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
   gh pr view {number} --repo hs3180/disclaude --json number,title,body,state,author,headRefName,baseRefName,mergeable,mergeStateStatus,statusCheckRollup
   ```

2. **创建群聊**（使用 `create_group` MCP 工具）：
   - 群聊名称: `PR #{number}: {title}`
   - 如果有作者信息，可以邀请作者加入

   示例调用：
   ```json
   {
     "topic": "PR #123: Add new feature",
     "members": ["ou_author_id"]
   }
   ```

3. 使用 `send_user_feedback` 在新群聊中发送 PR 详细信息：
   - PR 标题和编号
   - 作者
   - 状态（可合并/有冲突）
   - CI 检查状态
   - 链接
   - PR 描述摘要

4. 更新历史记录：
   - 将 PR 编号添加到 `processedPRs`
   - 记录群聊 ID 到 `prChats` 映射

### 5. 更新历史文件

将处理过的 PR 编号添加到 `processedPRs` 数组，更新 `lastScan` 时间戳，保存 `prChats` 映射。

## 群聊消息模板

```
📋 **新 PR 待讨论**

**PR #{number}: {title}**

👤 作者: {author}
🌿 分支: {headRefName} → {baseRefName}
📊 状态: {mergeable ? '✅ 可合并' : '⚠️ 有冲突'}
🔍 检查: {ciStatus}

📝 描述:
{description}

🔗 链接: https://github.com/hs3180/disclaude/pull/{number}

---
请在此群聊中讨论该 PR 的处理方式。
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知到主群聊
- 如果历史文件损坏，重置并重新开始
- 如果创建群聊失败，回退到仅在主群聊发送通知
- 如果发送消息失败，记录错误但继续处理其他 PR

## 使用说明

1. 复制此文件到 `workspace/schedules/pr-scanner.md`
2. 替换 `chatId` 为实际的飞书群聊 ID（用于错误通知）
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## 依赖

- ✅ Scheduler 基础设施
- ✅ `create_group` MCP 工具（Issue #393）
- ✅ Feishu 群聊创建 API
- ✅ PR 状态持久化（workspace/pr-scanner-history.json）

## 未来扩展 (Phase 3)

- **Phase 3**: 支持交互式操作按钮（需要 FeedbackController）
  - 一键合并按钮
  - 请求修改按钮
  - 关闭 PR 按钮

## 相关

- Issue #393: 定时扫描 PR 并创建讨论群聊
- Issue #357: 定时任务基础设施
- Issue #402: ChatOps 群聊管理
