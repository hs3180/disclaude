# Codex input cards

With `agent.agentBackend: codex` and `agent.codex.transport: app-server`, Codex
can ask a user for structured input through a Feishu card. The user must submit
the form explicitly; timeout never selects a default answer.

## Request types

- **Blocking request:** The card answers the original app-server request using
  its question IDs. This resumes the same request; it does not start a new turn
  or send a steering message.
- **Non-blocking request:** When supported by the installed Codex CLI, the card
  response is sent as a user message with the originating turn ID. The existing
  turn continues; the response is not delivered as a second request. This input
  is non-secret and can appear in normal Codex conversation history.

The `exec` transport has no interactive request/response path and is unchanged.
The exact model-facing tool availability depends on the installed Codex version
and configuration; protocol support does not guarantee that a model will ask
for every input type.

## Privacy and lifecycle

The request is bound to its originating actor, chat, topic and turn. Only that
actor can submit it in the bound chat. Stale, duplicate, incomplete or
out-of-scope submissions cannot answer another request. Cards show the current
waiting, submitting, answered, expired or delivery-failure state; submitted
answers are not echoed in the card.

If a blocking request contains a secret question, the complete form is sent to
the actor's private chat with the bot. The originating topic receives only a
generic notice. Secret values use masked inputs and bypass ordinary message
logging, action-prompt generation, conversation history and persistent
configuration; they are returned only in the SDK response. This does not
control how Codex later uses the answer or what it emits in tool/model output.
Never collect credentials through an ordinary non-secret question.

Outstanding requests have a bounded deadline and suspend the ordinary
no-progress watchdog while waiting. Turn completion, interruption, transport
closure and timeout invalidate the card. An uncertain RPC write is not retried,
because the first answer may already have reached Codex. A card repaint failure
does not submit a second answer.

Unsupported approval and MCP requests remain rejected. See the [Codex backend
guide](codex-backend.md) for transport setup and [Feishu setup](feishu-setup.md)
for bot permissions.
