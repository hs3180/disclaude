---
name: "Progress Reporter"
cron: "*/2 * * * *"
enabled: false
blocking: false
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Progress Reporter

独立的进度报告 Agent。定期检查正在执行的任务，向用户发送进度更新卡片。

## 背景

解决 Deep Task 执行期间用户无法了解任务进度的问题（Issue #857）。

**设计原则**:
- 独立运行，不阻塞主任务执行（`blocking: false`）
- 智能判断是否需要发送进度更新（避免频繁打扰）
- 通过读取 `progress.json` 获取任务状态，不修改任何任务文件

## 配置

- **扫描间隔**: 每 2 分钟
- **最小报告间隔**: 同一任务至少间隔 3 分钟才再次报告
- **通知目标**: 配置的 chatId

## 架构

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Deep Task     │────▶│   progress.json  │────▶│ Progress Reporter│
│   Schedule      │写入  │   (共享状态)      │读取  │ (本 Schedule)     │
│ (blocking:true) │     │                  │     │ (blocking:false)  │
└─────────────────┘     └──────────────────┘     └──────────────────┘
```

- Deep Task Schedule 在每个阶段转换时写入 `progress.json`
- 本 Schedule 独立运行，读取 `progress.json` 并发送进度卡片
- 两者通过文件系统解耦，互不阻塞

## 执行步骤

### 1. 查找有进度跟踪的任务

```bash
find workspace/tasks -name "progress.json" -type f 2>/dev/null
```

### 2. 过滤正在运行的任务

对每个有 `progress.json` 的任务：

- 读取 `progress.json`
- 检查 `status` 字段：
  - `"running"` → 加入待报告队列
  - `"completed"` / `"failed"` → 跳过（由 completion reporter 处理）

### 3. 判断是否需要报告

对每个运行中的任务：

- 检查 `lastUpdatedAt` 时间戳
- 如果距上次更新 < 30 秒 → 跳过（任务刚更新过，下次再报告）
- 检查是否有 `last_reported` 记录（可在 `progress.json` 中添加）
- 如果距上次报告 < 3 分钟 → 跳过（避免频繁打扰）

### 4. 发送进度卡片

使用 `send_user_feedback` 发送格式化的进度更新。

**单任务卡片格式**：

```
🔄 **任务进度更新**

**任务**: {从 task.md 读取标题}
**状态**: 🔍 评估中 | ⚡ 执行中
**迭代**: 2/10（已完成 1 次迭代）
**当前步骤**: Implementing auth module
**已用时间**: 15m 30s
**修改文件**: 5 个
```

**多任务卡片格式**：

```
🔄 **任务进度更新**（共 2 个任务）

---

**1. {任务标题}**（迭代 2/10）
🔍 评估中 - Checking test coverage
已用时间: 15m 30s | 修改文件: 3

---

**2. {任务标题}**（迭代 1/10）
⚡ 执行中 - Refactoring API endpoints
已用时间: 5m 12s | 修改文件: 7
```

### 5. 更新最后报告时间

报告发送后，在 `progress.json` 中记录 `lastReportedAt` 时间戳：

```bash
python3 -c "
import json, datetime
with open('workspace/tasks/TASK_ID/progress.json') as f:
    p = json.load(f)
p['lastReportedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
with open('workspace/tasks/TASK_ID/progress.json', 'w') as f:
    json.dump(p, f, indent=2)
"
```

## 阶段显示映射

| Phase | 显示 |
|-------|---------|
| `idle` | 💤 等待中 |
| `evaluating` | 🔍 评估中 |
| `executing` | ⚡ 执行中 |
| `reporting` | 📊 生成报告 |

## 状态显示映射

| Status | 显示 |
|--------|---------|
| `running` | 🔄 执行中 |
| `completed` | ✅ 已完成 |
| `failed` | ❌ 失败 |

## 使用说明

1. 确保已配置 `deep-task` Schedule 并启用
2. 复制此文件到 `workspace/schedules/progress-reporter.md`
3. 将 `chatId` 替换为实际的飞书群聊 ID
4. 设置 `enabled: true`
5. 进度报告将自动发送到配置的群聊

## 注意事项

- 本 Schedule 设置为 `blocking: false`，不会阻塞其他 Schedule 执行
- 进度报告仅供参考，不影响任务执行流程
- 如果所有任务都已完成或没有运行中的任务，本 Schedule 静默退出
