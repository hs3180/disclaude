---
name: "Progress Reporter"
cron: "0 */2 * * * *"
enabled: false
blocking: false
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Progress Reporter

定期扫描 `workspace/tasks/` 目录，检测 Deep Task 进度变化，发送进度报告卡片。

## 背景

实现 Issue #857 中"独立汇报 Agent"的设计方向：通过独立的 Skill 定期读取任务状态，智能决定是否需要向用户汇报进度。

与 Deep Task Scanner (负责执行) 不同，Progress Reporter 只负责**读取和汇报**，两者通过文件系统完全解耦。

## 架构

```
┌─────────────────┐     ┌──────────────────┐
│   Deep Task     │────▶│  Filesystem      │
│   (执行任务)     │     │  (状态文件)       │
└─────────────────┘     └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ Progress Reporter│
                        │ (独立汇报 Skill)  │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  用户通知卡片     │
                        └──────────────────┘
```

## 配置

- **扫描间隔**: 每 2 分钟
- **任务目录**: `workspace/tasks/`
- **通知目标**: 配置的 chatId
- **阻塞模式**: `false`（不阻塞其他定时任务）

## 任务状态判断

通过文件存在性判断（与 Deep Task Scanner 一致）：

| 状态 | 判断条件 |
|------|---------|
| **pending** | `task.md` ✓ 且 `final_result.md` ✗ 且 `running.lock` ✗ 且 `failed.md` ✗ |
| **running** | `running.lock` ✓ |
| **completed** | `final_result.md` ✓ |
| **failed** | `failed.md` ✓ |

## 执行步骤

### 1. 扫描 tasks/ 目录

```bash
ls -d workspace/tasks/*/ 2>/dev/null
```

### 2. 读取上次报告状态

读取 `workspace/tasks/.last-progress-report`，获取上次报告时的任务状态快照。

### 3. 检测变化

对比当前状态与上次报告：
- 任务状态变化（pending → running → completed/failed）
- 迭代次数增加
- 新任务出现

### 4. 发送报告

仅在检测到变化时发送报告卡片：
- **Running**: 进度卡（当前迭代、最新执行摘要、已用时间）
- **Completed**: 完成卡（最终结果、交付物）
- **Failed**: 失败卡（最后执行摘要）

### 5. 更新报告状态

写入新的 `.last-progress-report` 快照。

## 使用说明

1. 复制此文件到 `workspace/schedules/progress-reporter.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 确保 `deep-task` schedule 也已启用（负责实际执行任务）

## 与 Deep Task Scanner 的配合

```
Deep Task Scanner (*/30 * * * * *)  →  执行任务、创建迭代文件
Progress Reporter (*/2 * * * * *)   →  读取迭代文件、发送进度卡片
```

两个 schedule 通过 `workspace/tasks/` 目录下的文件完全解耦：
- Scanner 写入 `running.lock`、`iterations/`、`evaluation.md`、`final_result.md`
- Reporter 只读取这些文件（除 `.last-progress-report` 外不写入任何任务文件）
