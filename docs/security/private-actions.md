# Agent-defined private workflows

The agent specifies a workflow at task time. There is no `feishu.privateAction` configuration, preset consumer catalog or service restart to register a workflow. Disclaude supplies the separate input path and binds each submission to that request's actor, chat, source message, card and one-use nonce.

## Request a workflow

The service must run with API authentication (`--api-token`). Managed agents receive `DISCLAUDE_API_BASE_URL` and `DISCLAUDE_API_TOKEN`. This credential authorizes the agent to select executable code running as the service user; keep it within the trusted agent environment. An unconfigured token disables this endpoint, and missing/wrong tokens are rejected. This is the existing service API trust boundary, not a new per-agent permission or delegation system.

The agent writes or selects the workflow implementation, then POSTs to `/api/private-workflows` with `Authorization: Bearer <service API token>` and this JSON shape:

```json
{
  "chatId": "oc_current_conversation",
  "actorId": "ou_initiating_user",
  "sourceMessageId": "om_source_message",
  "workflow": {
    "title": "Complete this task's authentication",
    "description": "Use the input only for the workflow described to the user",
    "command": "/absolute/path/to/node",
    "args": ["/workspace/task-workflow.mjs"],
    "cwd": "/workspace",
    "timeoutMs": 30000
  }
}
```

These are task-selected values, not host presets. `env` is an optional string map; when omitted, the process inherits the service environment. Provide the current conversation's chat, initiator and source IDs; the eventual Feishu callback must match them. The authenticated agent chooses the workflow; it cannot be replaced by fields submitted in the form callback. The description is public, so never put the private input there or anywhere in this request.

A successful response is `{ "ok": true, "actionId": "..." }`: the card was delivered, not that the workflow has completed. The input card is opened immediately; the user does not need to issue `/private` or select a configured action.

## Consume the private input

The agent-selected process reads the original input from stdin and verified `action`, `actor`, `chat`, `source` and `correlationId` metadata from `DISCLAUDE_PRIVATE_CONTEXT`. The agent chooses how to implement authorization, provider exchanges, endpoint selection and credential lifecycle. A workflow can perform multiple steps in its own process. Disclaude does not inspect or impose those policies.

The process runs only after a matching submission. Its stdout/stderr are suppressed; exit zero returns a fixed success message, other exits or timeout a fixed failure. The host does not copy the original value to prompts/history, argv, environment or `.runtime-env`. If the workflow deliberately persists or uses it elsewhere, that lifecycle belongs to the agent.

Forms expire after five minutes. Reissuing for the same actor/chat, channel shutdown or restart revokes pending requests. Another actor or chat cannot use the binding, and replay cannot rerun the workflow. Different actors/chats have independent requests. Request definitions live only in memory. Expiry or revocation of a pending form does not roll back a workflow that has already received input; the workflow must finish within its execution timeout. Process-group cleanup is resource management, not an OS sandbox.

Programmatic injection through `FeishuChannelConfig.privateInput` remains supported for existing callers. It is optional and is not the mechanism agents use to define workflows. #4973's broader task-grant contract remains separate.
