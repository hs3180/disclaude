---
name: start-discussion
description: "Initiate a non-blocking discussion by creating a Feishu group, sending context, and recording the mapping. Use when the agent identifies a topic needing deeper discussion with the user, wants to delegate an offline question, or needs to spawn a sub-agent conversation without blocking current work. Keywords: 'start discussion', '发起讨论', '创建讨论群', '离线提问', 'offline question', 'start-discussion', '非阻塞讨论'."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Start Discussion — Non-blocking Discussion Initiation

Agent 识别到需要深入讨论的话题后，创建飞书讨论群、通过 `push_to_agent` 注入初始化上下文、记录映射，立即返回（不阻塞当前工作）。

**适用于**: 发起讨论、离线提问、非阻塞交互 | **不适用于**: 解散群（用户驱动）、PR 审查群（用 PR Scanner）

## When to Use

- Agent 在工作中发现需要与用户深入讨论的话题（用户重复指令、多步反复修正、隐式抱怨、花费较大的工作存疑等）
- Agent 需要用户输入但不想阻塞当前任务
- Agent 想要委派一个问题让用户在独立群中讨论
- 定时任务分析发现需要讨论的问题

## Single Responsibility

- ✅ Create a Feishu discussion group via `lark-cli`, owned by the triggering user
- ✅ Send and pin its first positioning post, then reply with a migration card in the source thread via the handoff script
- ✅ Inject initialization context via `push_to_agent` MCP tool only after that handoff succeeds
- ✅ Record mapping in `workspace/bot-chat-mapping.json`
- ✅ Return immediately — non-blocking by design
- ❌ DO NOT wait for user response in the discussion group
- ❌ DO NOT dissolve groups — let users handle lifecycle
- ❌ DO NOT use IPC Channel for group operations — use `lark-cli` via Bash
- ❌ DO NOT create PR review groups (use PR Scanner skill)

## Context Variables

When invoked, you receive:

- **Chat ID**: Source chat where the discussion topic was identified
- **Message ID**: The triggering message ID
- **Sender Open ID**: The user who triggered the discussion

## Workflow

### Step 1: Determine Discussion Topic and Context

Analyze the current conversation and determine:

1. **Topic**: A concise title for the discussion (max 64 chars for group name)
2. **Question**: The specific question or issue to discuss
3. **Background**: Relevant context — chat history excerpts, file references, error logs, etc.
4. **Participants**: Open IDs of additional users to include (optional — sender is always included automatically)

### Step 2: Create Group and Complete the Handoff

Run the bundled handoff script exactly once. It uses argument arrays (never a shell) and performs this ordered chain: create with `--owner {sender_open_id}` → send the first **群定位声明** → pin that message → reply with a migration card in the source thread. The script stops at the first failed stage; do not blindly rerun it after a partial result.

```bash
node skills/start-discussion/scripts/create-discussion.mjs <<'JSON'
{
  "topic": "{topic}",
  "senderOpenId": "{sender_open_id}",
  "sourceMessageId": "{triggering message_id}",
  "participants": ["ou_xxx", "ou_yyy"],
  "ledgerRule": "本群台账只记录本群决策与交付，原群历史不重复搬运。",
  "idempotencyKey": "discussion-{short-uuid}",
  "runtime": { "preset": "codex-high" }
}
JSON
```

`participants`, `ledgerRule`, `idempotencyKey`, and `runtime` are optional. The triggering user is always included and made owner. Successful JSON output contains `chatId`, `ownerOpenId`, `firstPostMessageId`, `pinned: true`, and `migrationMessageId` (plus `runtime` echoing the validated profile when declared); retain these for the next steps. The first post states 本群管什么 / 原群保留什么 / 执行流水去处 / 台账规则. The source-thread card points to the new group and states that this thread no longer receives the topic's execution stream.

