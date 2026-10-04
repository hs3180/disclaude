# Remote Jupyter Notebook coordinator

This optional server package implements the shared Notebook document and
execution ports used by disclaude. It has no Harness dependency: DSH registers
the common Notebook tools through its native registry; other adapters can use
the same ports. The Notebook runtime connects to the configured remote Jupyter
service from a Node HTTP client.

## Deployment boundary

| Location                           | Runtime and state                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| disclaude host                     | Node client, private connection/authentication state and Project resource references                                 |
| Remote Jupyter server or container | Python, this optional server extension, Jupyter dependencies, Notebook storage, private execution ledger and kernels |

The disclaude host does not need a Python executable, virtual environment,
Jupyter installation or shared filesystem for this Notebook connection. It
neither installs the server package nor starts a Jupyter server/kernel process.
A kernel name in a host request selects a kernelspec on the remote server.
The server extension is deployed and configured through that server's own
administrator/deployment controller; Python requirements belong to that remote
environment. The optional source payload included in the npm distribution is
for staging a server-side build, not an npm installation hook.

The package is an implementation candidate. Service/Feishu binding, complete
Notebook editing and report delivery are still being integrated. Component
checks do not establish product acceptance.

## Supported candidate environment

The following versions describe the remote server's environment, not the
disclaude host. Preserve its existing deployment and configuration. This
candidate pins
Jupyter Server 2.21.1, JupyterLab 4.6.3, collaboration 5.0.4, server-ydoc 3.0.4,
docprovider 3.0.4, ydoc 4.1.1, pycrdt 0.14.8, nbmodel 0.2.9, jupyter-client
8.10.0, ipykernel 7.4.0 and nbformat 5.11.1. The server refuses unverified
versions of the RTC internals it uses. The current backend verifies a POSIX
kernel process through Jupyter's LocalProvisioner on the remote Jupyter machine.
"Local" here means local to that remote server/container. Network access from a
different disclaude machine is supported by the HTTP client; kernels on a third
machine through Gateway/remote provisioners and Windows still need separate
identity/stop evidence.

Build the reviewed wheel on the remote server or a matching server build
runner. Stage it into the existing Jupyter deployment. The following command
runs there, with its existing Python interpreter; it is not a host setup step:

```sh
python -m pip install --no-deps /staged/disclaude_jupyter-0.1.0-py3-none-any.whl
```

This does not resolve a version mismatch or authorize a server restart. The
actual `.env` server has a different stack and lacks this extension; its
experimental compatibility/deployment candidate is reviewed separately in
[#5248](https://github.com/hs3180/disclaude/pull/5248). Preserve its existing
configuration, image, persistent data and kernel work before activation.

Configure the remote server through its deployment controller, with an
authenticated entry and private persistent state:

```python
c.ServerApp.jpserver_extensions.update({
    'jupyterlab': True,
    'jupyter_server_fileid': True,
    'jupyter_server_ydoc': True,
    'jupyter_server_nbmodel': False,
    'disclaude_jupyter': True,
})
c.YDocExtension.server_side_execution = True
c.NotebookExtension.ledger_path = '/remote/persistent/private/notebooks.sqlite3'
c.NotebookExtension.idle_seconds = 60
c.NotebookExtension.max_rooms = 16
```

The original nbmodel server routes must be disabled: both route implementations
cannot own execution. The existing Lab frontend's server-side Run protocol is
handled by this coordinator. It uses Jupyter's native kernel client and manager;
it does not implement a new kernel WebSocket protocol. Enabling the extension on
an existing user server is not an automatic setup or compatibility check.

The example ledger path is a remote deployment placeholder: select an actual
persistent writable mount through the server's deployment controller.
The state directory belongs to this remote server. A separate owner lock permits one
writer; namespace, controller generations, native request IDs and run records
live in SQLite. Preserve that directory and the Jupyter authentication session
when resuming a connection. It contains execution source and bounded outputs
and must be treated as private workspace data.

## Host client and authentication

`JupyterCoordinatorClient` implements `JupyterNotebookPort` and
`JupyterExecutionPort`. Its connection contains a host-owned Authorization
resolver or standard password resolver, explicit remote HTTPS base URL,
connection ID and optional saved server namespace. Loopback HTTP is retained
for protocol fixtures; it is not a fallback deployment or a request to install
Python on the host. Non-loopback HTTP requires explicit host
`allowInsecureHttp` permission for the configured endpoint and carries its
password/cookies without encryption. Remote URLs with credentials,
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
Both authentication modes keep Python and kernels in the remote deployment.

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
- Runs serialize in one kernel on the remote Jupyter server. The coordinator matches shell reply and
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

## Host client checks (Node only)

The HTTP client fixture and build use the disclaude host's existing Node
dependencies. They require no Python or Jupyter installation:

```sh
npm run build --workspace=@disclaude/core
npx vitest --run packages/core/src/jupyter/coordinator-client.test.ts
```

## Actual remote acceptance

Use `JUPYTERLAB_HOST` / `JUPYTERLAB_PASS` from the user's private `.env` and the
configured remote server. Credentials remain host-owned and are excluded from
model tools, Project references and native child environments. The configured
DSH/persistent-Project probe is a separate slice in
[#5250](https://github.com/hs3180/disclaude/pull/5250); missing coordinator support
is a blocked prerequisite, not a request to create a local replacement.
Remote authentication, live coordinator compatibility and the actual
Notebook/Feishu product loop are separate checks. Earlier isolated component
probes do not accept this target.

## Server component CI and historical probes

The separate [Jupyter component workflow](../.github/workflows/jupyter-coordinator.yml)
acts as a server build/test machine: its runner installs the pinned Python
stack, runs Python units and creates an owned isolated Jupyter fixture for RTC
and kernel protocol checks. Those are server component checks, not dependencies
of the Node host or acceptance of the user's remote deployment. Ordinary npm
installation and chat startup do not invoke this Python setup.

Historical isolated probe commands/results remain in
[tests/jupyter/README.md](../tests/jupyter/README.md). Current actual acceptance
uses the configured remote instance; do not recreate a host-local Jupyter or
Python virtual environment to substitute for it. Source fingerprints and
private reports retain the scope and failures of each historical experiment.
