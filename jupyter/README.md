# Managed Notebook coordinator

This optional server package implements the shared Notebook document and
execution ports used by disclaude. It has no Harness dependency: DSH registers
the common Notebook tools through its native registry; other adapters can use
the same ports. Installing ordinary chat packages does not install Python or
start Jupyter.

The package is an implementation candidate. Service/Feishu binding, complete
Notebook editing and report delivery are still being integrated. Component
checks do not establish product acceptance.

## Supported candidate environment

The default `managed` profile pins
Jupyter Server 2.21.1, JupyterLab 4.6.3, collaboration 5.0.4, server-ydoc 3.0.4,
docprovider 3.0.4, ydoc 4.1.1, pycrdt 0.14.8, nbmodel 0.2.9, jupyter-client
8.10.0, ipykernel 7.4.0 and nbformat 5.11.1. The server refuses unverified
versions of all eleven profile dependencies. POSIX local kernel provisioners
are the initial support boundary; Windows and remote provisioners need separate
evidence. Historical managed probes and CI remain component checks. Actual
acceptance uses the user's configured `.env` server; do not create or restart a
local Jupyter environment as a substitute.

Install this directory into that environment:

```sh
python -m pip install '/path/to/disclaude/jupyter[managed]'
```

Configure only the owned server, with an authenticated entry and private state:

```python
c.ServerApp.jpserver_extensions = {
    'jupyterlab': True,
    'jupyter_server_fileid': True,
    'jupyter_server_ydoc': True,
    'jupyter_server_nbmodel': False,
    'disclaude_jupyter': True,
}
c.YDocExtension.server_side_execution = True
c.NotebookExtension.ledger_path = '/owned/private/data/notebooks.sqlite3'
c.NotebookExtension.idle_seconds = 60
c.NotebookExtension.max_rooms = 16
```

The original nbmodel server routes must be disabled: both route implementations
cannot own execution. The existing Lab frontend's server-side Run protocol is
handled by this coordinator. It uses Jupyter's native kernel client and manager;
it does not implement a new kernel WebSocket protocol. Enabling the extension on
an existing user server is not an automatic setup or compatibility check.

### Experimental configured-server profile

The `configured-20261003` profile exactly describes the inspected `.env`
Docker instance. It uses Server 2.19.0, Lab/collaboration 4.4.1,
server-ydoc/docprovider 2.4.1, nbmodel 0.1.1a4, ydoc 3.5.0, pycrdt 0.13.1,
client 8.8.0, ipykernel 7.2.0 and nbformat 5.10.4. This is a candidate for
in-place testing, **not an accepted supported release stack**. Installed source
inspection and unit checks do not establish live RTC or Notebook acceptance.

Package dependency ranges allow both exact profiles; they are not a statement
that intervening versions work. Always select a pinned extra when provisioning
an environment. Runtime startup checks the selected complete profile and
refuses mixed, changed, missing or unknown versions. Installing the package
does not select a profile or enable an extension.

For a reviewed deployment on the existing instance, first confirm its exact
dependencies and stage the candidate wheel. Install that wheel with
`python -m pip install --no-deps /owned/path/disclaude_jupyter-0.1.0-py3-none-any.whl`
to avoid altering its installed Jupyter stack. Retain the original configuration,
image reference and private runtime state. Explicit candidate configuration is:

```python
c.NotebookExtension.stack_profile = 'configured-20261003'
c.NotebookExtension.allow_experimental_stack = True
```

The common extension configuration above is also required, including disabling
the original nbmodel server routes. The two execution implementations cannot be
active together. The status endpoint reports the selected profile and its
experimental flag. This candidate does not upgrade, patch or restart the server.
Deployment activation needs the user's restart window: the inspected instance
has nine existing kernels, whose live memory cannot be promised across restart.
Do not stop them as part of a connection check. See the staged deployment plan
in [configured-deployment.md](configured-deployment.md).

