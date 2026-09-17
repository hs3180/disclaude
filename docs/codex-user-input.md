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

Outstanding input requests suspend the ordinary no-progress watchdog until they
are answered or invalidated. This includes non-blocking requests: Codex may remain
idle while awaiting the user even when it is allowed to continue. Non-blocking
requests still leave the turn running; messages and turn completion are processed
normally. The separate 15-minute input deadline bounds the wait, after which the
ordinary watchdog resumes.
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
The service image pins Codex 0.154.0 to match the CLI used for the real input test.

Protocol support does not imply that the model can generate every field. In
Codex 0.154.0, the model-facing `request_user_input` tool exposes only `id`,
`header`, `question` and non-empty `options`; it does not expose `isSecret`.
See the [upstream tool definition and normalization](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/handlers/request_user_input_spec.rs).
The adapter handles secret requests received through the protocol, but this
pinned model tool cannot initiate that path. Do not ask users to enter credentials
into an ordinary non-secret question as a workaround.

It accepts up to 10 questions with up to 30 options each. The default `exec`
transport has no interactive request/response path and is unchanged.

Core tests cover string and numeric request IDs, multiple question IDs, delayed
answers, requests arriving before the turn-start response, cancellation and
non-blocking expiry. Feishu adapter and actual message-handler route tests check
explicit submission, actor/card/chat binding, no answer echo and duplicate
protection. These fixture tests do not replace real Feishu acceptance. On 2026-09-16,
a real card selection and submission returned Beta to the original Codex request
and completed the same turn. A separate attempt exposed the ordinary watchdog
cancelling a non-blocking question after three minutes; the pending-input watchdog
fix has regression coverage and passed a real Feishu retest: after more than
four minutes, a two-question card accepted a selected option and a separate
free-text answer, then completed the same turn with both values.

A separate scripted protocol request with `isSecret: true` passed through the
real production-bot Feishu channel on the same date. Its private card used a
masked field and explicit submission; the original RPC received exactly one
correct response, and the card changed to answered without echoing the value.
The public topic contained only the generic notice, with neither the private
question nor the dummy answer. A scan of service logs, that day's conversation
logs and runtime configuration found no dummy answer. This verifies the real
channel with a protocol fixture, not model-native secret-question generation.
The latter remains unavailable in the pinned tool; remaining lifecycle
acceptance is tracked in #5000.

On 2026-09-17, the branch rebased onto `baa0d9c3` passed another real native
Feishu check (`be27c055`): the model issued a non-blocking `request_user_input`,
and the desktop displayed the question, options, free input and explicit submit
button. No answer was submitted. A `/stop` message in the originating chat
aborted the original turn; the same card changed to “已取消” and removed its
input controls. Independent API readback confirmed that state, the requested
answer artifact was absent, and the service had no remaining Codex child.
The daily service was restored with unchanged configuration and launchd plist
hashes; the test card and owned temporary workspace were reclaimed.

This complements the earlier submission and private-channel checks. It does not
prove a real stale callback racing cancellation, timeout or transport-disconnect
rendering, or model-native secret questions. Protocol and adapter fixtures cover
those applicable lifecycle transitions separately; final deployment validation
must preserve that distinction.

An opt-in E2E uses the installed Codex CLI and configured model credentials to
ask a real tool question, generate the product card, explicitly submit a test
choice, and complete the original turn. Feishu HTTP delivery and the human
submission are simulated; this test sends no Feishu messages. Run it with
`DISCLAUDE_E2E_CODEX_INPUT=1 npx vitest run tests/e2e/codex-user-input.test.ts`.
