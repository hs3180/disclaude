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

This complements the earlier submission and private-channel checks. A later
real disconnect test on `afef74bc` invalidated the card and allowed a new request
in the same chat; the default-timeout check below adds separate evidence.
A callback concurrent with invalidation and model-native secret questions remain
unverified by these real-channel checks.

On 2026-09-18, combined candidate `fab3e926` with Codex CLI 0.154.0
exercised the unmodified 15-minute deadline through the real Feishu bot. The
model asked a native non-blocking question; Alpha was selected in the desktop
form but never submitted before expiry. The same request remained live beyond
14 minutes. After the deadline, the server card read "回答已过期，未自动选择答案",
the original turn reported that no answer was received, and `answer.txt` was
absent. The user had not selected a default or submitted an answer through chat.

The desktop retained the editing form and its old submit button after the
server update. This is an observed display limitation, not an automatic repaint
pass. Clicking that stale submit button after expiry did not accept the selected
answer or create the file; the desktop then refreshed to the expired card with
no input controls. A subsequent ordinary request in the same chat completed
normally. This verifies stale submission *after* expiry, not a callback racing
the expiry transition.

The original daily service was restored with two health/configuration checks;
all candidate processes were stopped and the temporary workspace and card were
reclaimed. Other conversations recorded during the test were archived back to
the daily workspace without overwriting their histories. Automatic repaint of
an idle desktop remains to investigate before claiming complete input lifecycle
UX acceptance; the comparison below does not isolate editing as the cause.

A short native-desktop comparison on the same date used two cards generated by
the unchanged `fab3e926` adapter, sent in the same acceptance topic with the bot
identity. One form was untouched; Alpha was selected in the other without
submission. Both were updated once to the adapter's expired card through the
message patch API, and independent API readback confirmed the expired content.
Both retained their old controls in desktop accessibility observations until a
normal scroll in the topic, after which both showed the expired state without
controls. Neither form was submitted. New-message and earlier recall displays
also refreshed after native window interaction during this session.

This narrows the finding: the stale display is reproducible without editing,
and a submit callback is not required to show the terminal card. It does not
establish whether client scheduling, foreground state or another delivery/render
condition caused the delay, nor prove unattended automatic refresh. The API
requires `update_multi: true` in both the original and replacement cards; the
adapter already supplies it (see [official message update requirements](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch)).
No retry loop or replacement-message workaround was added. This was a short
card-rendering comparison, not another model deadline or concurrent-callback
test. Both test cards were recalled; the daily service stayed running throughout.

An opt-in E2E uses the installed Codex CLI and configured model credentials to
ask a real tool question, generate the product card, explicitly submit a test
choice, and complete the original turn. Feishu HTTP delivery and the human
submission are simulated; this test sends no Feishu messages. Run it with
`DISCLAUDE_E2E_CODEX_INPUT=1 npx vitest run tests/e2e/codex-user-input.test.ts`.
