# PR Scanner Design Document

> Issue: #393 - feat: 定时扫描 PR 并创建讨论群聊 (0.4)
> Version: v0.4
> Status: Draft
> Created: 2026-03-02

## 1. Overview

### 1.1 Goal

Design a scheduled task that:
- Periodically scans open PRs in the repository
- Creates group chats for new PRs
- Provides PR details and enables interactive discussion
- Supports PR actions through commands

### 1.2 Scope

This document covers:
- Complete workflow analysis
- Infrastructure dependencies
- Implementation phases
- Technical design decisions

## 2. Workflow Analysis

### 2.1 High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PR Scanner Workflow                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────┐          │
│  │  Cron    │───>│  Scan Open   │───>│  Compare with    │          │
│  │  Trigger │    │  PRs         │    │  History         │          │
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
│                        │  Do       │               │  For Each    ││
│                        │  Nothing  │               │  New PR      ││
│                        └───────────┘               └──────────────┘│
│                                                          │         │
│                                                          ▼         │
│                                               ┌──────────────────┐ │
│                                               │  Create Group    │ │
│                                               │  Chat            │ │
│                                               └──────────────────┘ │
│                                                          │         │
│                                                          ▼         │
│                                               ┌──────────────────┐ │
│                                               │  Send PR Info    │ │
│                                               │  Card            │ │
│                                               └──────────────────┘ │
│                                                          │         │
│                                                          ▼         │
│                                               ┌──────────────────┐ │
│                                               │  Update History  │ │
│                                               └──────────────────┘ │
│                                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Detailed Steps

| Step | Action | Tool/API | Notes |
|------|--------|----------|-------|
| 1 | Get open PRs | `gh pr list --state open` | Use gh CLI |
| 2 | Load history | Read from storage | JSON file in workspace |
| 3 | Compare | In-memory diff | Identify new PR numbers |
| 4 | Get PR details | `gh pr view {number}` | Title, body, author, status |
| 5 | Create chat | ChatOps `createDiscussionChat()` | PR #423 dependency |
| 6 | Send info | `send_user_feedback` | Interactive card |
| 7 | Update history | Write to storage | Append new PR numbers |

## 3. Infrastructure Dependencies

### 3.1 Dependency Matrix

| Dependency | Status | PR/Issue | Blocking | Notes |
|------------|--------|----------|----------|-------|
| Scheduler | ✅ Ready | #357 | No | Already implemented |
| ChatOps (createDiscussionChat) | ✅ Ready | PR #423 (merged) | ~~Yes~~ No | Group chat creation |
| FeedbackController | ⏳ Optional | PR #412 | Partial | Interactive cards (Phase 3) |
| PR State Storage | ✅ Ready | This doc | No | Simple JSON file |

### 3.2 ChatOps API (PR #423)

```typescript
// Required function from PR #423
import { createDiscussionChat } from './platforms/feishu/chat-ops.js';

// Usage in schedule prompt
const chatId = await createDiscussionChat(client, {
  topic: `PR #${prNumber}: ${prTitle}`,
  members: [prAuthor, ...reviewers],
});
```

**Status**: PR #423 is open and unmerged. This is a **blocking dependency**.

### 3.3 FeedbackController Integration (PR #412)

```typescript
// Optional: Use FeedbackController for interactive actions
// After PR #412 merges

FeedbackController.createChannel({ type: 'existing', chatId })
  .sendMessage(prInfoCard)
  .collectFeedback({
    options: ['Merge', 'Close', 'Request Changes', 'Later']
  })
  .getDecision();
```

**Status**: PR #412 is open. Not blocking, but enables better UX.

### 3.4 PR State Storage

**Design Decision**: Use simple JSON file in workspace

```json
// workspace/pr-scanner-history.json
{
  "lastScan": "2026-03-02T10:00:00Z",
  "processedPRs": [439, 437, 436, 434, 427, 423, 412],
  "prChats": {
    "440": "oc_xxxx"
  }
}
```

**Rationale**:
- Simple implementation
- No database needed
- Easy to debug
- Portable across environments

## 4. Implementation Phases

### Phase 1: Basic Scanner (No Group Chat) ✅ Can implement now

**Goal**: Scan PRs and send notifications to existing chat

**Requirements**:
- ✅ Scheduler infrastructure
- ✅ `send_user_feedback` tool

**Schedule File**:
```markdown
---
name: "PR Scanner (Basic)"
cron: "0 */30 * * * *"
enabled: true
blocking: true
chatId: "oc_notification_chat"
---

