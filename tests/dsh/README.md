# DSH native tool component probe

Build the workspace and install the pinned `dsh@0.1.2-rc.1` CLI before running.
This opt-in script sends real model requests. The model must be selected explicitly;
the #5215 acceptance model is `gpt-5.6-luna`, with `low` reasoning.

```sh
node tests/dsh/native-tools-probe.mjs \
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
