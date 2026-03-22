---
name: "Deep Task Scanner"
cron: "0 */1 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Deep Task Scanner - Schedule-Based Task Execution

定期扫描 tasks 目录，发现待处理任务并执行。

**这是 Issue #1309 的简化实现**，替代原有的 TaskFileWatcher + ReflectionController + TaskFlowOrchestrator 复杂架构。

## 设计原则

| 原则 | 说明 |
|------|------|
| **零代码改造** | 复用现有 scheduler，不新增调度代码 |
| **文件即状态** | 通过文件存在性判断任务状态，无需额外状态文件 |
| **配置驱动** | 通过 schedule.md 和 skill 文件定义行为 |

## 配置

- **扫描间隔**: 每 1 分钟
- **任务目录**: `workspace/tasks/`
- **最大迭代次数**: 10

## 执行步骤

### 1. 扫描 tasks 目录

```bash
# 列出所有包含 task.md 的子目录
find workspace/tasks -maxdepth 2 -name "task.md" -exec dirname {} \;
```

### 2. 过滤待处理任务

对每个任务目录，检查状态：

| 状态 | 判断条件 |
|-----|---------|
| **pending** | `task.md` ✓ 且 `final_result.md` ✗ 且 `running.lock` ✗ |
| **running** | `running.lock` ✓ |
| **completed** | `final_result.md` ✓ |
| **failed** | `failed.md` ✓ 或 迭代次数 ≥ maxIterations |

```bash
# 对每个任务目录
task_dir="workspace/tasks/{task-id}"

# 检查是否已完成
if [ -f "$task_dir/final_result.md" ]; then
  echo "Task completed, skip"
  continue
fi

# 检查是否正在运行
if [ -f "$task_dir/running.lock" ]; then
  echo "Task running, skip"
  continue
fi

# 检查是否已失败
if [ -f "$task_dir/failed.md" ]; then
  echo "Task failed, skip"
  continue
fi

# 检查迭代次数
iteration_count=$(find "$task_dir/iterations" -maxdepth 1 -type d 2>/dev/null | wc -l)
if [ "$iteration_count" -ge 10 ]; then
  echo "Max iterations reached, skip"
  continue
fi

# 否则是待处理任务
echo "Task pending, process it"
```

### 3. 选择任务

如果有多个待处理任务，按优先级排序（从 task.md frontmatter 读取 priority），选择优先级最高的。

如果没有待处理任务，**退出本次执行**。

### 4. 执行任务

#### 4.1 创建 running.lock

```bash
touch "$task_dir/running.lock"
```

#### 4.2 调用 Evaluator Skill

使用 Skill Runner 执行 `skills/evaluator/SKILL.md`：

```
Template Variables:
- taskId: {task-id}
- iteration: {当前迭代次数 + 1}
- taskMdPath: {task_dir}/task.md
- evaluationPath: {task_dir}/iterations/iter-{n}/evaluation.md
- finalResultPath: {task_dir}/final_result.md
- previousExecutionPath: {上一次迭代的 execution.md 或提示"首次迭代"}
```

#### 4.3 检查评估结果

读取 `{task_dir}/iterations/iter-{n}/evaluation.md`：

- 如果 Status = `COMPLETE`：
  - Evaluator 已创建 `final_result.md`
  - 删除 `running.lock`
  - 发送完成通知
  - 退出

- 如果 Status = `NEED_EXECUTE`：
  - 继续执行 Executor

#### 4.4 调用 Executor Skill

使用 Skill Runner 执行 `skills/executor/SKILL.md`：

```
Template Variables:
- taskId: {task-id}
- iteration: {当前迭代次数}
- taskMdPath: {task_dir}/task.md
- executionPath: {task_dir}/iterations/iter-{n}/execution.md
- evaluationPath: {评估内容（从 evaluation.md 读取）}
```

#### 4.5 删除 running.lock

```bash
rm "$task_dir/running.lock"
```

### 5. 迭代限制检查

统计 `iterations/` 下的子目录数量：
- 如果 < maxIterations，下次扫描时继续处理
- 如果 ≥ maxIterations，创建 `failed.md`：

```markdown
# Task Failed

**Reason**: Max iterations (10) reached without completion.
**Last Iteration**: {n}

## Last Evaluation
{最后一份 evaluation.md 的内容}
```

## 文件结构

```
tasks/{task-id}/
├── task.md           # 任务定义（必须）
├── final_result.md   # 完成标记（存在 = 已完成）
├── running.lock      # 运行标记（存在 = 执行中）
├── failed.md         # 失败标记（存在 = 已失败）
└── iterations/
    ├── iter-1/
    │   ├── evaluation.md
    │   └── execution.md
    ├── iter-2/
    │   └── ...
    └── iter-N/
```

## 与旧架构对比

| 特性 | 旧架构 | 简化方案 |
|-----|-------|---------|
| 调度机制 | TaskFileWatcher (fs.watch) | 现有 Scheduler |
| 执行流程 | ReflectionController (3阶段) | Eval → Execute (2阶段) |
| 状态管理 | TaskStateManager + JSON | 文件存在性判断 |
| 代码位置 | 硬编码 TypeScript | 配置驱动 schedule.md |
| 调试复杂度 | 高 | 低 |

## 使用说明

1. 复制此文件到 `workspace/schedules/deep-task.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 在 `workspace/tasks/{task-id}/task.md` 创建任务文件

## task.md 格式

```markdown
---
priority: 10
---

# Task Title

## Description
任务描述...

## Requirements
- Requirement 1
- Requirement 2

## Expected Results
- [ ] Result 1
- [ ] Result 2
```

## 依赖

- Scheduler (现有)
- Skill Runner (现有)
- Evaluator Skill (`skills/evaluator/SKILL.md`)
- Executor Skill (`skills/executor/SKILL.md`)
