---
name: create-pr-group
description: Create a Feishu group chat for PR review discussion. Creates the group via lark-cli, writes mapping to bot-chat-mapping.json, and returns the chatId. Keywords: "创建讨论群", "PR群组", "create discussion group", "PR group", "群聊创建".
allowed-tools: [Bash]
---

# Create PR Discussion Group

Create a dedicated Feishu group chat for PR review discussion, register it in the bot-chat-mapping table, and return the chatId for subsequent use.

## Single Responsibility

- ✅ Create a Feishu group named `PR #{number} · {title前30字}`
- ✅ Write mapping entry to `bot-chat-mapping.json` (`pr-{number} → { chatId, purpose: "pr-review" }`)
- ✅ Return the created chatId via stdout
- ✅ Idempotent: skip if mapping already exists
- ✅ Validate inputs (PR number, title, mapping file path)
- ❌ DO NOT send initial prompts or PR info cards (handled by caller)
- ❌ DO NOT scan for PRs (handled by PR Scanner schedule)
- ❌ DO NOT dissolve or manage group lifecycle

## Invocation

This skill is invoked by the PR Scanner schedule (or agent) when a new PR needs a discussion group.

### Usage

```bash
PR_NUMBER=2984 \
PR_TITLE="feat(pr-scanner): 讨论群创建逻辑" \
MAPPING_FILE="workspace/bot-chat-mapping.json" \
npx tsx skills/create-pr-group/create-pr-group.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PR_NUMBER` | Yes | GitHub PR number (positive integer) |
| `PR_TITLE` | Yes | PR title (used for group naming) |
| `MAPPING_FILE` | No | Path to bot-chat-mapping.json (default: `workspace/bot-chat-mapping.json`) |
| `CREATE_SKIP_LARK` | No | Set to `1` to skip lark-cli calls (testing only) |

### Output

On success, outputs to stdout:
```
OK: Created group oc_xxxxx for PR #2984 (pr-2984)
CHAT_ID=oc_xxxxx
```

If mapping already exists (idempotent skip):
```
OK: Mapping already exists for PR #2984 → oc_xxxxx (pr-2984)
CHAT_ID=oc_xxxxx
```

On failure, outputs to stderr and exits with code 1.

## Execution Flow

```
1. Validate environment variables (PR_NUMBER, PR_TITLE)
2. Generate mapping key: pr-{number}
3. Read mapping file → check if key exists (idempotency)
   - If exists: output existing chatId and exit 0
4. Generate group name: "PR #{number} · {title前30字}"
5. Check lark-cli availability
6. Create group via lark-cli api POST /open-apis/im/v1/chats
7. Parse response → extract chatId
8. Write mapping entry to file (atomic write)
9. Output chatId and exit 0
```

## Error Handling

| Scenario | Action |
|----------|--------|
| Missing env vars | Exit 1 with validation error |
| Mapping already exists | Output existing chatId, exit 0 (idempotent) |
| lark-cli not found | Exit 1 with dependency error |
| Group creation API error | Exit 1 with API error details |
| Mapping file write error | Exit 1 (group was created but mapping not saved) |
| Invalid mapping file JSON | Log warning, overwrite with new entry |

## Architecture

Follows the same pattern as `skills/rename-group/`:
- Standalone TypeScript script
- Uses `lark-cli api` for Feishu API calls (no IPC Channel)
- Direct file I/O for mapping table (compatible with BotChatMappingStore format)
- Atomic file writes (write to temp, then rename)

## Dependencies

- `lark-cli` (Feishu CLI tool)
- `npx tsx` (TypeScript execution)
- `workspace/bot-chat-mapping.json` (mapping file from Issue #2947)

## Related Issues

- Parent: #2945 (simplified temp chat design)
- Mapping table: #2947 (BotChatMappingStore)
- PR Scanner core: #2982
- Card templates: #2983
- Disband flow: #2985
