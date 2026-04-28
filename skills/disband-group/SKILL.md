---
name: disband-group
description: Disband (dissolve) a Feishu group chat with user confirmation. Use when user clicks "解散群" button or says "/disband" in a PR discussion group. Keywords: "解散群", "disband group", "dissolve chat", "/disband", "关闭讨论群".
allowed-tools: [Bash, Read, Write]
---

# Disband Group

User-triggered Feishu group dissolution with mandatory two-step confirmation.

## Single Responsibility

- ✅ Send confirmation card before disbanding
- ✅ Disband a Feishu group via lark-cli
- ✅ Remove the mapping entry from `workspace/bot-chat-mapping.json`
- ✅ Handle errors gracefully (API failure, already disbanded, mapping missing)
- ❌ DO NOT disband without explicit user confirmation
- ❌ DO NOT auto-disband (no timers, no timeout triggers)
- ❌ DO NOT disband groups the bot didn't create

## Trigger Sources

| Source | Scenario |
|--------|----------|
| Card button "解散群" | PR merged/closed notification card |
| Card button "解散群" | After user clicks "Close PR" |
| User command `/disband` | User types in the discussion group |

## Confirmation Flow

When the disband-group skill is triggered, follow this exact flow:

### Step 1: Send Confirmation Card

Send a confirmation card to the current chat:

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "⚠️ 确认解散讨论群", "tag": "plain_text"}, "template": "orange"},
    "elements": [
      {"tag": "markdown", "content": "确定要解散此讨论群吗？解散后群聊将不可恢复。"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm_disband", "type": "danger"},
        {"tag": "button", "text": {"content": "取消", "tag": "plain_text"}, "value": "cancel_disband"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{{current_chat_id}}",
  "actionPrompts": {
    "confirm_disband": "[用户操作] 用户确认解散群。请立即执行解散操作：1. 运行 disband-group 脚本 2. 报告结果",
    "cancel_disband": "[用户操作] 用户取消解散群。无需任何操作。"
  }
}
```

### Step 2: Execute Disband (on confirmation)

When user confirms, run the disband script:

```bash
DISBAND_CHAT_ID="{{current_chat_id}}" \
DISBAND_MAPPING_KEY="{{mapping_key}}" \
npx tsx skills/disband-group/disband-group.ts
```

### Step 3: Report Result

Based on the script output:
- **Success**: Send a brief message "✅ 讨论群已解散"
- **Failure**: Send error message and suggest retry

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Mapping Key**: The key in bot-chat-mapping.json (e.g., "pr-123"). If not available, derive it from the group name or skip mapping cleanup.

## Safety Guarantees

- **Two-step confirmation**: Always show confirmation card before disbanding
- **User-initiated only**: Bot NEVER auto-disbands any group
- **Same-chat constraint**: Can only disband the current group (cannot disband other groups)
- **Mapping cleanup**: Always attempts to remove the mapping entry after disband
- **Idempotent**: Disbanding an already-disbanded group is safe (only cleans up mapping)
- **Error resilient**: API failure preserves the mapping so user can retry

## When NOT to Use

- Never disband groups for other chats
- Never disband without user confirmation
- Never trigger automatically via schedule or timer
- Never disband the main/control chat
