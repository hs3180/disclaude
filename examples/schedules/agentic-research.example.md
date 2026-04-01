---
name: "Agentic Research"
cron: "0 */6 * * *"
enabled: false
blocking: true
cooldownPeriod: 3600000
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
createdAt: "2026-04-01T00:00:00.000Z"
---

# Agentic Research - 自动化研究任务执行

定期检查待处理的研究任务，自动执行研究流程并汇报进展。

## 配置

- **扫描间隔**: 每 6 小时
- **冷却时间**: 3600 秒（1 小时）
- **任务目录**: `workspace/research/`
- **通知目标**: 配置的 chatId

## 执行步骤

### 步骤 1: 扫描研究任务

检查 `workspace/research/` 目录下是否存在待执行的研究任务：

```bash
ls -d workspace/research/*/ 2>/dev/null
```

对每个研究目录，检查状态：

| 状态 | 判断条件 |
|------|---------|
| **needs_outline** | `RESEARCH.md` ✗ — 需要初始化研究大纲 |
| **in_progress** | `RESEARCH.md` ✓ 且有未完成的 objectives — 继续执行 |
| **needs_review** | `RESEARCH.md` ✓ 且所有 objectives 已完成 — 等待用户审查 |
| **completed** | 存在 `final-report.md` — 已完成 |

### 步骤 2: 处理研究任务

#### 2.1 新任务（needs_outline）

如果发现新研究目录但没有 RESEARCH.md：
1. 读取目录中的任务描述文件（如 `task.md` 或 `brief.md`）
2. 生成研究大纲（基于 agentic-research skill 的 Phase 1）
3. 发送大纲到 chatId 请求用户确认
4. 等待用户反馈后再继续

#### 2.2 进行中任务（in_progress）

如果 RESEARCH.md 存在且有未完成的 objectives：
1. 读取 RESEARCH.md 了解当前研究状态
2. 从上次中断处继续执行研究
3. 每完成一个 objective，更新 RESEARCH.md
4. 如果遇到关键发现或需要决策，发送进度报告到 chatId

#### 2.3 需要审查（needs_review）

如果所有 objectives 已完成但没有 final-report.md：
1. 综合所有 findings
2. 生成最终研究报告（基于 agentic-research skill 的 Phase 4）
3. 发送报告到 chatId
4. 保存为 `final-report.md`

### 步骤 3: 进度汇报

在每次执行结束时，发送简要进度到 chatId：

```markdown
## Research Progress

| Task | Status | Progress |
|------|--------|----------|
| {topic} | {status} | {completed}/{total} objectives |
```

## 研究目录结构

```
research/{topic}/
├── brief.md           → 研究需求描述（用户创建）
├── RESEARCH.md        → 研究状态文件（Agent 维护）
├── .research-state.json → 机器可读状态（sidecar）
└── final-report.md    → 最终研究报告（研究完成后生成）
```

## 与 agentic-research skill 的关系

本 schedule 是 agentic-research skill 的**异步执行入口**。当用户不方便等待实时交互时，可以通过以下方式触发异步研究：

1. 创建 `workspace/research/{topic}/brief.md` 描述研究需求
2. Schedule 自动扫描并开始执行
3. 通过 chatId 接收进度更新和最终报告

对于需要实时交互的场景，应直接使用 agentic-research skill 而非此 schedule。

## 注意事项

- 每次执行只处理一个研究任务，避免资源争抢
- 如果多个任务同时存在，按目录创建时间排序（FIFO）
- 研究过程中如果遇到无法解决的问题，暂停并通知用户
- 建议配合 cooldownPeriod 使用，避免过于频繁执行

## 使用说明

1. 复制此文件到 `workspace/schedules/agentic-research.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 创建研究任务目录：`mkdir -p workspace/research/my-topic/`
5. 编写研究需求：创建 `workspace/research/my-topic/brief.md`
6. 调度器将自动扫描并执行研究任务
