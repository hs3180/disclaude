# PR Scanner Design Document

> Issue: #393 - feat: 定时扫描 PR 并创建讨论群聊 (0.4)
> Issue: #3383 - feat(0.4.1): PR Review 临时群聊 — 基于 Message + project-bound Agent
> Version: v0.5
> Status: Active
> Updated: 2026-05-10

## 1. Overview

### 1.1 Goal

Design a scheduled task that:
- Periodically scans open PRs in the repository
- Creates group chats for new PRs via `lark-cli`
- Performs automated PR review (diff analysis, code quality assessment)
- Sends review cards to per-PR review groups
- Tracks PR-to-chatId mappings for idempotent operation

### 1.2 Scope

This document covers:
- Complete workflow from scan → review → notification
- Infrastructure dependencies and their current status
- Implementation phases with actual deliverables
- Migration path to 0.4.1 Message-based architecture

## 2. Workflow Analysis

### 2.1 High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     PR Scanner + Review Workflow                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────┐          │
│  │  Cron    │───>│  Scan Open   │───>│  Compare with    │          │
│  │  Trigger │    │  PRs         │    │  Mapping Table   │          │
│  └──────────┘    └──────────────┘    └──────────────────┘          │
│                                              │                      │
│                                              ▼                      │
│                                     ┌──────────────────┐           │
│                                     │  New PRs Found?  │           │
│                                     └──────────────────┘           │
│                                              │                      │
│                               ┌──────────────┴──────────────┐      │
│                               │                             │      │
│                               ▼ No                          ▼ Yes  │
│                        ┌───────────┐               ┌──────────────┐│
│                        │  Check    │               │  For Each    ││
│                        │  Closed   │               │  New PR      ││
│                        │  PRs      │               └──────────────┘│
│                        └───────────┘                       │       │
│                                                            ▼       │
│                                               ┌──────────────────┐ │
│                                               │  Create Review   │ │
│                                               │  Group (lark-cli)│ │
│                                               └──────────────────┘ │
│                                                          │         │
│                                                          ▼         │
│                                               ┌──────────────────┐ │
│                                               │  Get PR Diff     │ │
│                                               │  & Details       │ │
│                                               └──────────────────┘ │
│                                                          │         │
│                                                          ▼         │
│                                               ┌──────────────────┐ │
│                                               │  Auto Review     │ │
│                                               │  (AI Analysis)   │ │
│                                               └──────────────────┘ │
│                                                          │         │
│                                                          ▼         │
│                                               ┌──────────────────┐ │
│                                               │  Send Review     │ │
│                                               │  Card            │ │
│                                               └──────────────────┘ │
│                                                          │         │
│                                                          ▼         │
│                                               ┌──────────────────┐ │
│                                               │  Update Mapping  │ │
│                                               │  & Notify Ctrl   │ │
│                                               └──────────────────┘ │
│                                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Detailed Steps

| Step | Action | Tool/API | Notes |
|------|--------|----------|-------|
| 1 | Read mapping table | `cat workspace/bot-chat-mapping.json` | BotChatMappingStore |
| 2 | Get open PRs | `gh pr list --state open` | Use gh CLI |
| 3 | Compare | In-memory diff | New vs existing mappings |
| 4 | Check closed PRs | `gh pr list --state closed` | Log status changes |
| 5 | Create review group | `lark-cli im chat create` | Per-PR group |
| 6 | Get PR details | `gh pr view {number}` | Title, body, author, stats |
| 7 | Get PR diff | `gh pr diff {number}` | Full diff or stat summary |
| 8 | Auto review | Agent AI analysis | Generate structured review |
| 9 | Send review card | `send_card` / `send_interactive` | To review group |
| 10 | Notify control channel | `send_text` | Summary to chatId |
| 11 | Update mapping | Write to bot-chat-mapping.json | Atomic write |

## 3. Infrastructure Dependencies

### 3.1 Dependency Matrix

| Dependency | Status | Module/Issue | Notes |
|------------|--------|-------------|-------|
| Scheduler | ✅ Ready | `packages/core/scheduling` | Cron-based, ChatAgent.runOnce() |
| BotChatMappingStore | ✅ Ready | `packages/core/scheduling` | PR-to-chatId mapping, rebuild support |
| Group Creation | ✅ Ready | `lark-cli im chat create` | CLI-based, no code dependency |
| PR Info | ✅ Ready | `gh` CLI | View, diff, list |
| Review Cards | ✅ Ready | MCP `send_card` / `send_interactive` | Via MCP tools |
| ChatAgent | ✅ Ready | `packages/core/agents` | Short-lived per execution |

### 3.2 Architecture: Current vs Future