Server 2.19.0 is affected by the upstream
[nbconvert HTML sandbox advisory](https://github.com/jupyter-server/jupyter_server/security/advisories/GHSA-fcw5-x6j4-ccmp)
(fixed in 2.20.0). This experimental profile is not the safe HTML report-preview
release path; HTML sandbox mitigation and actual device/render checks remain
separate deployment acceptance work.

The state directory belongs to this server. A separate owner lock permits one
writer; namespace, controller generations, native request IDs and run records
live in SQLite. Preserve that directory and the Jupyter authentication session
when resuming a connection. It contains execution source and bounded outputs
and must be treated as private workspace data.

## Host client and authentication

`JupyterCoordinatorClient` implements `JupyterNotebookPort` and
`JupyterExecutionPort`. Its connection contains a host-owned Authorization
resolver or standard password resolver, HTTPS base URL (loopback HTTP is allowed
for owned local operation), connection ID and optional saved server namespace.
Non-loopback HTTP requires explicit host `allowInsecureHttp` permission for the
configured endpoint and carries its password/cookies without encryption.
Remote URLs with credentials,
queries or fragments and redirects are rejected.

Jupyter's default token authentication generates an identity and preserves it in
a login cookie. The client keeps a connection-specific `tough-cookie` jar and
coalesces its first handshake before Notebook operations, so claim/edit/run use
the same authenticated principal. Hosts may supply a dedicated private jar when
they manage connection persistence. Cookie/domain/path/expiry handling uses the
library; cookie counts, header sizes and response bodies are bounded. Neither
credentials nor cookies enter Notebook identities or model tool descriptors.
The connector requires a Node runtime with `Headers.getSetCookie` (Node 20+).
Standard password login uses the server's XSRF cookie and a form POST, then
verifies the resulting cookie with a safe read. Login redirects are checked and
never followed; Notebook redirects are refused. A valid saved cookie avoids
resolving the password. Expiry is handled only at a later safe handshake; an
attempted mutation is never replayed, and ownership still requires the original
principal/controller generation. SSO and external credential refresh are not
implemented.

`inspectConnection()` reads server version and coordinator availability without
opening a document, claiming control or changing a kernel. An authenticated
server without the extension is reported as `coordinator: 'missing'`; ordinary
REST execution does not satisfy the shared Notebook contract.

The host must bind tools to its claimed controller generation and recheck it at
operation boundaries. Reading the global controller does not authorize a host
to adopt a different owner's current lease. Native invocation IDs are tracing
metadata; Jupyter run IDs and kernel incarnations are business identities.

## Document and execution semantics

- Online reads and edits use the native shared document, including synchronized
  unsaved edits. An edit checks the full document revision, exact UTF-8 source
  hash and principal/controller generation, then mutates one shared Text in a
  single transaction without an intervening await.
- Document revisions hash the native canonical Notebook content, including all
  cells, metadata, attachments and outputs. They survive unchanged cold loads;
  room client IDs, dirty flags and awareness do not create content versions.
  This is content equality, not an edit-history counter. Duplicate cell IDs
  reject operations; reads do not silently deduplicate or alter them.
- Passive native room leases retain active work, force native save before idle
  release, and cold-load on later access. In-flight cold loads reserve capacity,
  document mutexes are released, and failed saves retain authoritative state
  with bounded retries and visible diagnostics. Shutdown closes every owned
  peer even when a save is unconfirmed. The room limit applies to this
  coordinator's leases; it does not claim to cap human browser resources.
- A run ID and native message ID are recorded before sending. Reusing a run ID
  with a different target/source rejects; a lost response is queried by the
  original run ID and never authorizes automatic resubmission.
- Runs serialize in one local kernel. The coordinator matches shell reply and
  IOPub parent message ID/idle, preserves source/owner/kernel provenance, and
  rejects stale writes. Kernel process identity must remain verifiable;
  uncoordinated execution invalidates authority instead of being silently
  adopted.
- Stop targets the stored run and current principal/controller generation. An
  interrupt acknowledgment is not confirmation: cancellation requires the
  terminal native observation. Stopping inference is a separate operation.
- `stop-owner` pauses the current generation and cancels its unsent queue in one
  ledger transaction before interrupting the exact active run. Late submissions
  and old callbacks are rejected. A new claim resumes a paused owner with a new
  generation only after active runs terminate. `control-state` reports the pause
  independently of the controller identity. Ledger schema is now version 2;
  earlier experimental ledgers are preserved and refused, never reset or replayed.
- Server restart marks unfinished runs unknown and does not replay them.
  Notebook persistence does not prove that kernel variables survived.

## Remaining acceptance work

The coordinator provides a request-bound Lab input endpoint at
`POST /api/kernels/<kernelId>/requests/<requestId>/input`, with
`input_request_id` from the request's HTTP 300 observation and an `input` value.
Both execution identity and each native stdin prompt are fenced. The Notebook
API similarly requires `runId`, `inputRequestId` and the current controller.
The input transport does not persist reply values; code-generated outputs
remain Notebook evidence. An ambiguous native send consumes the prompt and
quarantines the execution without replay. This is a backend
interface. The stock kernel-only nbmodel input request is unsupported; a Lab
frontend adapter must retain the request/prompt identities before interactive
input can be accepted as a product flow.

The current tools cover cell read/edit/submit/status/stop. Creation, structured
insert/delete/move, full report/graph observation, versioned export and Feishu
data/result delivery remain required by the product issues. Also pending are
the complete restart/auth/network fault matrix, Lab frontend interactive input,
cross-run display updates, late-output reconciliation, the queue-stop fault matrix,
large-output artifact delivery and visible result validity after source/kernel
changes. Output truncation in this candidate is not full artifact acceptance.

Tests of the Lab HTTP Run protocol are not native Lab UI acceptance. Final
acceptance must use the same server Notebook from Feishu, preserve human edits,
confirm kernel stop, continue the same research, and deliver accessible results
from the user's actual device. Daily/candidate defaults remain `gpt-6-luna`;
the explicitly specified real-model acceptance uses `gpt-5.6-luna`.

## Opt-in checks

Install test dependencies into the same separate environment:

```sh
python -m pip install -e './jupyter[managed,test]'
PYTHONPATH=jupyter python -m unittest discover -s jupyter/tests -v
npm run build --workspace=@disclaude/core
npx vitest --run packages/core/src/jupyter/coordinator-client.test.ts
python tests/jupyter/coordinator-probe.py --output /private/new-backend-report.json
```

The probe creates and removes its own authenticated local server, Notebook,
kernel, state and settings. It uses no existing user server or Project mount.
Each report path must be new; reports preserve failures and have mode 0600.
For actual DSH composition, supply an independently built native adapter
checkout, explicit model route credentials and binary:

```sh
python tests/jupyter/coordinator-probe.py \
  --output /private/new-native-report.json \
  --dsh-checkout /path/to/native-adapter-worktree \
  --dsh-binary /path/to/dsh \
  --oauth-auth-file /private/existing-auth.json \
  --model gpt-5.6-luna
```

This reads an existing unexpired access credential without refreshing it or
writing back. Native and backend source fingerprints distinguish uncommitted
candidate code from published commits. No UI or production bot is used by this
component probe.
