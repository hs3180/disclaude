# G0-B Jupyter stack experiment

This opt-in probe for #5216 launches its own authenticated localhost server,
Notebook, kernel, browser and Jupyter configuration. It uses no Project mount,
existing server, Notebook or kernel. Normal Disclaude installation and CI do not
install these Python dependencies.

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

The JSON report records failures at their observed stage, versions and cleanup.
A successful run also writes the verified `.ipynb`, HTML and cropped chart PNG
beside the report. These artifacts contain synthetic probe content only. The
owned server and kernels stop and their temporary root is removed after either
success or failure.

This is a stack-selection experiment. It does not verify Disclaude adapters,
atomic cell edits, controller generations, kernel ownership handoff, Feishu,
model continuation, report quality or access from a user's actual device.
