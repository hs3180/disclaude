---
name: dissolve-group
description: Dissolve a Feishu group chat and clean up associated resources (mapping entry, temp workdir). Use when a PR is merged/closed, a discussion is finished, or a group needs to be removed. Keywords: "解散群", "dissolve group", "删除群", "close group", "清理群".
allowed-tools: [Bash, Read, Write, Edit]
---

# Dissolve Group

Dissolve a Feishu group chat via lark-cli API and clean up all associated resources.

## Single Responsibility

- ✅ Dissolve Feishu group via `DELETE /open-apis/im/v1/chats/{chatId}`
- ✅ Remove mapping entry from `bot-chat-mapping.json`
- ✅ Clean up temp workdir if exists
- ❌ DO NOT dissolve groups the bot didn't create
- ❌ DO NOT use `lark-cli chat delete` (wrong command — only removes bot membership)
- ❌ DO NOT send messages before dissolving

## Invocation

Provide the chatId or mapping key to dissolve:

### By chatId

```bash
DISSOLVE_CHAT_ID="oc_xxxxx" npx tsx skills/dissolve-group/dissolve-group.ts
```

### By mapping key (e.g. pr-123)

```bash
DISSOLVE_KEY="pr-123" npx tsx skills/dissolve-group/dissolve-group.ts
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISSOLVE_CHAT_ID` | One of | Feishu group chat ID (oc_xxx format) |
| `DISSOLVE_KEY` | one | Mapping key (e.g. `pr-123`) |
| `MAPPING_FILE` | No | Path to mapping file (default: `workspace/bot-chat-mapping.json`) |
| `DISSOLVE_SKIP_LARK` | No | Set to `1` to skip group dissolution (testing only) |

## Execution Flow

```
1. Resolve key ↔ chatId
   ├─ If DISSOLVE_KEY given → look up chatId from mapping file
   └─ If DISSOLVE_CHAT_ID given → look up key from mapping file (reverse lookup)

2. Dissolve the Feishu group
   └─ lark-cli api DELETE /open-apis/im/v1/chats/{chatId} --as bot

3. Clean up temp workdir (if mapping entry has workdir field)
   └─ rm -rf "{workdir}"

4. Remove mapping entry
   └─ Delete the key from bot-chat-mapping.json, atomic write

5. Report result
```

## Safety Guarantees

- **Idempotent**: Re-running on already-dissolved group is safe (error 232009/99991672 ignored)
- **Atomic**: Mapping file uses temp+rename write pattern
- **Validation**: chatId must be `oc_xxx` format
- **No partial state**: Group dissolution failure doesn't remove mapping (allows retry)

## When to Use

1. **PR merged/closed**: The PR scanner detects a closed PR, triggers dissolution
2. **Manual cleanup**: User explicitly requests group removal
3. **Orphan cleanup**: Mapping entry exists but group is already dissolved

## Related Skills

| Skill | Role |
|-------|------|
| `pr-scanner` | Creates groups, tracks mappings |
| `start-discussion` | Creates discussion groups |
