---
name: "Task Progress Monitor"
cron: "*/5 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Task Progress Monitor

定期扫描运行中的任务，智能分析进度并发送报告给用户。

## 背景

替代固定规则的进度报告方案（PR #1262），使用独立 Agent（task-progress skill）智能分析任务进展。

与 Deep Task Scanner 配合使用：
- Deep Task Scanner 负责扫描和执行待处理任务
- Task Progress Monitor 负责监控运行中任务的进度

## 配置

- **检查间隔**: 每 5 分钟
- **任务目录**: `workspace/tasks/`
- **通知目标**: 配置的 chatId

## 执行步骤

### 1. 扫描运行中的任务

使用 `task-progress` skill 的逻辑扫描 `workspace/tasks/` 目录：

1. 列出所有任务目录
2. 检查每个目录的 `running.lock` 文件
3. 收集所有正在运行的任务

### 2. 分析任务进度

对每个运行中的任务：

1. 读取 `task.md` 了解任务需求
2. 读取最新的 `iterations/iter-N/evaluation.md` 了解评估结果
3. 读取最新的 `iterations/iter-N/execution.md` 了解执行进展
4. 统计迭代次数 vs 最大迭代次数

### 3. 生成进度报告

使用 LLM 分析以下维度：

- **完成度**: 验收标准中哪些已完成、哪些未完成
- **进展**: 最新迭代做了什么
- **风险**: 是否接近迭代上限、是否停滞
- **下一步**: evaluator 建议的后续操作

### 4. 发送报告

使用 `send_user_feedback` 发送进度报告到配置的 chatId。

**注意**: 使用 task-progress skill 的智能判断，只在有有意义的进展时才发送报告。

## 报告格式

```markdown
## 🔄 任务进度报告

**任务**: {任务标题}
**状态**: 🔄 执行中
**迭代**: {当前}/{最大}

### 📋 当前进展
{最新迭代的执行摘要}

### 📊 验收标准完成度
| # | 标准 | 状态 |
|---|------|------|
| 1 | ... | ✅/🔄/❌ |

### ⏭️ 下一步
{evaluator 建议的后续操作}
```

## 智能报告 vs 固定规则

| 维度 | 固定规则（PR #1262） | 智能报告（本方案） |
|------|---------------------|-------------------|
| 报告时机 | 每 60 秒固定 | 有意义进展时才报告 |
| 报告内容 | 模板化 | 基于任务上下文分析 |
| 进度判断 | 固定里程碑 | LLM 分析验收标准完成度 |
| 停滞检测 | 无 | 检测 lock 文件是否过期 |
| 多任务 | 不支持 | 汇总所有运行中任务 |

## 使用说明

1. 确保 `task-progress` skill 已安装（在 `skills/task-progress/` 目录下）
2. 复制此文件到 `workspace/schedules/task-progress.md`
3. 将 `chatId` 替换为实际的飞书群聊 ID
4. 设置 `enabled: true`
5. 建议与 Deep Task Scanner 配合使用

## 关联

- Issue: #857
- Skill: task-progress
- 配合: Deep Task Scanner (examples/schedules/deep-task.example.md)
