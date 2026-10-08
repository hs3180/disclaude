# Jupyter CLI Skill

[SKILL.md](./SKILL.md) is the agent entrypoint. The executable is
`disclaude jupyter`; it works through the harness's existing shell tool and
requires no ChatAgent extension, persistent agent session or running bot.

## Quick start

Configure `JUPYTERLAB_HOST` and either `JUPYTERLAB_PASS` or
`JUPYTERLAB_TOKEN` in the command environment or a private `.env`. Environment
values take precedence over `.env`. An operator can use `--interactive` in a
TTY; hidden input is never echoed. Agent calls should use `--no-interactive`.
`--env-file` selects a private file outside the Project. URL, password and token
are never persisted in Notebook references or returned by the CLI.

```sh
disclaude jupyter check --no-interactive
disclaude jupyter create --path research/analysis.ipynb --no-interactive
disclaude jupyter list
disclaude jupyter tools
```

The remote parent directory must already exist. `create` checks the selected
path and refuses to overwrite an existing resource. `link` reads an existing
Notebook and returns its stable document ID and opaque `notebookId`.

Use the returned ID and the schemas from `tools` for later commands:

```sh
disclaude jupyter insert-cell --input-file - --no-interactive <<'JSON'
{"notebookId":"<returned-id>","cellId":"analysis-1","beforeCellId":"","cellType":"code","source":"value = 42\nprint(value)"}
JSON

disclaude jupyter read-cell --input-file - --no-interactive <<'JSON'
{"notebookId":"<returned-id>","cellId":"analysis-1"}
JSON

# Use sourceHash returned by read-cell; select a unique runId once.
disclaude jupyter execute --input-file - --no-interactive <<'JSON'
{"notebookId":"<returned-id>","cellId":"analysis-1","expectedSourceHash":"<returned-hash>","runId":"research-001"}
JSON

disclaude jupyter status --input-file - --no-interactive <<'JSON'
{"notebookId":"<returned-id>","runId":"research-001"}
JSON

disclaude jupyter download-report --input-file - --no-interactive <<'JSON'
{"notebookId":"<returned-id>"}
JSON

disclaude channel send_file --chat <request-chat-id> --parent <request-thread-id> \
  --file <returned-html-file-path>
```

## Commands and results

Run `--help` for flags and `tools` for input schemas. Each command emits one
JSON result on stdout: `{ "ok": true, "command": "...", "data": ... }` or
`{ "ok": false, "error": "..." }` with a nonzero exit status. JSON uses
bounded previews; reports and images are files, not embedded binary stdout.

| Commands | Effect |
| --- | --- |
| `tools`, `list` | Read schemas/local references and journal; no connection or file creation |
| `check` | Discover authenticated remote interfaces; no Notebook/kernel creation |
| `link`, `create`, `unlink` | Manage Project references; `create` also creates the remote Notebook; unlink preserves it and its kernel |
| `describe`, `read-cell` | Read live RTC cells and bounded outputs |
| `insert-cell`, `edit-cell`, `move-cell`, `delete-cell` | Change explicitly identified shared cells |
| `execute`, `status`, `stop` | Submit once, query or cancel the original execution handle |
| `import-file` | Copy a regular Project-local file, up to 2 MB, into the remote input directory; return hash, size and kernel-relative path |
| `observe-image` | Save one bounded image artifact for the harness to inspect |
| `export`, `download-report` | Create matching remote HTML/ipynb snapshot; download also retains local files and up to four raster previews |
| `patch` | Existing upstream repair installer, using Jupyter Terminal only |

## Runtime and state

The host needs Node 18+ and a built/installed disclaude. Remote Jupyter supplies
the RTC/file-ID APIs, Datalayer/nbmodel execution interfaces, nbconvert, kernel
and scientific packages. No host Python, local Jupyter, SSH or container
operations are used.

Every command owns and closes its RTC sockets. Closing the CLI or changing a
chat session leaves kernel memory on Jupyter. A later command reopens the same
document and uses the original exclusive kernel binding. Missing kernel memory
is reported; it is not silently replaced after a recorded run.

`<project>/.jupyter/config.json` stores reference metadata only. References pin
the connection label and an endpoint fingerprint; switching the configured
endpoint does not redirect an existing reference. `<project>/.jupyter/datalayer-runs.json`
stores bounded original request facts/results, shared by commands in that
Project. No chat ID, turn state, agent registry or controller lease is stored.
Earlier candidate versions' conversation journals are not automatically migrated.

Concurrent mutating/query commands serialize through `.jupyter/cli.lock` by
refusing a second invocation. Wait for the current command before retrying.
If a process is killed before cleanup, verify the PID recorded in
`.jupyter/cli.lock/pid` is no longer running before removing that lock directory.
Keep the run journal: an unconfirmed pre-submit reservation must not be replayed.

Downloaded files accumulate under `.jupyter/artifacts/report-*` with private
permissions. The caller owns cleanup after inspection/delivery. Remote snapshots
and inputs remain on Jupyter; the CLI does not delete user resources.

## Limits

The CLI provides no atomic server-side cell CAS or multi-client ownership fence.
Client source checks detect observed conflicts but cannot eliminate a concurrent
human edit. Upstream result retention still applies; unavailable original
requests are reported as unknown. A persisted terminal result remains available
locally without replay. Chat `/stop` stops inference only; use `jupyter stop`
for a named remote run and require terminal confirmation.

Skill discovery and CLI/protocol tests are not evidence of real model research,
channel delivery or device acceptance. Those require their own recorded tests.
