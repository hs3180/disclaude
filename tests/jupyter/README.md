# Configured Jupyter CLI acceptance probes

These opt-in probes exercise the public `disclaude jupyter` CLI merged in
[#5282](https://github.com/hs3180/disclaude/pull/5282). Build this checkout with
`npm ci` and `npm run build`. Every Notebook operation launches a fresh Node
CLI process with `--no-interactive`; Project references and the original-run
journal survive between commands. No Notebook session factory, ChatAgent hook,
service lifecycle owner or host Python is needed.

Use the existing remote server from a host-private `.env` containing
`JUPYTERLAB_HOST` / `JUPYTERLAB_PASS`. The shared CLI authentication helper
also supports environment credentials and tokens. These automated probes never
prompt; interactive authentication is checked separately by the auth tests.
The repair installer is `disclaude jupyter patch` through Jupyter Terminal;
see the [patch guide](../../jupyter/datalayer/README.md). Probes do not install
patches or manage remote machines, containers or Jupyter service restarts.

Probe runners require Node 22 or newer (the public CLI has separate compatibility checks).
Receipts record the Git commit/dirty state and probe/CLI source hashes.
All output directories must be new and are created with private permissions.
Reports preserve failed checks and distinguish phase completion from success.
`cli-commands.json` records command, actual child PID, result and exit status;
raw stderr, authentication headers and credentials are not stored. Cleanup
closes only sessions/kernels created for each uniquely named scratch Notebook,
retains Notebook/report/Project evidence and verifies pre-existing resources.
UI operation budget for these scripts is zero. Independent RTC participants
are protocol fixtures, not manual Lab editing acceptance.

## Execution, recovery and explicit cancellation

`node tests/jupyter/datalayer-probe.mjs --env-file /private/host.env --output /private/new-cli-results`

Checks live RTC reads, persistent calculations, original run-ID deduplication
and recovery in new CLI processes, raster output, matching native exports,
browser/client-closed output persistence and explicit `jupyter stop`.
The default background wait is 67 seconds; `--long-seconds` may choose 2–120,
but a shorter wait is not evidence beyond document cleanup. An owned kernel's
direct API interrupt is a separate protocol check and does not implement the
future [CLI interrupt command #5286](https://github.com/hs3180/disclaude/issues/5286).

Chat `/stop` stops inference. Remote cancellation requires the original
`notebookId` and `runId` through `jupyter stop`; only an observed cancelled
terminal gives `stopConfirmed: true`. CLI exit, an accepted HTTP response and
phase completion do not prove remote cancellation.

`node tests/jupyter/datalayer-edge-probe.mjs --env-file /private/host.env --output /private/new-edge-results`

The default suite runs target cancellation, source/output attribution,
original pending/terminal recovery in new CLI processes, document identity,
MIME display/clear behavior, moves/deletes during execution, large outputs and
stdin rejection, cancellation races, `cli-stop-continuation` and concurrent
export revisions. `--cases` selects comma-separated names from the script's
explicit case list. Kernel restart applies only to a verified scratch kernel.

The edge and fault suites use a temporary host HTTP observer forwarding to the
configured remote endpoint. It counts actual execute POSTs and introduces
labelled transport failures or concurrent edits. The observer is not a Jupyter
server and creates no local kernel. Its Project references belong to that
short-lived observer endpoint; use the core/report probe's direct-endpoint
Project for subsequent image or delivery checks.

`node tests/jupyter/datalayer-fault-probe.mjs --env-file /private/host.env --output /private/new-fault-results`

Checks injected HTTP denial/reply loss, recovery of an original request,
a genuinely accepted but dropped 202 reply with no replay, and refusal to
silently continue after an owned native kernel restart. Injection is not
physical network outage or an expired credential. Jupyter service restart
remains `not_verified`; this script provides no deployment/restart options.

## Reports and numerical reproduction

`node tests/jupyter/datalayer-report-probe.mjs --env-file /private/host.env --output /private/new-report-results`

Imports exact synthetic CSV bytes through the CLI, runs two fresh remote
kernels, compares numerical results, and checks PNG/SVG/HTML/inline Plotly,
formula/table sources, bounded image files, matching HTML/ipynb revisions,
authentication and sandbox headers. Source/header checks do not establish
rendering on the user's actual device.

## Explicit model and outbound component probes

The DSH probes expose optional CLI-backed tools only within their test harness;
they do not create Notebook state in ChatAgent or certify Skill discovery.
Supply the existing host-private OAuth auth file and the explicit
`gpt-5.6-luna` override required by #5215/#5219. Daily service configuration
is unaffected. Credentials are removed from the model environment and checked
against native history; these probes do not open a competing bot connection.

`node tests/jupyter/datalayer-dsh-probe.mjs --env-file /private/host.env --oauth-auth-file /private/auth.json --model gpt-5.6-luna --output /private/new-dsh-results`

`node tests/jupyter/datalayer-image-probe.mjs --env-file /private/host.env --oauth-auth-file /private/auth.json --model gpt-5.6-luna --project /private/core-results/project --cell-id mvp-plot --output /private/new-image-results`

Image observation converts the CLI's verified local raster artifact into the
native SDK image result. The image probe is read-only. DSH/model validation is
separate from real Feishu Agent acceptance and native-device rendering.

The outbound probe requires an explicitly authorized fresh Feishu thread; it
uses `download-report` and the generic file callback/channel path, records
actual message identities and checks the original thread. It does not send on
ordinary test invocation or retry an ambiguous write. Run only when separately
authorized to send into that chat:

`node tests/jupyter/datalayer-delivery-probe.mjs --env-file /private/host.env --project /private/core-results/project --chat-id oc_AUTHORIZED --root-message-id om_OWNED --output /private/new-delivery-results`

Historical results remain pinned to
[0dee0fa16](https://github.com/hs3180/disclaude/blob/0dee0fa16ff4ca3118ed7c5fb96f03f85a23004a/docs/releases/0.6.3-acceptance.md).
The updated probes must be run on their own committed source before recording
new evidence. Final merged-source installation and release checks remain
required; neither syntax checks nor earlier candidate passes replace them.

## Historical G0-B Jupyter stack experiment

The following commands/results document earlier isolated component experiments
and server-side CI fixtures. They do not define host runtime setup or current
product acceptance. Do not recreate their local environment for this task.

This opt-in probe for #5216 launches its own authenticated localhost server,
Notebook, kernel, browser and Jupyter configuration. It uses no Project mount,
existing server, Notebook or kernel. Normal Disclaude installation and regular
Node checks do not install Python. The separate managed-coordinator CI installs
its pinned server stack for backend checks, without this browser probe.

Use Python 3.13 and a separate virtual environment:

```sh
python3.13 -m venv .local/jupyter-g0-venv
.local/jupyter-g0-venv/bin/python -m pip install -r tests/jupyter/requirements.txt
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/jupyter-g0-browsers"
export PLAYWRIGHT_SKIP_BROWSER_GC=1
.local/jupyter-g0-venv/bin/python -m playwright install chromium
.local/jupyter-g0-venv/bin/python tests/jupyter/g0-stack-probe.py --report .local/jupyter-g0/default.json
```

To compare nbmodel's optional recovery setting, run the same probe with
`--output-recovery`. This writes the setting only to the probe's temporary Lab
settings directory. Each run reports its actual setting and succeeds or fails
independently. `--chromium-executable /absolute/path/to/chromium` can use an
existing browser; its actual version is recorded.

The six UI operations are opening a scratch Notebook, editing its Markdown and
parameter, running the edited cell, closing the page, and reopening it. An
independent RTC peer must read both human edits before Contents has saved them.
Lab Run must call the nbmodel execute API with the expected cell identity. The
background execution starts with zero browser pages and the probe RTC peer
disconnected. The default `--room-retention cleanup` uses a 30-second document
save delay to observe unsaved
edits, keeps the standard 60-second cleanup delay, and waits 61 seconds after
disconnection before starting a three-second execution. Its stdout
and SVG must be saved by the server without a second
Contents PUT, then rendered when Lab reopens. HTML export must have an
origin-isolating sandbox CSP and contain the same verified Notebook content.
The server must also log its room-deletion event before background execution;
elapsed time alone does not prove that the room was released.

## Observed failure

On 2026-10-02, the pinned stack failed after the room was deleted. Native Lab
Run and unsaved Markdown/parameter synchronization succeeded. With all browser
pages closed and the independent peer disconnected for 61 seconds, nbmodel
accepted the background request and reported `complete` / `ok`, including
stdout and SVG in its result. The saved Notebook still had zero outputs for
that cell after a further 45 seconds. The process exited 1, with zero remaining
owned kernels, its server stopped and its temporary root removed.

This failure is a release gate for cold-room output persistence. Earlier
successful experiments retained a live RTC document; they do not establish
this property. Reopening, chart rendering and HTML export are later assertions
and were not reached in the cold-room run. The probe does not convert this
known failure into a passing test. A document lifetime/persistence integration
must be verified before treating the stack as the release path.

## Server retention comparison

Run `--room-retention server` to compare the supported
`YDocExtension.document_cleanup_delay = None` configuration:

```sh
.local/jupyter-g0-venv/bin/python tests/jupyter/g0-stack-probe.py --room-retention server --report .local/jupyter-g0/server-retention.json
```

This keeps the shared document in the owned server's memory until the server
exits. All browser pages and the independent RTC peer still disconnect; the
probe waits 61 seconds before execution and checks that the room was not deleted.
It uses the same save delay and assertions as the cleanup comparison.

On 2026-10-02 this configuration passed: unsaved human edits were visible to the
peer, native Run used nbmodel, and background stdout/SVG were saved with no
Contents PUT after initial creation. Lab reopened with the same SVG and human
edits, and HTML export contained the verified Notebook content with an
origin-isolating CSP. `outputRecovery` was false. The six UI operations completed;
owned kernels reached zero, the server stopped, and the temporary root was removed.

This result does not pass the cold-room cleanup gate. The document was already
initialized, remained in server memory, and was not reloaded after a restart.
Managed integration must establish the current shared document before execution,
bound its retained resources, and reconcile server/kernel loss. External instances
require their own compatibility evidence; the probe never changes a user's config.

## Unattended initialization experiment

To initialize a new Notebook without ever opening Lab, use:

```sh
.local/jupyter-g0-venv/bin/python tests/jupyter/g0-stack-probe.py --room-retention server --unattended-bootstrap --report .local/jupyter-g0/unattended.json
```

This mode creates the scratch Notebook and kernel through the server APIs,
initializes the shared document with a transient RTC peer, verifies its cell IDs
and sources, then disconnects the peer. After 61 seconds with no browser or RTC
client, the first background execution must return stdout/SVG and save those outputs
without another Contents PUT. The report records the source hash, server document
and execution IDs, zero UI operations, preserved initial cells, and resource
cleanup. A successful run also writes the verified Notebook beside the report.

On 2026-10-02 this mode passed in two independent runs with server retention:
the peer was disconnected for 61.051 and 61.202 seconds, execution completed with
`execution_count=1`, and the saved cell contained stdout and SVG.
The only Contents PUT created the Notebook;
initial cell IDs/sources were preserved. No document-not-found warning occurred,
and owned kernels, server and temporary root were removed.

This is a separate bootstrap experiment. It does not exercise human editing,
Lab reopening, chart rendering, HTML export, server restart or Disclaude tools.
The default Lab mode retains its existing assertions and cleanup comparison.

The JSON report records failures at their observed stage, versions and cleanup.
A successful run also writes the verified `.ipynb`, HTML and cropped chart PNG
beside the report. These artifacts contain synthetic probe content only. The
owned server and kernels stop and their temporary root is removed after either
success or failure.

This is a stack-selection experiment. It does not verify Disclaude adapters,
atomic cell edits, controller generations, kernel ownership handoff, Feishu,
model continuation, report quality or access from a user's actual device.

## Patch deployment portability

`node --test tests/jupyter/patch-cli-test.mjs` checks Node-only generation and
the sole Jupyter Terminal transport: framing, streaming, permissions, owned
cleanup and failure handling. Removed transport/lifecycle options are refused
before authentication. These protocol fixtures do not contact a live service.

`python3 tests/jupyter/datalayer-package-test.py -v` checks archive integrity,
reversible filesystem updates, custom Python/JSON config, nonstandard discovery
paths, partial-update rollback and the distinction between installed files and
running Server code. They do not stop/restart a Server or hot-reload modules.
These component tests do not replace configured Jupyter or product acceptance.

Configured-server Terminal checks use the existing login/REST/WebSocket service.
Owned staging directories can verify apply/rollback without changing the running
installation. Record disk installation, external restart and running-code/product
verification as separate evidence. Older SSH/Compose experiments are historical;
those deployment adapters and their fixtures have been removed.
