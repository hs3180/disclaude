---
name: "Deep Task Scanner"
cron: "*/30 * * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Deep Task Scanner

定期扫描 `workspace/tasks/` 目录，发现待处理任务并执行。

## 背景

替代原有的 `TaskFileWatcher` + `ReflectionController` + `TaskFlowOrchestrator` 复杂架构。
使用现有 Scheduler 机制实现更简单的任务扫描和执行。

## 配置

- **扫描间隔**: 每 30 秒
- **任务目录**: `workspace/tasks/`
- **通知目标**: 配置的 chatId

## 任务状态判断

通过文件存在性判断任务状态：

| 状态 | 判断条件 |
|------|---------|
| **pending** | `task.md` ✓ 且 `final_result.md` ✗ 且 `running.lock` ✗ 且 `failed.md` ✗ |
| **running** | `running.lock` ✓ |
| **completed** | `final_result.md` ✓ |
| **failed** | `failed.md` ✓ 或 迭代次数 ≥ maxIterations |

## 执行步骤

### 1. 扫描 tasks/ 目录

```bash
ls -d workspace/tasks/*/ 2>/dev/null
```

列出所有包含 `task.md` 的子目录。

### 2. 过滤待处理任务

对每个任务目录，检查状态文件：

- 如果存在 `final_result.md` → 跳过（已完成 ✅）
- 如果存在 `running.lock` → 跳过（执行中 🔄）
- 如果存在 `failed.md` → 跳过（已失败 ❌）
- 否则 → 加入待处理队列

### 3. 选择任务

- 读取 `task.md` 的 frontmatter 获取 `priority` 字段
- 按 priority 排序（高优先级优先）
- 选择优先级最高的任务

### 4. 执行任务

1. 创建 `running.lock` 文件
2. 读取 `task.md` 了解任务需求
3. 分析当前任务状态（检查 `iterations/` 目录下的历史迭代）
4. 调用 evaluator skill 评估任务完成状态：
   - 如果评估结果为 COMPLETE：
     - 更新 `progress.md` 状态为 completed
     - 创建 `final_result.md`，写入结果摘要
     - 删除 `running.lock`
   - 如果评估结果为 NEED_EXECUTE：
     - 调用 executor skill 执行任务
     - Executor 会自动更新 `progress.md`（Task Context）
     - 在 `iterations/` 下创建新迭代目录（如 `iter-N/`），保存执行记录
     - 删除 `running.lock`

> **Note**: `progress.md` 作为 Task Context，由 Executor 写入、Task Reporter 读取。
> 详见 `task-reporter` schedule。

### 5. 迭代限制

- 统计 `iterations/` 下的子目录数量
- 从 `task.md` frontmatter 读取 `maxIterations`（默认 10）
- 如果迭代次数 ≥ maxIterations，创建 `failed.md` 并跳过

## 任务目录结构

```
tasks/{taskId}/
├── task.md           → 存在 = 任务已创建
├── progress.md       → 任务进度上下文（Executor 写入，Reporter 读取）
├── final_result.md   → 存在 = 任务已完成 ✅
├── running.lock      → 存在 = 任务执行中 🔄
├── failed.md         → 存在 = 任务失败 ❌
├── .last-report      → 最近一次进度报告时间戳（Reporter 写入）
└── iterations/
    ├── iter-1/
    ├── iter-2/
    └── iter-N/       → 子目录数量 = 迭代次数
```

## task.md 格式

```markdown
---
priority: high
maxIterations: 10
createdAt: 2026-03-23T00:00:00Z
---

# 任务标题

任务描述...

## 验收标准

- [ ] 标准 1
- [ ] 标准 2
```

## 错误处理

- 如果扫描目录不存在，记录警告并跳过
- 如果任务执行过程中出错，删除 `running.lock` 并记录错误
- 如果 evaluator/executor skill 不可用，发送错误通知到 chatId

## 使用说明

1. 复制此文件到 `workspace/schedules/deep-task.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 在 `workspace/tasks/` 下创建任务目录和 `task.md` 文件
5. 调度器将自动扫描并执行任务

## 迁移说明

此方案替代了原有的复杂架构：

| 旧组件 | 新方案 |
|--------|--------|
| `TaskFileWatcher` (fs.watch) | 现有 Scheduler 定时扫描 |
| `ReflectionController` (3阶段) | Eval → Execute (2阶段) |
| `TaskStateManager` | 文件存在性判断 |
| `TaskFlowOrchestrator` | Schedule 定义 + Skills |
