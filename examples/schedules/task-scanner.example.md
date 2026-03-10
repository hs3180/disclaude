---
name: "Task Scanner"
cron: "*/30 * * * * *"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-03-10T00:00:00.000Z"
---

# Task Scanner - Schedule-Driven Deep Task Execution

基于文件存在性判断任务状态，复用现有 Scheduler 机制执行深度任务。

## 设计目标

1. **零代码改造** - 复用现有 scheduler，不新增调度代码
2. **文件即状态** - 通过文件存在性判断任务状态
3. **配置驱动** - 通过 schedule.md 和 skill 文件定义行为

## 配置

- **扫描间隔**: 每 30 秒
- **任务目录**: `tasks/`
- **最大迭代次数**: 10

## 执行步骤

### 1. 扫描 tasks/ 目录

列出所有包含 `task.md` 的子目录：

```bash
find tasks -name "task.md" -type f | xargs -I {} dirname {}
```

### 2. 过滤待处理任务

对每个任务目录，检查文件存在性判断状态：

| 状态 | 判断条件 | 操作 |
|------|----------|------|
| **completed** | 存在 `final_result.md` | 跳过 |
| **running** | 存在 `running.lock` | 跳过 |
| **failed** | 存在 `failed.md` | 跳过 |
| **pending** | 以上都不满足 | 加入待处理队列 |

```bash
# 检查任务状态
for dir in $(find tasks -name "task.md" -type f | xargs dirname); do
  if [ -f "$dir/final_result.md" ]; then
    echo "$dir: completed"
  elif [ -f "$dir/running.lock" ]; then
    echo "$dir: running"
  elif [ -f "$dir/failed.md" ]; then
    echo "$dir: failed"
  else
    echo "$dir: pending"
  fi
done
```

### 3. 选择任务

从待处理队列中选择一个任务：

1. 读取 `task.md` 中的 `priority` 字段（默认为 5）
2. 按 priority 排序（数字越小优先级越高）
3. 选择优先级最高的任务

```bash
# 读取任务优先级
grep -E "^priority:" "$dir/task.md" | cut -d: -f2 | tr -d ' ' || echo "5"
```

### 4. 执行任务

#### 4.1 创建 running.lock

```bash
touch "$dir/running.lock"
```

#### 4.2 调用 evaluator skill 评估任务

使用 `evaluator` skill 评估任务完成状态：

```
调用 skill: evaluator
参数:
  taskId: {task_id}
  taskDir: {task_directory}
```

评估结果可能是：
- `COMPLETE`: 任务已完成
- `NEED_EXECUTE`: 需要执行

#### 4.3 根据评估结果执行

**如果 COMPLETE**：
1. 创建 `final_result.md`，记录完成状态
2. 删除 `running.lock`
3. 使用 `send_user_feedback` 通知用户

**如果 NEED_EXECUTE**：
1. 调用 `executor` skill 执行任务
2. 在 `iterations/` 下创建新迭代目录
3. 删除 `running.lock`

```
调用 skill: executor
参数:
  taskId: {task_id}
  taskDir: {task_directory}
  iteration: {iteration_number}
```

### 5. 迭代限制检查

统计 `iterations/` 下的子目录数量：

```bash
ls -d "$dir/iterations"/*/ 2>/dev/null | wc -l
```

如果迭代次数 >= maxIterations (10)：
1. 创建 `failed.md`，记录失败原因
2. 删除 `running.lock`
3. 通知用户任务失败

## 文件结构

```
tasks/{taskId}/
├── task.md           # 任务定义（必需）
├── final_result.md   # 存在 = 任务完成 ✅
├── running.lock      # 存在 = 任务执行中 🔄
├── failed.md         # 存在 = 任务失败 ❌
└── iterations/
    ├── iter-1/       # 第 1 次迭代
    ├── iter-2/       # 第 2 次迭代
    └── iter-N/       # 第 N 次迭代
```

## task.md 格式

```markdown
---
id: task-001
title: 示例任务
priority: 3
createdAt: 2026-03-10T10:00:00Z
maxIterations: 10
---

# 任务描述

详细描述任务目标和要求...

## 验收标准

- [ ] 标准 1
- [ ] 标准 2
```

## 状态通知

使用 `send_user_feedback` 发送任务状态更新：

```
send_user_feedback({
  chatId: "{chatId}",
  format: "markdown",
  content: "**任务更新**\n\n任务 {taskId} 状态: {status}"
})
```

## 错误处理

1. **扫描失败**: 记录日志，等待下次扫描
2. **评估失败**: 记录错误到 `iterations/iter-N/error.md`
3. **执行失败**: 记录错误，增加迭代计数
4. **达到最大迭代**: 标记为 `failed.md`

## 与旧架构对比

| 特性 | 旧设计 | 新设计 |
|------|--------|--------|
| **调度机制** | TaskFileWatcher (fs.watch) | 现有 Scheduler |
| **执行流程** | ReflectionController (3阶段) | Eval → Execute (2阶段) |
| **状态管理** | TaskStateManager + 多文件 | 文件存在性判断 |
| **代码改动** | - | 零调度代码改动 |
| **调试复杂度** | 高 | 低 |

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的飞书群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整扫描间隔

## 依赖

- `evaluator` skill: 评估任务完成状态
- `executor` skill: 执行具体任务
- `send_user_feedback` MCP Tool: 发送通知
