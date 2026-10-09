# Configured Jupyter test command

Use the installed `disclaude jupyter test` command to run the configured remote
Datalayer checks. The seven suites and their runner ship with the standalone
distribution. In a source checkout, build it with `npm ci` and `npm run build` first.

`disclaude jupyter test --list` lists suites without authentication. The default
selection is `core,edge,fault,report`; `--suite api` selects the same four. Use
`--suite core`, repeat `--suite`, or pass comma-separated names to choose checks.
The `dsh`, `image` and `delivery` suites require explicit selection and inputs.

Use environment variables or a host-private `.env` containing `JUPYTERLAB_HOST`
and `JUPYTERLAB_PASS` or `JUPYTERLAB_TOKEN`. `--env-file` selects a file; actual
environment values take precedence. `--password-env` / `--token-env` select
another credential variable. `--interactive` uses the shared hidden TTY prompt
once before launching suites; agents pass `--no-interactive`. Credentials reach
only host CLI processes, never arguments, model history or Project references.

`disclaude jupyter test --env-file /private/host.env --no-interactive`

Every Notebook operation launches a fresh Node CLI process. Project references
and original-run journals survive between commands. ChatAgent and service startup
have no test lifecycle hook. Only the selected suite loads its transport/model/
channel dependencies. Notebook execution uses remote Python.

`--output` names a new private directory; otherwise the command creates one in
the host temporary directory. JSON stdout includes suite states, required check
counts, source and receipt paths; stderr prints short progress messages. Failed
assertions, nonzero probe exits, missing receipts or unconfirmed cleanup produce
a nonzero command exit. Phase completion is not success. Failed receipts remain
available; MCP Tasks is recorded as optional/outside scope. SIGINT/SIGTERM stops
further suites after the active suite finishes its bounded work and owned cleanup.

Receipts record checkout commit/dirty state, CLI/probe hashes and declared release
provenance when installed. `cli-commands.json` records child PID, command, result
and exit status. Raw stderr and credentials are not persisted. Cleanup closes only
sessions/kernels created for uniquely named scratch Notebooks, retains Notebook/
report/Project evidence and verifies pre-existing resources. Kernel suites use an
advertised Python kernelspec; `--kernel-name` binds an explicitly selected existing
spec. UI operation budget is zero. RTC participants are protocol fixtures, not
manual Lab editing acceptance.

The repair installer remains `disclaude jupyter patch` through Jupyter Terminal;
see the [patch guide](../datalayer/README.md). Tests do not install
patches/packages, launch local Jupyter or manage machines, containers or service restarts.

## Execution, recovery and explicit cancellation

`disclaude jupyter test --suite core --env-file /private/host.env --output /private/core-results --no-interactive`

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

`disclaude jupyter test --suite edge --env-file /private/host.env --output /private/new-edge-results --no-interactive`

The default suite runs target cancellation, source/output attribution,
original pending/terminal recovery in new CLI processes, document identity,
MIME display/clear behavior, moves/deletes during execution, large outputs and
stdin rejection, cancellation races, `cli-stop-continuation` and concurrent
export revisions. `--cases` selects names such as `move-delete-running`,
`pending-host-recovery`, `cli-stop-continuation` or `export-revision-race`.
Kernel restart applies only to a verified scratch kernel.

The edge and fault suites use a temporary host HTTP observer forwarding to the
configured remote endpoint. It counts actual execute POSTs and introduces
labelled transport failures or concurrent edits. The observer is not a Jupyter
server and creates no local kernel. Its Project references belong to that
short-lived observer endpoint; use the core/report probe's direct-endpoint
Project for subsequent image or delivery checks.

`disclaude jupyter test --suite fault --env-file /private/host.env --output /private/new-fault-results --no-interactive`

Checks injected HTTP denial/reply loss, recovery of an original request,
a genuinely accepted but dropped 202 reply with no replay, and refusal to
silently continue after an owned native kernel restart. Injection is not
physical network outage or an expired credential. Jupyter service restart
remains `not_verified`; this script provides no deployment/restart options.

## Reports and numerical reproduction

`disclaude jupyter test --suite report --env-file /private/host.env --output /private/new-report-results --no-interactive`

Imports exact synthetic CSV bytes through the CLI, runs two fresh remote
kernels, compares numerical results, and checks PNG/SVG/HTML/inline Plotly,
formula/table sources, bounded image files, matching HTML/ipynb revisions,
authentication and sandbox headers. Source/header checks do not establish
rendering on the user's actual device.

The report suite selects the advertised remote default or sole available Python
kernelspec. Use `--kernel-name <existing-name>` to bind an explicit fresh scratch
kernel. That remote environment needs NumPy, Matplotlib, Plotly and Narwhals;
missing packages remain failed execution evidence. `--python-path <remote-dir>`
can load an explicitly prepared, owned test dependency directory in the two
scratch kernels. Its path and package versions are recorded. The probe does not
install packages or change existing kernelspecs or server settings.

## Explicit model and outbound component probes

The DSH probes expose optional CLI-backed tools only within their test harness;
they do not create Notebook state in ChatAgent or certify Skill discovery.
Supply the existing host-private OAuth auth file and the explicit
`gpt-5.6-luna` override required by #5215/#5219. Daily service configuration
is unaffected. Credentials are removed from the model environment and checked
against native history; these probes do not open a competing bot connection.

`disclaude jupyter test --suite dsh --env-file /private/host.env --oauth-auth-file /private/auth.json --model gpt-5.6-luna --output /private/new-dsh-results --no-interactive`

`disclaude jupyter test --suite image --env-file /private/host.env --oauth-auth-file /private/auth.json --model gpt-5.6-luna --project /private/core-results/core/project --cell-id mvp-plot --output /private/new-image-results --no-interactive`

Image observation converts the CLI's verified local raster artifact into the
native SDK image result. The image probe is read-only. DSH/model validation is
separate from real Feishu Agent acceptance and native-device rendering.

The outbound probe requires an explicitly authorized fresh Feishu thread; it
uses `download-report` and the generic file callback/channel path, records
actual message identities and checks the original thread. It does not send on
ordinary test invocation or retry an ambiguous write. Run only when separately
authorized to send into that chat:

`disclaude jupyter test --suite delivery --env-file /private/host.env --project /private/core-results/core/project --chat-id oc_AUTHORIZED --root-message-id om_OWNED --output /private/new-delivery-results --no-interactive`

Historical results remain pinned to
[0dee0fa16](https://github.com/hs3180/disclaude/blob/0dee0fa16ff4ca3118ed7c5fb96f03f85a23004a/docs/releases/0.6.3-acceptance.md).
The updated probes must be run on their own committed source before recording
new evidence. Final merged-source installation and release checks remain
required; neither syntax checks nor earlier candidate passes replace them.
