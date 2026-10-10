---
name: dissolve-group
description: "Dissolve a Feishu group chat and clean up associated resources. Use when a PR is merged/closed, a discussion is finished, or a group needs to be removed. Keywords: \"解散群\", \"dissolve group\", \"删除群\", \"close group\", \"清理群\"."
allowed-tools: [Bash, Read, Write, Edit]
---

# Dissolve Group

Dissolve a Feishu group chat via lark-cli API and clean up all associated resources (mapping entry, temp workdir).

## Single Responsibility

- ✅ Dissolve Feishu group via `DELETE /open-apis/im/v1/chats/{chatId}`
- ✅ Remove mapping entry from `bot-chat-mapping.json`
- ✅ Clean up temp workdir if exists
- ❌ DO NOT dissolve groups the bot didn't create
- ❌ DO NOT use `lark-cli chat delete` (wrong command — only removes bot membership)
- ❌ DO NOT send messages before dissolving

## Invocation

Before invoking, verify that this bot created the target group using its native
creation receipt or the lifecycle mapping written from that receipt. An absent
`owner_id` does not identify a creator: Feishu omits that field for bot owners.
Do not infer creation provenance from a group name or bot membership.

The native DELETE API performs the authoritative permission check: the caller
must be the bot owner, or the bot creator with `im:chat:operate_as_owner`, and
have `im:chat` or `im:chat:delete`. A permission denial is a failure and retains
the mapping and workdir. See the [official DELETE contract](https://open.feishu.cn/document/server-docs/group/chat/delete).

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
| `DISSOLVE_SKIP_LARK` | No | Set to `1` for local cleanup simulation only; reports `dissolved: "skipped"`, not native success |

## Execution Flow

```
1. Resolve key/chatId
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

- **Idempotent**: Only structured native code `232009` proves the group was already dissolved. Invalid IDs, missing scopes (`99991672`), permission denials (`232017`), HTTP 404 or unknown CLI output are failures.
- **Atomic**: Mapping file uses temp+rename write pattern
- **Validation**: chatId must be `oc_xxx` format
- **No partial state**: Group dissolution failure doesn't remove mapping (allows retry)
- **Native result**: CLI exit zero alone is insufficient; require a parsed successful API/CLI envelope before cleanup.
- **Temp cleanup**: Only paths resolving beneath the real `/tmp` root are removed. Traversal and symlinks outside that root are skipped and reported accurately.

## When to Use

1. **PR merged/closed**: The PR scanner detects a closed PR, triggers dissolution
2. **Manual cleanup**: User explicitly requests group removal
3. **Session timeout**: Integration with chat-timeout for timed groups

## Architecture

```
bot-chat-mapping.json ──read──→ resolve chatId/key
       │
       ├─→ lark-cli api DELETE /open-apis/im/v1/chats/{chatId}  (dissolve group)
       ├─→ rm -rf {workdir}                                       (cleanup temp dir)
       └─→ delete key from mapping file                           (remove entry)
```

## Related Skills

| Skill | Role |
|-------|------|
| External automation | May create groups and track their lifecycle |
| `chat-timeout` | Dissolves groups for expired temporary chats |
| `rename-group` | Renames groups via lark-cli |
| `start-discussion` | Creates discussion groups |
