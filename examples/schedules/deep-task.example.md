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
2. **初始化进度跟踪** — 创建 `progress.json`：
   ```bash
   echo '{"taskId":"TASK_ID","status":"running","currentPhase":"idle","currentIteration":0,"completedIterations":0,"maxIterations":10,"currentStep":"Task started, preparing evaluation","filesModified":[],"startedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","lastUpdatedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > workspace/tasks/TASK_ID/progress.json
   ```
   > 将 `TASK_ID` 替换为实际的任务 ID，`maxIterations` 从 task.md frontmatter 读取。

3. 读取 `task.md` 了解任务需求
4. 分析当前任务状态（检查 `iterations/` 目录下的历史迭代）
5. **更新进度：开始评估** — 更新 `progress.json` 的 `currentPhase` 为 `evaluating`：
   ```bash
   # 使用 python 或 jq 更新 JSON（示例使用 python）
   python3 -c "
   import json, datetime
   with open('workspace/tasks/TASK_ID/progress.json') as f:
       p = json.load(f)
   p['currentPhase'] = 'evaluating'
   p['currentStep'] = 'Evaluating task completion status'
   p['lastUpdatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
   with open('workspace/tasks/TASK_ID/progress.json', 'w') as f:
       json.dump(p, f, indent=2)
   "
   ```
6. 调用 evaluator skill 评估任务完成状态：
   - 如果评估结果为 COMPLETE：
     - **更新进度：已完成** — 更新 `progress.json`：
       ```bash
       python3 -c "
       import json, datetime
       with open('workspace/tasks/TASK_ID/progress.json') as f:
           p = json.load(f)
       p['status'] = 'completed'
       p['currentPhase'] = 'reporting'
       p['lastEvaluationStatus'] = 'COMPLETE'
       p['currentStep'] = 'Task completed successfully'
       p['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
       p['lastUpdatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
       with open('workspace/tasks/TASK_ID/progress.json', 'w') as f:
           json.dump(p, f, indent=2)
       "
       ```
     - 创建 `final_result.md`，写入结果摘要
     - 删除 `running.lock`
   - 如果评估结果为 NEED_EXECUTE：
     - **更新进度：开始执行** — 更新 `progress.json`：
       ```bash
       python3 -c "
       import json, datetime
       with open('workspace/tasks/TASK_ID/progress.json') as f:
           p = json.load(f)
       p['currentPhase'] = 'executing'
       p['currentIteration'] = p['completedIterations'] + 1
       p['lastEvaluationStatus'] = 'NEED_EXECUTE'
       p['currentStep'] = 'Executing task implementation'
       p['lastUpdatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
       with open('workspace/tasks/TASK_ID/progress.json', 'w') as f:
           json.dump(p, f, indent=2)
       "
       ```
     - 调用 executor skill 执行任务
     - 在 `iterations/` 下创建新迭代目录（如 `iter-N/`），保存执行记录
     - **更新进度：迭代完成** — 更新 `progress.json`：
       ```bash
       python3 -c "
       import json, datetime
       with open('workspace/tasks/TASK_ID/progress.json') as f:
           p = json.load(f)
       p['completedIterations'] = p['completedIterations'] + 1
       p['currentStep'] = 'Iteration N completed, will evaluate on next scan'
       p['lastUpdatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
       with open('workspace/tasks/TASK_ID/progress.json', 'w') as f:
           json.dump(p, f, indent=2)
       "
       ```
     - 删除 `running.lock`

### 5. 迭代限制

- 统计 `iterations/` 下的子目录数量
- 从 `task.md` frontmatter 读取 `maxIterations`（默认 10）
- 如果迭代次数 ≥ maxIterations：
  - **更新进度：失败** — 更新 `progress.json`：
    ```bash
    python3 -c "
    import json, datetime
    with open('workspace/tasks/TASK_ID/progress.json') as f:
        p = json.load(f)
    p['status'] = 'failed'
    p['currentStep'] = 'Max iterations reached'
    p['error'] = 'Exceeded maximum allowed iterations'
    p['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    p['lastUpdatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with open('workspace/tasks/TASK_ID/progress.json', 'w') as f:
        json.dump(p, f, indent=2)
    "
    ```
  - 创建 `failed.md` 并跳过

## 进度跟踪（Issue #857）

### progress.json 格式

任务执行期间，`progress.json` 记录实时进度，供独立的 Progress Reporter Agent 读取：

```json
{
  "taskId": "om_abc123",
  "status": "running",
  "currentPhase": "executing",
  "currentIteration": 2,
  "completedIterations": 1,
  "maxIterations": 10,
  "currentStep": "Implementing auth module",
  "lastEvaluationStatus": "NEED_EXECUTE",
  "filesModified": ["src/auth.ts", "src/auth.test.ts"],
  "startedAt": "2026-03-24T10:00:00Z",
  "lastUpdatedAt": "2026-03-24T10:15:30Z"
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `taskId` | string | 任务 ID |
| `status` | string | `pending` / `running` / `completed` / `failed` |
| `currentPhase` | string | `idle` / `evaluating` / `executing` / `reporting` |
| `currentIteration` | number | 当前迭代号（1-indexed） |
| `completedIterations` | number | 已完成迭代数 |
| `maxIterations` | number | 最大迭代数 |
| `currentStep` | string | 当前步骤描述 |
| `lastEvaluationStatus` | string | `COMPLETE` / `NEED_EXECUTE` |
| `filesModified` | string[] | 已修改文件列表 |
| `startedAt` | string | 任务开始时间（ISO 8601） |
| `lastUpdatedAt` | string | 最后更新时间（ISO 8601） |

### 与 Progress Reporter 的协作

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Deep Task     │────▶│   progress.json  │────▶│ Progress Reporter│
│   (本 Schedule)  │写入  │   (共享状态)      │读取  │   (独立 Schedule) │
└─────────────────┘     └──────────────────┘     └──────────────────┘
```

- **本 Schedule** 负责在每个阶段转换时写入 `progress.json`
- **Progress Reporter Schedule** 独立运行，读取 `progress.json` 并向用户发送进度卡片
- 两者通过文件系统解耦，互不阻塞

## 任务目录结构

```
tasks/{taskId}/
├── task.md           → 存在 = 任务已创建
├── progress.json     → 进度跟踪状态（Issue #857）
├── final_result.md   → 存在 = 任务已完成 ✅
├── running.lock      → 存在 = 任务执行中 🔄
├── failed.md         → 存在 = 任务失败 ❌
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
