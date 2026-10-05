# Notebook acceptance probes

## Configured Datalayer MVP probes

Build the checkout (`npm run build`) and run against the existing server named
by the host-private `JUPYTERLAB_HOST` / `JUPYTERLAB_PASS` environment file:

```sh
node tests/jupyter/datalayer-probe.mjs \
  --env-file /private/host.env \
  --output /private/new-datalayer-component-results
```

This uses the real Service Notebook tools and remote RTC/nbmodel APIs. It creates
a uniquely named scratch Notebook/Project, checks unsaved edits, persistent
kernel calculations, original run-ID lookup/recovery, PNG and remote nbconvert
exports, then disconnects every document client for a 67-second execution.
It tests request cancellation and, separately, explicitly interrupts only its
owned scratch kernel. Original server kernels/sessions must survive cleanup.
No local Python/Jupyter or remote installation/configuration change occurs.

The new output directory is private. Synthetic Notebook/report files and local
Project evidence are retained for review; owned kernels/sessions are deleted.
The report retains failed capability checks. `completed: true` means all probe
phases finished, **not** that every requirement passed. Authentication/operation
failure exits nonzero. `--long-seconds` may explicitly change the delay; shortening
it does not establish persistence beyond document cleanup. `--wait-ui` waits up
to four minutes for a host-created `ui-done.json` evidence record so a logged-in
human can edit the scratch Notebook. That record must contain `completed: true`
only after the UI edit is verified; never send passwords through a model/UI tool.

For two real native DSH turns with session recreation and an independent RTC
participant editing the parameter/Markdown between them:

```sh
node tests/jupyter/datalayer-dsh-probe.mjs \
  --env-file /private/host.env \
  --oauth-auth-file /private/existing-auth.json \
  --model gpt-5.6-luna \
  --output /private/new-datalayer-model-results
```

The host's existing OAuth credential is read without refresh and needs at least
15 minutes remaining. `--binary /path/to/dsh` selects an explicit DSH executable.
The probe checks native model/session routing, 69 then 93 on one kernel, human
text/parameter preservation, HTML/ipynb export and credential absence from native
history. The explicit model is the #5215/#5219 acceptance override; daily defaults
remain `gpt-6-luna`, and Astra is refused. Scratch kernels/sessions and the owned
provider process are cleaned up; private review evidence remains.

Neither probe switches production Feishu or passes native JupyterLab/device
acceptance. Current instance failures and all unverified behaviors are recorded
in [the MVP matrix](../../docs/designs/datalayer-mvp.md). The coordinator-only
`connection-probe.mjs` does not assess this backend.

## Configured-server DSH probe

Real acceptance for this work uses the server configured by `JUPYTERLAB_HOST` /
`JUPYTERLAB_PASS`. No local JupyterLab or Python environment is started by this
mode. Build the composed Service/native checkout, then use a host-private
connection catalog as described in [the Service guide](../../docs/jupyter-service.md):

```sh
node tests/jupyter/dsh-notebook-probe.mjs \
  --config-file /private/jupyter/connections.json \
  --connection-id configured \
  --env-file /private/host.env \
  --project-dir /path/to/dedicated-acceptance-project \
  --dsh-checkout /path/to/composed-service-checkout \
  --oauth-auth-file /private/existing-auth.json \
  --model gpt-5.6-luna \
  --notebook scratch-acceptance.ipynb \
  --output /private/new-configured-dsh-report.json
```

The Project directory must already exist and be dedicated to this scratch
Notebook. The Notebook must already exist on that server with `human-note`
(Markdown), `short-cell` (code), and `long-cell` (code) IDs. The long cell should
print `RUNNING` with `flush=True`, sleep for 30 seconds, then print `LATE`.
The probe explicitly edits/runs the two code cells; it preserves the Markdown.
It does not create or delete a remote Notebook/kernel. It preserves the Project's
reference and execution records for follow-up acceptance. Existing references to
a different Notebook and control held by another owner are refused; an explicit
handoff must be performed before reusing that Notebook.

Before reading model authentication, running the DSH binary, opening a Notebook,
writing the Project or creating temporary DSH state, the probe performs only safe
host login/capability reads. An authenticated server without the coordinator
exits **2**, reports `blocked` / `not_executed`, and keeps both `modelStarted` and
`notebookOpened` false. Other connection failures exit **1**. Neither condition
passes Notebook acceptance. The host catalog owns the endpoint and HTTP policy;
models receive neither that catalog nor Jupyter authentication variables.

With the coordinator available, the existing native DSH phases test exact
read/edit/run, a new native process and Service session continuing the same
Notebook, confirmed exact-run stop, inference-idle owner stop and same-kernel
continuation. Accepted handles must keep the same Notebook/kernel incarnation;
the Markdown source must survive. Cleanup asks the host to stop its original
owner, reports unknown/lost-authority outcomes as failure, and retains the remote
Notebook/kernel and persistent Project. It removes only its own temporary DSH
configuration/history after provider shutdown. Existing OAuth credentials are
read without refresh and must have at least 15 minutes remaining.

This is native Service/DSH component evidence. Real Feishu, native Lab human
edits and access from the user's device remain separate product acceptance.
The explicit `gpt-5.6-luna` route is the #5215/#5219 acceptance exception; daily
and candidate defaults remain `gpt-6-luna`, and Astra is refused.

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
