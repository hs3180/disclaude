# DSH native tool component probe

Build the workspace and install the pinned `dsh@0.1.2-rc.1` CLI before running.
This opt-in script sends real model requests. The model must be selected explicitly;
the #5215 acceptance model is `gpt-5.6-luna`, with `low` reasoning.

```sh
node tests/dsh/host-tools-probe.mjs \
  --binary /path/to/dsh \
  --oauth-auth-file /path/to/existing/auth.json \
  --model gpt-5.6-luna \
  --output /path/to/new-report.json
```

The supplied auth file must contain an existing, unexpired `tokens.access_token`
for the native `openai-codex` provider route. The probe passes that access value
through its owned child environment and does not refresh or write the auth file.
It uses a temporary DSH home, profile patch, and native conversation, and removes
the owned home after confirmed provider teardown. An existing report path is rejected.

The four phases check canonical tool results, native Session continuity across
provider/process restart, cancellation waiting for owned tool cleanup, and another
native tool call after cancellation. Native request headers are inspected for the
actual provider/model/effort, and the inspected session records are checked for
the probe access credential. The report preserves phase outcomes and failures.

These are synthetic marker tools. The probe does not open or execute a Notebook,
contact Feishu, prove a kernel has stopped, or complete #5215 product acceptance.
The daily model selection remains `gpt-6-luna`.

## Official TypeScript SDK prototype

This is a separate, opt-in real API probe for #5343/#5170. It uses the published
`DeepSeekHarness` client and the existing disclaude native tool adapter in a DSH
plugin. There is no custom worker, boot tree or transport. It sends one model input
per invocation and never runs in ordinary unit CI.

Use Node24+, build this checkout, and install the pinned SDK into a separate,
owned directory. This directory is not a workspace `node_modules` link:

```sh
npm install --prefix /absolute/path/to/isolated-sdk --package-lock=false \
  @deepseek-ai/dsh-sdk-client@0.1.2-rc.1 \
  @deepseek-ai/dsh-llm-pi-ai@0.1.2-rc.1
pnpm run build
node --env-file=/absolute/path/to/model.env tests/dsh/sdk-probe.mjs \
  --sdk-root /absolute/path/to/isolated-sdk \
  --config /absolute/path/to/disclaude.config.yaml \
  --agent dsh-openai --mode minimal --output /absolute/path/to/new-openai-report
```

Select an existing named DSH agent. For Anthropic Messages, use another agent bound
to an LLM with `api.protocol: anthropic`, its provider's Messages base URL and its
own credential reference. For OpenAI Chat Completions, use `api.protocol: openai`.
Use `--mode standard` to select the full SDK profile. Repeat only as a deliberately
separate case with a new output directory; a failed case is never automatically replayed.

The probe isolates the DSH home and Project directory, removes global `dsh` from
the child's PATH, reads an owned Chinese-named material through the plugin, runs
Chinese input in native Bash, checks tool results and the final fact, and awaits
the SDK's `close()`. Only the selected key's environment-variable name enters the
patch. Reports contain outcome fields; native journals remain in the owned home.
Keep that directory private and remove it when its evidence is no longer needed.

The prototype's plugin callback runs in the SDK-owned process. It does not prove
dynamic service-to-host callbacks, persisted resume or per-session cancellation:
the pinned official SDK lacks those public contracts. Closing the runtime is its
cancel boundary. No Feishu message, production configuration, Jupyter kernel or
production deployment is changed by this probe. See the [capability comparison](../../docs/dsh-backend.md#sdk-and-plugin-integration).
