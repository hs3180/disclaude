---
name: create-pr-discussion
description: Create a Feishu group chat for PR review discussion. Use when the PR Scanner detects a new open PR and needs to create a discussion group. Keywords: "创建讨论群", "PR讨论群", "create discussion group", "PR group", "群创建".
allowed-tools: [Bash]
---

# Create PR Discussion Group

Create a Feishu group chat for PR review discussion via lark-cli, write the mapping to bot-chat-mapping.json, and return the chatId.

## Single Responsibility

- ✅ Create a Feishu group for PR review with parseable name
- ✅ Write PR-to-ChatId mapping to bot-chat-mapping.json
- ✅ Idempotent: skip if mapping already exists
- ✅ Cleanup on failure (delete group if mapping write fails)
- ❌ DO NOT send initial prompt/message (done by caller)
- ❌ DO NOT scan PRs (done by PR Scanner schedule)
- ❌ DO NOT dissolve groups

## Invocation

This skill is invoked by the PR Scanner schedule after detecting a new open PR. The schedule extracts the PR number and title, then calls this skill.

### Usage

```bash
CREATE_PR_NUMBER="123" \
CREATE_PR_TITLE="Fix authentication bug in login flow" \
npx tsx skills/create-pr-discussion/create-pr-discussion.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CREATE_PR_NUMBER` | Yes | PR number (positive integer) |
| `CREATE_PR_TITLE` | Yes | PR title (truncated to 30 chars in group name) |
| `CREATE_BOT_ID` | No | Bot ID for group creation (uses lark-cli default) |
| `CREATE_MAPPING_FILE` | No | Path to mapping JSON (default: workspace/bot-chat-mapping.json) |
| `CREATE_SKIP_LARK` | No | Set to '1' to skip lark-cli API calls (testing only) |
| `CREATE_DRY_RUN` | No | Set to '1' to preview group name without creating |

### Output

JSON on stdout:

```json
{"ok": true, "chatId": "oc_xxx", "created": true, "key": "pr-123", "groupName": "PR #123 · Fix authentication bug..."}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Whether the operation succeeded |
| `chatId` | string | Feishu group chat ID (oc_xxx format) |
| `created` | boolean | Whether a new group was created (false if already existed) |
| `key` | string | Mapping key (e.g., "pr-123") |
| `groupName` | string | Group name (only when created=true) |

## Execution Flow

```
1. Validate inputs (PR number, PR title)
2. Read bot-chat-mapping.json
3. If mapping exists for pr-{number}: return existing chatId (idempotent)
4. Create group via lark-cli: POST /open-apis/im/v1/chats
5. Write mapping to bot-chat-mapping.json (atomic write)
6. If write fails: delete the group (cleanup)
7. Output JSON result to stdout
```

## Group Naming

Format: `PR #{number} · {title前30字}`

Examples:
- `PR #123 · Fix authentication bug`
- `PR #456 · 简化临时会话设计 — 移除状态机...`

**Rules**:
- Must start with `PR #` (for mapping rebuild regex)
- Title truncated to 30 characters, `...` appended if truncated
- Uniqueness guaranteed by PR number

## Architecture

Uses **lark-cli** to call Feishu API directly (same pattern as rename-group skill). Writes to the same `bot-chat-mapping.json` file that BotChatMappingStore reads/writes, ensuring compatibility.

## Safety Guarantees

- **Idempotent**: If mapping already exists, returns existing chatId without creating a new group
- **Atomic mapping write**: Uses temp file + rename for crash safety
- **Cleanup on failure**: If mapping write fails, deletes the newly created group
- **Input validation**: PR number must be positive integer, title must be non-empty