| Dimension | Current (v0.5) | Future (0.4.1, #3383) |
|-----------|----------------|----------------------|
| **Execution** | ChatAgent.runOnce() with SKILL.md instructions | SystemMessage → MessageRouter → project-bound ChatAgent |
| **Behavior** | SKILL.md-driven (agent reads instructions) | CLAUDE.md-driven per project |
| **State** | BotChatMappingStore file | Same + project-scoped context |
| **Group creation** | lark-cli CLI | MCP tool or lark-cli |
| **Review quality** | Agent AI analysis | Same, but with conversation context |
| **Routing** | chatId in schedule config | projectKey-based routing |

The current implementation covers all core functionality. The 0.4.1 migration would primarily improve:
- Persistent conversation context (agent remembers previous reviews)
- Project-scoped configuration (projectKey in config)
- SystemMessage routing (webhook/IPC triggers instead of cron-only)

## 4. Implementation Phases

### Phase 1: Basic Scanner + Notification ✅ Available

**Goal**: Scan PRs and send notifications to existing chat

**Deliverables**:
- ✅ Scheduler infrastructure (`packages/core/scheduling`)
- ✅ Schedule markdown format
- ✅ `gh pr list` based scanning
- ✅ Notification via MCP send tools

### Phase 2: Group Chat Creation + Mapping ✅ Available

**Goal**: Create dedicated review group for each PR

**Deliverables**:
- ✅ BotChatMappingStore (`packages/core/scheduling/bot-chat-mapping.ts`)
- ✅ lark-cli group creation
- ✅ Atomic mapping writes
- ✅ Concurrent group limit
- ✅ Self-healing via `rebuildFromGroupList()`

### Phase 3: Automated Review + Cards ✅ Available

**Goal**: Perform automated PR review and send review cards

**Deliverables**:
- ✅ PR diff retrieval (`gh pr diff`)
- ✅ Large diff fallback (`gh pr diff --stat`)
- ✅ Structured review generation (AI analysis)
- ✅ Review grading (Approve / Request Changes / Comment)
- ✅ Review card sending via MCP tools
- ✅ Control channel notification

### Phase 4: Interactive Actions ⏳ Future

**Goal**: Support PR actions through interactive card buttons

**Requirements**:
- Interactive card action handling
- PR action execution (merge, close, request changes)

**Not yet planned — depends on usage feedback from Phase 1-3.**

## 5. Technical Design

### 5.1 Data Storage

**BotChatMappingStore** (`workspace/bot-chat-mapping.json`):

```json
{
  "pr-123": {
    "chatId": "oc_xxx",
    "createdAt": "2026-05-10T00:00:00Z",
    "purpose": "pr-review"
  }
}
```

**Design principles**:
- Mapping table is a cache — rebuildable from Feishu API
- Key format: `pr-{number}` → `purposeFromKey()` infers `pr-review`
- Group name format: `PR #{number} · {title前30字}` → `parseGroupNameToKey()` parses key
- Atomic file writes via temp file + rename

### 5.2 Review Card Format

```markdown
## PR #{number}: {title}

👤 {author} · 🌿 {headRef} → {baseRef}
📊 +{additions} -{deletions} ({changedFiles} files)

### Review: {分级}

**变更概要**: {summary}
**关键改动**: {keyChanges}
**潜在问题**: {potentialIssues}
**建议**: {suggestions}

🔗 https://github.com/{repo}/pull/{number}
```

### 5.3 Review Grading Criteria

| Grade | Criteria |
|-------|----------|
| ✅ **Approve** | Changes are clear, well-tested, no major issues |
| ⚠️ **Request Changes** | Bugs, security issues, or significant design problems |
| 💬 **Comment** | Suggestions for improvement, non-blocking |

### 5.4 Schedule Configuration

```markdown
---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: true
blocking: true
modelTier: "low"
chatId: "oc_control_channel"
---
```

The `modelTier: "low"` setting uses the low-cost model tier for routine scanning.
Review quality relies on the agent's AI analysis capabilities.

## 6. Testing Plan

### Unit Tests

Existing tests cover the infrastructure:
- ✅ BotChatMappingStore (`packages/core/src/scheduling/bot-chat-mapping.test.ts`)
- ✅ Scheduler (`packages/core/src/scheduling/scheduler.test.ts`)
- ✅ ScheduleExecutor (`packages/core/src/scheduling/schedule-executor.test.ts`)
- ✅ ChatStore (`packages/core/src/scheduling/chat-store.test.ts`)

### Integration Tests

Manual verification needed:
- [ ] Full scan cycle with no new PRs
- [ ] New PR detection and group creation
- [ ] Review card delivery to review groups
- [ ] Control channel notification
- [ ] Closed PR detection
- [ ] Concurrent limit enforcement

## 7. Migration to 0.4.1 Architecture (#3383)

When the 0.4.0/0.4.1 infrastructure (#3329, #3332, #3333) merges, the PR Scanner can migrate to:

1. **projectKey-based config**: Schedule references a project key instead of hardcoded chatId
2. **SystemMessage routing**: Webhooks can trigger PR scanning on push events
3. **Persistent ChatAgent**: Agent maintains conversation context across scans
4. **CLAUDE.md-driven behavior**: Per-project review rules and preferences

The current SKILL.md-based approach is forward-compatible — the same instructions can be moved into a project CLAUDE.md when project-bound agents become available.

## 8. References

- Issue #393: feat: 定时扫描 PR 并创建讨论群聊
- Issue #2945: PR Scanner v2 (Parent)
- Issue #2947: BotChatMappingStore
- Issue #3383: PR Review 临时群聊 — 0.4.1 architecture
- Issue #2191: 临时群聊讨论 (0.4.1 核心用例)
- Issue #3329: RFC: Message — Unified Agent Input Abstraction
- Skill: `skills/pr-scanner/SKILL.md`
- Design: `docs/designs/pr-scanner-design.md`