# PR Scanner - Basic Version

Scan for new PRs and send notifications.

## Steps

1. Run `gh pr list --state open --json number` to get open PRs
2. Read workspace/pr-scanner-history.json
3. Compare to find new PRs
4. For each new PR:
   - Run `gh pr view {number}` to get details
   - Use send_user_feedback to notify
5. Update history file
```

### Phase 2: Group Chat Creation ✅ Ready (PR #423 merged)

**Goal**: Create dedicated group chat for each PR

**Requirements**:
- ✅ ChatOps `createDiscussionChat()` (PR #423 merged)

**Additional Steps**:
1. Call `createDiscussionChat()` for new PRs
2. Store chat ID mapping in history
3. Send PR info to new chat

### Phase 3: Interactive Actions ⏳ Blocked by PR #412

**Goal**: Support PR actions through interactive cards

**Requirements**:
- ⏳ FeedbackController (PR #412)

**Additional Features**:
- Action buttons: Merge, Close, Request Changes
- Collect user decisions
- Execute actions via `gh` CLI

## 5. Technical Design

### 5.1 Schedule File Structure

```markdown
---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: true
blocking: true
chatId: "oc_admin_chat"
---

# PR Scanner Task

Scan repository for new PRs and create discussion chats.

## Configuration

- Repository: hs3180/disclaude
- Scan interval: Every 30 minutes
- Admin chat: For notifications and errors

## Execution Steps

1. **Scan Open PRs**
   ```bash
   gh pr list --repo hs3180/disclaude --state open --json number,title,author
   ```

2. **Load History**
   Read from workspace/pr-scanner-history.json

3. **Identify New PRs**
   Compare current PRs with history

4. **Process Each New PR**
   - Get detailed info: `gh pr view {number}`
   - Create group chat (requires ChatOps)
   - Send PR info card
   - Update history

5. **Update History**
   Save to workspace/pr-scanner-history.json

## Error Handling

- If gh CLI fails: Log error, send notification to admin chat
- If chat creation fails: Fall back to admin chat notification
- If history file corrupt: Reset and start fresh
```

### 5.2 History File Schema

```typescript
interface PRScannerHistory {
  lastScan: string;           // ISO timestamp
  processedPRs: number[];     // PR numbers already processed
  prChats: Record<number, string>;  // PR number -> chat ID mapping
  errors: Array<{
    timestamp: string;
    prNumber?: number;
    error: string;
  }>;
}
```

### 5.3 PR Info Card Template

```markdown
## PR #{number}: {title}

**Author**: {author}
**Status**: {mergeable ? 'Ready' : 'Has Conflicts'}
**Checks**: {ciStatus}

### Description
{body}

### Files Changed
{files}

### Actions
- [ ] Merge
- [ ] Close
- [ ] Request Changes
- [ ] Comment
```

## 6. Implementation Checklist

### Ready to Implement (Phase 1)
- [x] Scheduler infrastructure exists
- [x] `send_user_feedback` available
- [ ] Create schedule file `pr-scanner.md`
- [ ] Create history file schema
- [ ] Test with notification-only mode

### Ready (Phase 2)
- [x] PR #423 (ChatOps) merged
- [x] createDiscussionChat() available in chat-ops.ts
- [ ] Update schedule file to use create_discussion
- [ ] Test group chat flow

### Blocked (Phase 3)
- [ ] Wait for PR #412 (FeedbackController) to merge
- [ ] Add interactive action buttons
- [ ] Implement action execution

## 7. Testing Plan

### Unit Tests
- [ ] History file read/write
- [ ] PR comparison logic
- [ ] Card template generation

### Integration Tests
- [ ] Full scan cycle (no new PRs)
- [ ] New PR detection
- [ ] Notification sending
- [ ] Group chat creation (after PR #423)

### Manual Tests
- [ ] Run schedule manually
- [ ] Verify notifications appear
- [ ] Verify group chats created correctly

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| PR #423 not merged | Cannot create group chats | Phase 1 uses existing chat |
| GitHub API rate limits | Scan failures | Add rate limit handling |
| History file corruption | Lost state | Backup before write |
| Multiple PRs at once | Spam | Batch notifications |

## 9. References

- Issue #393: feat: 定时扫描 PR 并创建讨论群聊
- Issue #357: 智能定时任务推荐系统
- PR #423: feat(feishu): add ChatOps utility (**merged** - ChatOps available)
- PR #412: feat(feedback): add FeedbackController (pending - Phase 3)
- PR #421: Previous attempt (closed - lacked design analysis)
