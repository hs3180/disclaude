# Codex input cards

With `agent.agentBackend: codex` and `agent.codex.transport: app-server`,
an active Codex turn can ask questions through a Feishu card. The user chooses
or enters answers and explicitly submits the form. Each answer returns under
its original question ID in the original JSON-RPC response; no new turn or
steering message is created.

The requesting message's actor, chat, source and topic are carried as host-only
context. They are not appended to the model prompt. Only that actor can submit
the bound card in its delivery chat. Missing answers, stale cards, wrong actors,
and duplicate submissions cannot answer another request. The final card removes
input controls and does not echo answers.

Blocking requests retain the active turn and suspend its ordinary no-progress
watchdog while awaiting input. Non-blocking requests leave the turn running.
The `serverRequest/resolved` notification, turn completion, interruption,
transport closure and a 15-minute input timeout invalidate outstanding forms.
Timeout never selects an answer. Unsupported approval and MCP requests remain
independently rejected.

If any question is secret, the entire form goes to the actor's private chat
with the bot. The original topic receives only a generic private-input notice.
Secret text uses a password field; answers bypass ordinary message logging,
action-prompt generation, conversation history and persistent configuration.
They are sent only as the SDK request's response. This does not constrain how
Codex subsequently uses the answer or independently produced model/tool output.

Cards show waiting, submitting, answered, expired or delivery-failure states.
Invalid/incomplete input can be corrected while the request is live. An uncertain
RPC write is not retried, because the first write may have reached Codex. A failed
card repaint never causes a second answer. Repainting is serialized so a delayed
waiting update cannot overwrite the final state.

The implementation follows the locally generated experimental schema from
`codex-cli 0.154.0` and opts into experimental API fields during initialization.
When a host input callback is available, it also enables Codex's
`default_mode_request_user_input` feature for that subprocess. In CLI 0.154.0
this feature is under development and defaults off; without it Default mode
does not offer the tool even when the transport can answer requests. No global
Codex configuration is changed. Older CLI versions must support this feature
before using this integration.

It accepts up to 10 questions with up to 30 options each. The default `exec`
transport has no interactive request/response path and is unchanged.

Core tests cover string and numeric request IDs, multiple question IDs, delayed
answers, requests arriving before the turn-start response, cancellation and
non-blocking expiry. Feishu adapter and actual message-handler route tests check
explicit submission, actor/card/chat binding, no answer echo and duplicate
protection. These fixture tests do not complete the real Feishu acceptance:
visible card, actual user click, original Codex request receiving the answer,
and the original turn finishing must still be demonstrated together (#5000).

An opt-in E2E uses the installed Codex CLI and configured model credentials to
ask a real tool question, generate the product card, explicitly submit a test
choice, and complete the original turn. Feishu HTTP delivery and the human
submission are simulated; this test sends no Feishu messages. Run it with
`DISCLAUDE_E2E_CODEX_INPUT=1 npx vitest run tests/e2e/codex-user-input.test.ts`.
