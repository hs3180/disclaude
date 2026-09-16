# Codex input cards

With `agent.agentBackend: codex` and `agent.codex.transport: app-server`,
an active Codex turn can ask questions through a Feishu card. The user chooses
or enters answers and explicitly submits the form. Server-request questions
return answers under their original question IDs in the original JSON-RPC
response; that path never creates a new turn or steering message.

Codex 0.154.0 also exposes `request_user_input_async`. Its questions arrive in
`agentMessage.questions` after the tool has already returned `accepted:true`.
These notifications use the same explicit card UI, preserving full question
and option strings and allowing free-text answers. They have no pending RPC.
Submission instead sends one ordinary user message with `turn/steer` and the
originating `expectedTurnId`. It cannot start a new turn or answer a later one.
The question's duplicate text delivery is suppressed when a card handles it.
Async questions are non-blocking and non-secret; their answers can appear in
Codex's normal user-message history. Secret input remains exclusive to the
separate RPC protocol path described below.

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
Turn completion, interruption, transport closure and a 15-minute input timeout
invalidate outstanding forms. `serverRequest/resolved` additionally invalidates
the matching RPC form.
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
card repaint never causes a second answer. Answer delivery does not wait for
the submitting card or any earlier repaint to finish, so channel update latency
cannot hold a timely submission past the input deadline. Repainting is serialized
so a delayed waiting update cannot overwrite the final state.

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

An opt-in E2E uses the installed Codex CLI and configured model credentials to
ask a real tool question, generate the product card, explicitly submit a test
choice, and complete the original turn. Feishu HTTP delivery and the human
submission are simulated; this test sends no Feishu messages. Run it with
`DISCLAUDE_E2E_CODEX_INPUT=1 npx vitest run tests/e2e/codex-user-input.test.ts`.
On checkouts with the separated E2E runner (`test:e2e` in package.json), use
`DISCLAUDE_E2E_CODEX_INPUT=1 npm run test:e2e -- tests/e2e/codex-user-input.test.ts`
instead: the default unit configuration excludes `tests/e2e/**`. Verify that the
output reports one executed, passing RPC test; skipped or undiscovered tests
are not validation.

This test explicitly uses `gpt-5.6-luna`. The RPC case is the default; setting
`DISCLAUDE_E2E_CODEX_ASYNC_INPUT=1` also enables the optional async capability
probe. The observed Luna session reported that async tool unavailable, so that
case is not counted as a Luna pass. Neither invocation falls back to Astra.

### Integrated retest: asynchronous question path not handled

On 2026-09-18, candidate `360330e4` combined main `d0cb71bb`, submission-latency
fix `2d6e2d87`, the TASK.md removal and contextual feedback guidance. Build and
69 adapter/project/skill tests passed. A fresh production-bot workspace was used
for a native Feishu request to ask Alpha/Beta and write `answer.txt` only after
explicit submission. This retest did **not** produce an input card.

The actual Codex 0.154.0 rollout recorded `request_user_input_async`, whose
arguments contained question titles and option strings, followed immediately by
`{"accepted":true}`. Feishu received a text question; the model then waited in
sleep calls. No answer was submitted and no answer file was created. A native
`/stop` ended the test. The original service was restored, configuration and
plist hashes matched, independent health checks passed, and the owned workspace
was archived and removed. There was no card to recall.

The experimental schema generated from that installed CLI includes
`AsyncUserInputQuestion` under `agentMessage.questions`, with `title` and optional
string options. This is distinct from the server-initiated
`item/tool/requestUserInput` request supported by this adapter. The observed
async tool result is already complete; do not invent a pending JSON-RPC ID or
treat a later chat message as its original response. The notification path
requires its own integration and verification.
Earlier real request/response card successes remain scoped evidence; they do
not make this integrated retest a pass.

The subsequent fix handles those notifications separately. A real CLI probe
confirmed that a submitted Beta message via `turn/steer` returned the same turn
ID and that turn completed with the expected marker. The product model test
then exercised actual async questions, the Feishu card renderer, simulated
explicit submission and same-turn completion. This is model plus adapter
evidence, not a successful repeat of the failed native Feishu test above.

### Luna native Feishu retest

The user subsequently required `gpt-5.6-luna` for all disclaude runs and tests.
The earlier successful async model probes used Astra before that requirement;
they do not establish Luna's tool availability. A Luna RPC model/adapter test
passed, while its async probe produced no request and reported the tool missing.

On 2026-09-18, integrated candidate `f833147e` included main `a568158e`, the
input fixes and contextual feedback guidance, with TASK.md functionality removed.
Both default and Codex-preset configuration selected Luna, independently confirmed
by the actual rollout. The model issued native `request_user_input` in a fresh
production-bot workspace. Its Feishu card offered Alpha/Beta and free input.
The native form was filled with `Beta` and explicitly submitted once.

The original call received `{"answers":{"choice":{"answers":["Beta"]}}}`,
`answer.txt` contained `Beta` with a trailing newline, and the same turn completed.
Independent card API readback showed “已回答” with no controls. This proves the
native submission loop on Luna; terminal desktop repaint was not re-inspected
and remains outside this result. Computer use was limited to the necessary
interaction and one screenshot; API, rollout and files supplied result checks.

The original daily service was restored, configuration/plist hashes matched and
an independent health check passed. Candidate processes exited, owned workspace
files were archived with hashes, the temporary root was removed and the test
card was recalled. No PR was merged by the agent.

### Codex 0.155 Luna non-blocking protocol probe

Codex 0.155 exposes the non-blocking capability to the model through its
`request_user_input` surface; the app-server request is distinguished by
`isBlocking: false`. When a host input callback is installed, disclaude passes
the scoped override `-c tools.experimental_request_user_input={enabled=true}`
alongside `--enable default_mode_request_user_input`. This is applied only to
the owned app-server child and does not modify the user's global Codex config.

The opt-in E2E therefore asks for the non-blocking protocol rather than naming
the removed `request_user_input_async` model tool. On 2026-09-19 with
`gpt-5.6-luna`, the provider emitted `item/tool/requestUserInput` with
`isBlocking: false`, the simulated Feishu card was answered once, and the same
turn completed. The blocking RPC case also passed separately. Both checks use
the product provider and card adapter; Feishu HTTP delivery and human input are
simulated, and no Computer Use call is made. The stale desktop idle-card repaint
finding above remains a separate visual limitation.
