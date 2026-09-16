# Ordinary ChatAgent browser entry — 2026-09-17

The opt-in browser service E2E now enters through `AgentFactory.createAgent`
and `ChatAgent.runOnce`, using the real dsh backend with `deepseek-flash`.
It does not pre-scrub the provider environment in the test caller.

The macOS run passed in 27.32 seconds (28.18 seconds including test startup).
It injected `BU_CDP_URL` and `CHROMIUM_CDP_PORT` into the parent process and
`BU_CDP_WS=ws://configured-browser-marker.invalid` into the isolated config.
A model-invoked shell probe observed all three absent, and the expected
service-owned browser socket/bin present, both in its Node process and an
ordinary inherited-environment Node child. The real model changed the managed
page through `browser-use`; a separate caller read back its unique marker.

`BROWSER_CHAT_AGENT_ENTRY` reported all assertions true. The enclosing test also
passed browser crash/restart checks and reported root removal, caller closure
and disappearance of its tracked crash descendants. The wrapper removed the
isolated config/DSH directory after success. No production bot connection or
production configuration changed.

## Reproduction and evidence boundary

Use the browser E2E Chromium/Python prerequisites and set
`DISCLAUDE_E2E_BROWSER_CHAT_AGENT_MODEL=deepseek-flash`. Supply model credentials
outside the repository and point `DISCLAUDE_CONFIG_PATH` to an isolated config
with the marked `env.BU_CDP_WS` above. Use an isolated `DSH_HOME`. Run
`node node_modules/vitest/vitest.mjs run tests/e2e/browser-service.test.ts`.
The marker precondition deliberately fails if config injection is missing.
This opt-in path is not enabled in credential-free CI.

This proves a real ordinary ChatAgent/provider/tool entry, with an explicit
command prompt. It is not a natural-language planning benchmark, a model-created
subagent test, Feishu/router delivery, all-provider/platform validation, or a
hostile-agent sandbox. Successful turn completion is not a generic proof that
arbitrary model descendants have exited. An incomplete turn or teardown failure
retains the owned test root for inspection instead of claiming cleanup success.
Issue #5014 remains open for its other launch and deployment requirements.

## Claude SDK ordinary-agent entry

The same actual ChatAgent acceptance can select Claude with
`DISCLAUDE_E2E_BROWSER_CHAT_AGENT_BACKEND=claude`; the default remains `deepseek`.
Other values are rejected. The helper reports the selected backend so dsh and
Claude evidence cannot be confused. Use an isolated `CLAUDE_CONFIG_DIR` as well
as the isolated config and model credentials described above.

On macOS ARM64, Claude Agent SDK 0.3.263 with `deepseek-flash` passed in
26.85 seconds (27.96 seconds including test startup), using runtime source
`d502531522512507e4055d1d3cb585c5d4c957e1` with only this helper selection change.
`BROWSER_CHAT_AGENT_ENTRY` reported `backend: "claude"` and all checks true:
parent/config CDP markers absent in the model's real shell probe and ordinary
Node child, correct IPC socket/bin, model browser write and independent readback.
The browser lifecycle test also passed and reported root removal, caller closure
and tracked crash descendants gone; the private model-config directory was removed.
The helper passed TypeScript and typed ESLint checks.

Inspection of the installed SDK's query/transport path found that an explicit
environment is copied and passed to its process spawn, rather than subsequently
merged with `process.env`. The real probe above verifies the resulting behavior
for this version. It does not establish the environment or prompt of a
model-created subagent. No delegation was requested or exercised, and no
production configuration, Feishu connection or installed package was changed.
