---
name: disband-group
description: Disband a Feishu group chat and clean up its mapping record. Use when user explicitly requests to disband/dissolve a group via /disband command or card button "解散群". Keywords: "disband group", "解散群", "解散讨论群", "dissolve group", "delete group".
allowed-tools: [Bash]
---

# Disband Group

Disband a Feishu group chat via lark-cli direct API call and clean up the corresponding bot-chat-mapping record.

## Single Responsibility

- Disband a Feishu group chat by chat ID
- Clean up the corresponding entry in bot-chat-mapping.json
- Report success or failure with clear messages

- DO NOT disband groups automatically (no timers, no scheduled cleanup)
- DO NOT disband groups without user confirmation (handled by card flow before invoking this skill)
- DO NOT use IPC Channel for group operations

## Invocation

This skill is invoked by the agent after the user has confirmed the disband action via a confirmation card. The agent receives the chat ID from the card action or /disband command context.

### Usage

```bash
DISBAND_CHAT_ID="oc_xxxxx" \
DISBAND_MAPPING_FILE="workspace/bot-chat-mapping.json" \
npx tsx skills/disband-group/disband-group.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISBAND_CHAT_ID` | Yes | Feishu group chat ID (oc_xxx format) |
| `DISBAND_MAPPING_FILE` | No | Path to bot-chat-mapping.json (default: workspace/bot-chat-mapping.json) |
| `DISBAND_SKIP_LARK` | No | Set to '1' to skip lark-cli API call (testing only) |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header, or from the card action payload)

Use the Chat ID as `DISBAND_CHAT_ID`.

## Execution Flow

```
1. Validate DISBAND_CHAT_ID (must be oc_xxx format)
2. Find and remove matching entries from bot-chat-mapping.json
3. Check lark-cli availability
4. Call lark-cli im chat disband --chat_id $CHAT_ID
5. Report success or failure
```

### Mapping Cleanup

The script reads bot-chat-mapping.json, finds all entries with the given chatId, removes them, and writes the updated file back. This is done BEFORE the lark-cli disband call so that:
- If lark-cli fails, the mapping is already cleaned (mapping is a cache, per Issue #2985)
- If the group is already disbanded, only mapping cleanup is needed

## When to Use

1. **User confirms disband via card**: After the user clicks "确认" on the confirmation card, invoke this skill with the chat ID.
2. **User sends /disband command**: After sending the confirmation card and the user confirms, invoke this skill.
3. **Group already disbanded**: If the lark-cli disband fails because the group no longer exists, the mapping cleanup is still performed successfully.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| lark-cli disband fails | Report error to user, suggest retrying |
| Mapping record not found | Still attempt disband (mapping is a cache) |
| Group already disbanded | Mapping cleanup succeeds, report success |
| Invalid chat ID format | Exit with validation error |

## Architecture

Group operations (rename, create, disband) use **lark-cli** to call Feishu API directly — NOT through IPC Channel.

## Safety Guarantees

- **User-initiated only**: This skill is only invoked after explicit user confirmation
- **No automatic disband**: The skill itself never triggers disband without user action
- **Input validation**: Chat ID must match `oc_xxx` format
- **Atomic mapping write**: Uses temp file + rename pattern to prevent data corruption
- **No IPC**: Direct lark-cli call, no worker-primary message passing
