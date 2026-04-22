---
name: "Task Progress Reporter"
cron: "0 */1 * * * *"
enabled: false
blocking: true
chatId: "oc_SYSTEM_CHAT_ID"
createdAt: 2026-04-22T00:00:00.000Z
---

# Task Progress Reporter

定期扫描 `workspace/tasks/` 目录，发现运行中的任务并向用户发送进度报告卡片。

## 背景

实现 Issue #857 Phase 2：为执行中的 deep task 提供进度反馈，让用户了解任务执行状态，避免长时间无响应的体验。

## 配置

- **扫描间隔**: 每 60 秒
- **任务目录**: `workspace/tasks/`
- **最小报告间隔**: 60 秒（同一任务两次报告之间至少间隔 60 秒）

## 前置依赖

- `send_card` MCP tool（通过 IPC 发送飞书卡片）
- Primary Node 正在运行（IPC 可用）

## 职责边界

- ✅ 扫描运行中的任务（有 `running.lock`，无 `final_result.md`）
- ✅ 读取任务状态（迭代次数、最新执行摘要、评估状态）
- ✅ 格式化进度卡片并发送到任务关联的 chatId
- ✅ 报告节流（同一任务不频繁重复报告）
- ❌ 不执行任务（由 deep-task scanner 负责）
- ❌ 不创建或修改任务文件
- ❌ 不处理已完成或失败的任务

## 执行步骤

### Step 1: 扫描运行中的任务

使用 Glob 工具查找所有包含 `running.lock` 的任务目录：

```
workspace/tasks/*/running.lock
```

对每个找到的 `running.lock` 文件：
- 检查同目录下是否存在 `final_result.md`（已完成 → 跳过）
- 检查同目录下是否存在 `failed.md`（已失败 → 跳过）
- 如果都没有 → 该任务正在运行，继续处理

### Step 2: 读取任务状态

对每个运行中的任务，读取以下文件：

1. **task.md** — 获取任务标题和 chatId
   - 标题: 第一个 `# ` 开头的行
   - Chat ID: `**Chat ID**: xxx` 或 `**Chat**: xxx`

2. **iterations/ 目录** — 获取迭代信息
   - 列出所有 `iter-N/` 子目录
   - 找到最大的 N 作为当前迭代

3. **最新迭代的 execution.md** — 获取执行摘要
   - 读取 `## Summary` 部分

4. **最新迭代的 evaluation.md** — 获取评估状态
   - 读取 `## Status` 部分（COMPLETE / NEED_EXECUTE）

5. **.last-progress-report** — 获取上次报告时间
   - 如果文件不存在 → 应该报告
   - 如果时间距今 < 60 秒 → 跳过（节流）

### Step 3: 发送进度卡片

对每个应该报告的任务，使用 `send_card` 工具发送进度卡片：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "🔄 任务执行中"},
    "template": "blue"
  },
  "elements": [
    {"tag": "markdown", "content": "**任务**: {title}"},
    {"tag": "markdown", "content": "**状态**: {statusIcon} {status}"},
    {"tag": "markdown", "content": "**迭代**: 第 {currentIteration} 轮（共 {totalIterations} 轮已完成）"},
    {"tag": "markdown", "content": "**已运行**: {elapsed}"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "**最近执行**:\n{summary}"}
  ]
}
```

- `chatId` 参数使用从 task.md 中提取的 chatId
- 如果没有执行摘要，省略"最近执行"部分

### Step 4: 标记报告已发送

发送成功后，使用 Write 工具创建 `.last-progress-report` 文件：

```
workspace/tasks/{taskId}/.last-progress-report
```

内容为当前 ISO 时间戳（如 `2026-04-22T10:30:00.000Z`）。

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| tasks 目录不存在 | 正常退出，无运行中的任务 |
| task.md 损坏或无 chatId | 跳过该任务 |
| send_card 失败 | 记录错误，继续处理下一个任务 |
| IPC 不可用 | 记录错误，正常退出 |
| .last-progress-report 写入失败 | 记录错误，不影响已发送的报告 |

## 验收标准

- [ ] 能检测运行中的任务（有 running.lock，无 final_result.md）
- [ ] 能正确读取任务标题、chatId、迭代信息
- [ ] 能发送格式正确的进度卡片
- [ ] 同一任务 60 秒内不会重复报告
- [ ] 已完成或失败的任务不会被报告
- [ ] 发送失败不影响其他任务的处理
