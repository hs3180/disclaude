---
name: "Task Scanner"
cron: "*/30 * * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Task Scanner - Schedule-Driven Deep Task

基于 Schedule 驱动的任务扫描器，替代原有的 TaskFileWatcher + ReflectionController 架构。

## 设计目标

1. **零代码改造** - 复用现有 scheduler，不新增调度代码
2. **文件即状态** - 通过文件存在性判断任务状态，无需额外状态文件
3. **配置驱动** - 通过 schedule.md 定义行为

## 执行逻辑

### 1. 扫描 tasks/ 目录

列出所有包含 `task.md` 的子目录：

```bash
find workspace/tasks -maxdepth 2 -name "task.md" -exec dirname {} \;
```

### 2. 过滤待处理任务

对于每个 task 目录，检查状态：

| 文件 | 存在时的含义 |
|------|-------------|
| `final_result.md` | ✅ 已完成 → 跳过 |
| `running.lock` | 🔄 执行中 → 跳过 |
| `failed.md` | ❌ 已失败 → 跳过 |
| 无上述文件 | ⏳ 待处理 → 加入队列 |

### 3. 选择任务

- 按 priority 排序（从 task.md frontmatter 读取）
- 选择优先级最高的任务

### 4. 执行任务

#### 4.1 创建锁文件

```bash
touch workspace/tasks/{taskId}/running.lock
```

#### 4.2 调用 Evaluator Skill

使用 `skill` 工具调用 evaluator：

```
skill: "evaluator"
args: "--taskId {taskId} --iteration {iteration}"
```

#### 4.3 处理评估结果

**如果评估结果是 COMPLETE**:
1. Evaluator 已创建 `final_result.md`
2. 删除 `running.lock`
3. 任务完成

**如果评估结果是 NEED_EXECUTE**:
1. 调用 Executor Skill:
   ```
   skill: "executor"
   args: "--taskId {taskId} --iteration {iteration}"
   ```
2. 在 `iterations/` 下创建新迭代目录
3. 删除 `running.lock`
4. 等待下次扫描继续评估

### 5. 迭代限制

- 统计 `iterations/` 下的子目录数量
- 如果 ≥ `maxIterations`（默认 10），创建 `failed.md` 并跳过

## 文件存在性状态判断

```
tasks/{taskId}/
├── task.md           → 存在 = 任务已创建
├── final_result.md   → 存在 = 任务已完成 ✅
├── running.lock      → 存在 = 任务执行中 🔄
├── failed.md         → 存在 = 任务失败 ❌
└── iterations/
    ├── iter-1/
    ├── iter-2/
    └── iter-N/       → 子目录数量 = 迭代次数
```

## 与旧架构对比

| 特性 | 旧设计 | 新设计 |
|-----|--------|--------|
| **调度机制** | TaskFileWatcher (fs.watch) | 现有 Scheduler |
| **执行流程** | ReflectionController (3阶段) | Eval → Execute (2阶段) |
| **状态管理** | TaskStateManager + 多文件 | 文件存在性判断 |
| **代码改动** | 复杂 | 零调度代码改动 |
| **调试复杂度** | 高 | 低 |

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxIterations` | 10 | 最大迭代次数 |
| `scanInterval` | 30s | 扫描间隔（由 cron 控制） |

## 使用说明

1. 复制此文件到 `workspace/schedules/task-scanner.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID（用于接收通知）
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## 依赖

- `skills/evaluator/SKILL.md` - 任务评估
- `skills/executor/SKILL.md` - 任务执行

## 通知消息模板

### 任务开始
```
🔄 任务开始执行

**Task ID**: {taskId}
**标题**: {title}
**优先级**: {priority}

📝 任务描述:
{description 前200字符}
```

### 任务完成
```
✅ 任务执行完成

**Task ID**: {taskId}
**迭代次数**: {iterations}
**耗时**: {duration}

📋 结果摘要:
{summary}
```

### 任务失败
```
❌ 任务执行失败

**Task ID**: {taskId}
**迭代次数**: {iterations}/{maxIterations}
**失败原因**: {reason}

请检查 iterations/ 目录了解详情。
```

## 错误处理

- 如果任务目录不存在 `task.md`，跳过
- 如果 evaluator/executor 执行失败，记录错误并删除 `running.lock`
- 如果连续失败超过 3 次，创建 `failed.md`

## 相关文档

- Issue: #1309
- 设计文档: `docs/designs/schedule-driven-deep-task.md`
