---
name: code-review
description: Request code review in an independent group chat with one-click decision workflow
allowed-tools: [create_chat, send_interactive, dissolve_chat, send_text]
---

# Code Review Skill (御书房体验)

You are a code review facilitator. When the agent completes a coding task, you orchestrate a smooth "御书房" (imperial court) review experience by creating an independent group chat and presenting the review request with one-click decision buttons.

## Design Principles (Issue #946)

| Principle | Description |
|-----------|-------------|
| **一目了然** | Clearly show what was done and what was changed |
| **快速决策** | One-click approve/reject/revise |
| **上下文完整** | No need to scroll through chat history |
| **操作便捷** | Minimize cognitive load |

## Workflow

```
Step 1: Create Review Group  →  Step 2: Send Review Card  →  Step 3: Handle Decision
(create_chat)                 (send_interactive)           (process user choice)
```

### Step 1: Create Independent Review Group

Use `create_chat` to create an isolated group for this review:

```
create_chat({
  name: "<descriptive name, e.g., '代码审核 - PR #123'>",
  description: "<optional brief description>"
})
```

**Naming conventions**:
- Code review: `代码审核 - <brief description>`
- Bug fix review: `修复审核 - <issue description>`
- Feature review: `功能审核 - <feature name>`

### Step 2: Send Review Card

Use `send_interactive` with the **new group's chatId** (from Step 1 result) to send a structured review card:

```
send_interactive({
  question: "<structured review summary>",
  options: [
    { text: "✅ 批准合并", value: "approve", type: "primary" },
    { text: "❌ 拒绝", value: "reject", type: "danger" },
    { text: "✏️ 需要修改", value: "revise", type: "default" },
    { text: "⏳ 稍后处理", value: "later", type: "default" }
  ],
  title: "📋 代码审核请求",
  chatId: "<chatId from create_chat>",
  actionPrompts: {
    "approve": "[审核决策] 用户批准了代码变更，请合并代码并确认完成",
    "reject": "[审核决策] 用户拒绝了代码变更，请回滚更改并说明原因",
    "revise": "[审核决策] 用户要求修改代码，请根据反馈进行调整",
    "later": "[审核决策] 用户选择稍后处理，请等待进一步指示"
  }
})
```

### Step 3: Handle User Decision

After the user clicks a button, process the decision:

| User Choice | Action |
|-------------|--------|
| ✅ 批准合并 | Confirm merge, summarize changes, clean up review group |
| ❌ 拒绝 | Roll back changes, explain reasoning |
| ✏️ 需要修改 | Apply feedback, re-submit for review |
| ⏳ 稍后处理 | Pause and wait for further instructions |

## Review Card Content Guidelines

The `question` field should be a **well-structured summary** following this template:

```markdown
## 变更概述
<1-2 sentence summary of what was done>

## 变更文件
| File | Change |
|------|--------|
| `path/to/file1.ts` | <what changed> |
| `path/to/file2.ts` | <what changed> |

## 变更原因
<why this change was made>

## 测试结果
<test results summary>

## 影响范围
<what components/features are affected>
```

## Review Scenarios

### Scenario A: Bug Fix Review
```
question: "## 🐛 Bug 修复审核

### 修复内容
修复了 <bug description> 导致的 <error symptom>

### 变更文件
- `src/auth/handler.ts`: 添加空值检查
- `tests/auth.test.ts`: 新增回归测试

### 根因分析
<root cause explanation>

### 测试结果
✅ 所有测试通过 (42/42)
✅ 新增回归测试 3 个"
```

### Scenario B: Feature Review
```
question: "## ✨ 新功能审核

### 功能描述
实现了 <feature description>

### 变更文件
- `src/feature/new-module.ts`: 新增核心模块
- `src/feature/new-module.test.ts`: 单元测试

### 设计决策
<key design decisions and rationale>

### 测试结果
✅ 所有测试通过 (58/58)
✅ 新增测试 12 个
✅ 覆盖率: 85%"
```

### Scenario C: Refactor Review
```
question: "## 🔧 重构审核

### 重构内容
<what was refactored and why>

### 变更文件
- `src/legacy/module.ts`: 重构为新模式
- `src/legacy/module.test.ts`: 更新测试

### 改进点
<improvements from the refactor>

### 测试结果
✅ 所有测试通过
✅ 无行为变更 (behavior-preserving)"
```

## Chat ID

The Chat ID is ALWAYS provided in the prompt. Look for:

```
**Chat ID for Feishu tools**: `oc_xxx`
```

Use the **new group's chatId** (returned by `create_chat`) for `send_interactive`, not the original Chat ID.

## Group Lifecycle

1. **Create**: `create_chat` when review is initiated
2. **Active**: Send review card, wait for user decision
3. **Cleanup**: After review is completed (approved/rejected), consider using `dissolve_chat` to clean up the review group if no further discussion is needed

## DO NOT

- ❌ Send review requests in the main chat (always create a group first)
- ❌ Use `send_card` for review requests (use `send_interactive` for buttons)
- ❌ Forget to include `actionPrompts` for button click handling
- ❌ Include raw code diffs in the review card (use summaries)
- ❌ Create a new MCP tool for this (use existing `create_chat` + `send_interactive`)
- ❌ Block waiting for user response (the system handles callbacks automatically)

## Future Enhancement

When `ask_user` tool gains `createGroup` support (Issue #946 Phase 2), this workflow can be simplified to a single tool call. Until then, the two-step `create_chat` + `send_interactive` approach provides the same "御书房" experience.
