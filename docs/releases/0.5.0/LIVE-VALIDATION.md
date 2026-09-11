# Live release validation

Build the checkout before these commands. They use real authenticated model
backends; results belong to the selected checkout and configured provider.

```bash
npm ci --include=dev
npm run build
node scripts/test-codex-live.mjs --output "$PWD/.local/release-0.5.0/codex"
```

The Codex runner uses an isolated temporary working directory and app-server.
It checks a written/read-back tool artifact, acknowledged same-turn steer, stop
during a shell tool, and immediate same-thread continuation. It emits a JSON
record with commit, model, events and outcomes; timeout or failed checks exit
nonzero. `DISCLAUDE_TEST_MODEL` can select the test model (default gpt-5.6-sol).
It does not send channel messages or certify other providers.

For the complete integration harness, prepare a credential-free REST-only config
with a valid Codex backend, an unused loopback port and an isolated file directory:

```bash
CONFIG_PATH=/absolute/test-config.yaml REST_DRAIN_TIMEOUT=120 \
  bash tests/integration/run-all-tests.sh --timeout 120 --retries 0 --delay 0
```

The harness owns its server and passes that ownership to child suites. Standalone
suites refuse to adopt an existing service. Skipped checks and empty execution
return failure rather than a passing release verdict. The async REST probe uses
a unique chat ID, and its drain deadline defaults to the request timeout.

Real send_text/send_file checks additionally require a configured live channel and
an explicitly selected `DISCLAUDE_TEST_DELIVERY_CHAT_ID`. Setting it enables a
"0.5.0 发布验收测试" text and a temporary test-file send to that recipient. Use only
a test destination authorized for those sends. With no destination the checks are
skipped and the suite remains incomplete; the agent merely naming a tool cannot
pass the tool-execution check. A positive agent report still needs a real channel
receipt for the release evidence matrix.

Launchd installation/upgrade/rollback is covered by [the deployment harness](LAUNCHD-REHEARSAL.md).
Docker remains an unverified, non-blocking follow-up by the user’s 2026-09-10
release decision. Other backend checks require their respective runtime and credentials. Do not infer a passing release gate from these local commands.

DeepSeek can be checked through the actual dsh SDK profile using a private local
`.env` containing `DEEPSEEK_API_KEY` and, when needed, `DEEPSEEK_BASE_URL`:

```bash
node scripts/test-deepseek-live.mjs --env-file /absolute/private/.env \
  --model deepseek-v4.1-flash-expires-on-0910 \
  --output "$PWD/.local/release-0.5.0/deepseek"
```

This runner requires Node 20.12+ for `util.parseEnv`. It does not source shell
commands from the env file or print the configured key/endpoint. Five checks cover
single-turn streaming, a real tool artifact and read-back, sequential multi-turn
memory within one input stream, cancellation at a tool-call event, and a new query
with the same logical chat key after cancellation. Any failure/timeout exits
nonzero. The JSON record includes commit, dirty status, model, events and timings.

The 0.1.2 dsh SDK creates persisted sessions and has no load/resume RPC. A new
query therefore uses a fresh native session ID; the post-cancellation check does
not claim restoration of the cancelled native session's history. Multi-turn
context is retained within a live query stream. Feishu delivery is a separate
acceptance check and is not performed by this runner.
