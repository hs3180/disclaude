---
name: "Task Progress Reporter"
cron: "0 */2 * * * *"
enabled: false
blocking: false
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Task Progress Reporter

独立汇报 Agent - 定期检查活跃任务状态，智能决定是否向用户报告进度。

## 设计理念

这不是固定间隔的报告器。每次触发时，Agent 会：
1. 检查所有活跃任务（通过 task-context.md 文件）
2. 使用智能判断决定是否有值得报告的内容
3. 仅在有重要更新时发送进度报告

## 执行步骤

### 1. 查找活跃任务

使用 Glob 工具查找所有 task context 文件：

```
tasks/*/task-context.md
```

### 2. 阅读任务状态

对每个找到的 task-context.md 文件：
- 读取 YAML frontmatter 中的 `phase` 字段
- 跳过已完成的任务（`phase: completed` 或 `phase: failed`）
- 记录当前状态用于对比判断

### 3. 智能判断是否报告

**必须报告**:
- 任务刚启动（新发现的任务）
- 任务已完成或失败（首次检测到终端状态）
- 发生错误
- 阶段变更（如 `executing` → `evaluating`）

**判断性报告**:
- 进度增长 ≥ 20%
- 新里程碑完成

**不报告**:
- 无显著变化
- 已报告过的状态

### 4. 发送报告

如果决定报告，使用 `send_user_feedback` 工具：

```
send_user_feedback({
  format: "text",
  content: "📊 进度更新...\n\n任务: xxx\n状态: executing\n进度: 50%",
  chatId: "oc_xxx"  // 从 task-context.md 的 chat_id 字段获取
})
```

## 报告格式

### 进行中

```
📊 任务进度更新

**任务**: Fix authentication bug
**状态**: executing | 迭代: 2/10
**进度**: ████████░░░░░░░░░░░░ 40%
**已用时间**: 5m 30s | **预计剩余**: 8m 15s
**当前活动**: Implementing OAuth flow

✅ Requirements analysis
✅ Code changes
⬜ Unit tests
⬜ Integration tests
```

### 已完成

```
✅ 任务完成

**任务**: Fix authentication bug
**总用时**: 12m 45s
**迭代次数**: 3

All tests passing, fix verified.
```

### 已失败

```
❌ 任务失败

**任务**: Fix authentication bug
**失败原因**: Unable to resolve merge conflict
**已用时间**: 8m 20s
```

## 注意事项

1. **不修改文件**: 此 Agent 只读取 task-context.md，不修改
2. **智能报告**: 不是每次触发都发送消息
3. **无状态**: 所有状态通过文件系统管理
4. **频率**: 默认每 2 分钟检查一次（可根据需要调整 cron）

## 依赖

- task-context.md 文件（由 TaskContext 模块创建）
- MCP Tool: `send_user_feedback`

## 相关

- Issue #857: feat: 复杂任务自动启动 Task Agent 并提供 ETA 和进度报告