**Runtime profile (Issue #4913)**: `runtime` declares which runtime the new group's agent uses from its first turn — either a named preset from the service's configured enabled catalog (`{"preset": "name"}`) or an explicit triple (`{"harness": "codex", "model": "gpt-5.2-codex", "thinking": "high"}`). It never carries credentials or endpoints. The script validates it against the service (`POST /api/agent-runtime`, needs `DISCLAUDE_API_BASE_URL`) BEFORE creating the group; an incompatible or unsupported declaration aborts with an actionable error and no group is created. Only the codex harness supports a `thinking` level; declaring one elsewhere fails instead of silently degrading. After the group is created, pass the SAME `runtime` to `push_to_agent` (Step 3) so the binding is persisted before the first prompt — the group's first turn then runs on it. The binding sits below an in-session `/agent use` and above per-app/global defaults.

If `lark-cli` is not available, report the unchanged command error and stop:

```bash
lark-cli --version || echo "ERROR: lark-cli not found in PATH"
```

**Direct-command boundary**: a bare `lark-cli im +chat-create` bypasses this handoff and is not intercepted by the service. It is unsupported for this skill; if used outside the skill, the caller must explicitly supply `--owner` and complete and verify the same first-post/pin/source-reply chain. There is no claim of rollback or atomicity across Feishu API calls: on a stage error, inspect the already-created group before retrying.

### Step 3: Inject Context via `push_to_agent`

Use the `push_to_agent` MCP tool to send an initialization instruction to the new group's agent. This triggers lazy agent creation and injects a system instruction.

```
push_to_agent(chatId: "{new group chatId}", message: "{initialization prompt}", runtime: {preset: "{declared preset}"} | {harness: "...", model: "...", thinking: "..."})
```

When the group was created with a `runtime` declaration, pass the SAME declaration here (`runtime` param, or `--runtime '<json>'` on the channel CLI). The service binds it durably to the chat BEFORE routing this first prompt, so the first turn already runs on the selected runtime; the response echoes the effective profile. Without it the first turn would fall back to the chat's per-app/global default.

The initialization prompt should include:

- The discussion topic and purpose
- The source chat ID (for traceability)
- Background materials and the specific question to discuss
- Instructions for the agent (e.g., "引导用户讨论以上问题")

**Note**: `push_to_agent` handles agent creation automatically. The agent will then manage the conversation in the new group using its standard messaging capabilities (`send_text`, `send_interactive`, etc.).

### Step 4: Record Mapping

Append the new group to `workspace/bot-chat-mapping.json`:

```bash
# Read current mapping
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

Add an entry with key `discussion-{short-uuid}`:

```json
{
  "discussion-{uuid}": {
    "chatId": "oc_xxx",
    "createdAt": "{ISO timestamp}",
    "purpose": "discussion"
  }
}
```

Write the updated mapping atomically (write to temp file, then move):

```bash
echo '{ ... updated JSON ... }' > workspace/bot-chat-mapping.json.tmp \
  && mv workspace/bot-chat-mapping.json.tmp workspace/bot-chat-mapping.json
```

### Step 5: Confirm and Return

The script has already posted the migration card in the **source thread**; do not depend on the agent remembering a second manual message. Confirm that its output has `pinned: true` and `migrationMessageId`, then report completion if needed:

> 已创建讨论群「{topic}」，首帖定位声明已置顶，原 thread 已发迁移卡。我将继续当前工作，讨论结果稍后会处理。

**Do NOT wait for any response** — return immediately.

## lark-cli Command Reference

| Operation                               | Command                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete discussion handoff (preferred) | `node skills/start-discussion/scripts/create-discussion.mjs` with the JSON input above                                                        |
| Create group                            | `lark-cli im +chat-create --name "..." --description "..." --users "{sender_open_id}" --owner "{sender_open_id}"`                             |
| Create group with extra participants    | `lark-cli im +chat-create --name "..." --users "{sender_open_id},ou_xxx,ou_yyy" --owner "{sender_open_id}"`                                   |
| Send first positioning post             | `lark-cli im +messages-send --chat-id "oc_xxx" --text "【群定位声明】..."`                                                                    |
| Pin positioning post                    | `lark-cli im pins create --data '{"message_id":"om_xxx"}'`                                                                                    |
| Reply with source-thread migration card | `lark-cli im +messages-reply --message-id "om_source" --reply-in-thread --text "【话题迁移】..."`                                             |
| Add members                             | `lark-cli im chat.members create --params '{"chat_id":"oc_xxx","member_id_type":"open_id","succeed_type":1}' --data '{"id_list":["ou_aaa"]}'` |
| Dissolve group                          | `lark-cli api DELETE /open-apis/im/v1/chats/oc_xxx`                                                                                           |

## Error Handling

| Error                    | Action                                                                     |
| ------------------------ | -------------------------------------------------------------------------- |
| `lark-cli` not in PATH   | Report to source chat: "无法创建讨论群，lark-cli 未安装"                   |
| Group creation fails     | Report error, do not create mapping entry                                  |
| Mapping file write fails | Report warning (group was created, mapping is a cache)                     |
| `push_to_agent` fails    | Report to source chat; the group was created but agent was not initialized |

## Design Principles

1. **Non-blocking**: Return to source chat immediately after sending context
2. **`push_to_agent` for initialization**: Use MCP tool for agent creation + context injection, NOT `send_text`/`send_interactive`
3. **Idempotent**: Check mapping table before creating (avoid duplicates)
4. **Cache is rebuildable**: `bot-chat-mapping.json` can be reconstructed from Feishu API
5. **No IPC for group ops**: Direct `lark-cli` calls via Bash — no MCP/IPC indirection

## Feedback Origin — This Group Is Not a Feedback Channel

> Issue #4017. When this group is the **execution chat** of a longer-running delegated task driven by scheduled runs, it carries progress updates and delivery only. User feedback — corrections, intent changes, scope or source-preference adjustments — originates in the **initial conversation** with the user, not here.

If the task maintains a shared state file (e.g. `RESEARCH.md`), feedback flows only through that file's dedicated `## User Feedback` section (append-only, timestamped, one point per entry). If it does not, tell the user in the initialization prompt to give feedback in the source chat rather than in this group.

Concretely, when composing the initialization prompt (Step 3):

- If a state file with a feedback section exists, tell the execution agent to **re-read the `## User Feedback` section at the start of every run** and carry it forward verbatim when writing state back.
- Either way, do **not** tell the execution agent to read the initial conversation's messages — the state file is the single feedback channel, and cross-conversation message reading is out of scope (the earlier approach was reviewed and rejected; see closed PR #4030).

## Integration with Other Skills

| Skill                      | Relationship                                                   |
| -------------------------- | -------------------------------------------------------------- |
| External review automation | May manage review groups separately                            |
| `daily-chat-review`        | May trigger `start-discussion` when repetitive issues detected |
| `daily-soul-question`      | May trigger `start-discussion` for deep reflection topics      |
