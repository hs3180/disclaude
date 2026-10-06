# Notebook tools in the Service

DSH is the primary native adapter for Notebook tools. The Service binds the
shared document and execution APIs to Project references; neither Notebook
identity nor execution authority comes from a Harness session ID. Select
`agentBackend: deepseek` and the supported DSH provider route. Other adapters
currently reject these native tools explicitly. No Codex CLI/MCP process is
required for Notebook access.

## Host connection configuration

An existing Datalayer deployment is the default when `backend` is omitted;
`backend: "datalayer"` also selects it explicitly. The adapter uses native
RTC/nbmodel/nbconvert without installing
`disclaude_jupyter`. See [the configured-instance results and limits](./designs/datalayer-mvp.md)
and [the opt-in probes](../tests/jupyter/README.md#configured-datalayer-mvp-probes).
The [0.6.3 delivery plan](./designs/jupyter-harness.md) now targets this route.
Existing coordinator operators must set `backend: "coordinator"` explicitly;
this preserves their historical authenticated cookie identity. Migrating to
Datalayer keeps host connection IDs and credential references, while Notebook
references still need the selected backend's identity checks. One Project
cannot mix the two backends. The controller-generation,
atomic edit and durable fence sections below document the legacy coordinator;
they are not prerequisites or claimed capabilities of the Datalayer MVP.

The Service reads `JUPYTER_CONNECTIONS_FILE`, or
`~/.disclaude/jupyter/connections.json`. Create a private file (mode 0600):

```json
{
  "version": 1,
  "connections": [
    {
      "id": "research",
      "backend": "datalayer",
      "baseUrl": "https://jupyter.example/",
      "authorizationFile": "/private/path/jupyter-authorization"
    }
  ]
}
```

The authorization file contains the complete HTTP authorization header and must
also have mode 0600. Alternatively use `authorizationEnv` with a host environment
variable name. For standard Jupyter password login, use exactly one
`passwordEnv` or `passwordFile` instead of the Authorization reference:

```json
{
  "id": "research",
  "backend": "datalayer",
  "baseUrl": "https://jupyter.example/",
  "passwordEnv": "JUPYTERLAB_PASS"
}
```

Password files must be private regular files (mode 0600), with the exact password
and no trailing newline. Password whitespace is preserved. Authentication
variables are removed from the environment passed to model processes; neither
passwords nor cookies belong in Project references or tool results. URLs must
not contain credentials or tokens.

HTTPS and loopback HTTP remain the default connection policy. A host catalog
can explicitly set `allowInsecureHttp: true` for one configured HTTP endpoint;
HTTP sends its password and cookies without transport encryption. Models cannot
set this permission or choose an endpoint.

Cookie identity is kept in a private `sessions` directory beside the host
configuration, with connection definition and server namespace isolation.
Restarting a Service connection restores that cookie identity. A valid password
cookie avoids another login. After expiry, a safe connection handshake may log
in again; an already attempted edit/run/stop/input is never retried. A new
principal must still satisfy the selected backend's authorization checks. SSO and
external credential refresh are not implemented. Project files and
native tool descriptors contain no credentials or cookies. The configured
remote server must provide the selected backend's interfaces. The legacy coordinator
requires its extension described in [the backend guide](../jupyter/README.md);
the Datalayer route uses existing RTC/nbmodel/nbconvert.
The Service does not install Python packages, start a server, delete kernels or
edit an existing external server configuration.

## Datalayer delivery scope

The Node host handles connection/authentication, authorized Project references,
live RTC reads/edits and original execution records. The remote server handles
Python, kernel queues, shared documents, output saving and official export.
Execute uses nbmodel's actual source-code POST and retains its 202 Location;
status and cancel use that original request. MCP is JSON-RPC at `/mcp`, using
the actual discovered schema. Missing MCP Tasks does not block this route.

The current MVP has passed live-edit, same-kernel calculation, independent Node
pending recovery and two real DSH turns. It has **not** passed the following
release conditions; each remains an explicit task:

| Issue                                                    | Required behavior                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [#5262](https://github.com/hs3180/disclaude/issues/5262) | Save outputs with no document clients beyond cleanup                               |
| [#5263](https://github.com/hs3180/disclaude/issues/5263) | Repeated original-result reads within an explicit retention policy                 |
| [#5264](https://github.com/hs3180/disclaude/issues/5264) | Cancel the target without interrupting a different queued/running/finished request |
| [#5265](https://github.com/hs3180/disclaude/issues/5265) | Keep historical execution outputs distinct from a cell's edited source             |
| [#5266](https://github.com/hs3180/disclaude/issues/5266) | Correct display updates and clear_output(wait) behavior                            |

First-release scope is Python, one Service writer and a dedicated Notebook
kernel. Live source-hash checks reject observed stale edits; they do not provide
atomic concurrency. Lab Run must use the verified native server-side route.
Stop must block new local work, cancel original accepted requests and confirm
their outcomes; an HTTP 204 or inference AbortSignal alone is insufficient.
Unknown submissions are not automatically replayed. Kernel/Jupyter restart
does not promise restored Python memory or an unconfirmed result.

Multi-controller isolation, atomic editing and a permanent late-request fence
are recorded in [#5267](https://github.com/hs3180/disclaude/issues/5267) outside
0.6.3. Real Feishu, human Lab interaction, device access, HTML/CSP, stdin,
large artifacts and final-source acceptance remain separate work in #5219–#5221.
The [configured Datalayer probe guide](../tests/jupyter/README.md#configured-datalayer-mvp-probes)
records component evidence without claiming those gates have passed.

## Host diagnostics

`JupyterConnections.inspect(connectionId, optionalNamespace)` checks the selected
backend after standard host authentication. Datalayer discovery inspects the
MCP initialize/tool-list schemas, the nbmodel queue route for an unowned random
kernel ID, Lab RTC configuration and official export formats. It returns each
interface as available, missing, incompatible or unverified. RTC configuration
and the `serverSideExecution` flag are diagnostic evidence; they do not prove
that Lab Run enters nbmodel. The result always reports
`productAcceptance: "not_verified"`. No Notebook or kernel is created or opened,
and no execution or tool call is submitted.

An explicit coordinator connection retains the historical diagnosis. It returns
`coordinator: "missing"` when the authenticated server lacks `/api/disclaude`,
independently of ordinary Jupyter API availability. A missing interface is a
diagnostic result, not a passing Notebook experiment.

After building the checkout, inspect an explicitly authorized connection:

```sh
node tests/jupyter/connection-probe.mjs \
  --config-file /private/jupyter/connections.json \
  --connection-id research \
  --env-file /private/host.env \
  --output /private/new-connection-report.json
```

The probe verifies cookie continuation through a second host instance and
authentication-variable removal. It uses only login, safe GETs and MCP
initialize/tool-list discovery POSTs; the output path must be new. A `passed`
probe means those host inspection invariants passed, not that every discovered
interface is available or that product behavior passed. The environment file is optional when
the host already provides the referenced variables.

## Legacy coordinator Project and conversation state

This section preserves the old backend's protocol and evidence. The Datalayer
release tasks above do not require adopting this protocol or installing it.

`<workingDir>/.jupyter/config.json` contains only authorized Notebook references
(`connectionId`, `serverNamespace`, `documentId`, `contentPath`, optional observed
version). An unresolved path is replaced with its server-issued stable identity
only while the original reference still matches. Each operation rechecks Project
references and current control; a model cannot supply a foreign Notebook URL.

The nine native tools list resources, describe live cells/control, read/edit a cell,
submit an exact version, query a run, and stop that exact run. Per-message context
refreshes bounded live previews so human parameter and Markdown edits are visible.
Full cell source and execution results are read on demand. Changing Project
fences callbacks against the old directory.

Human Run transfers control to that human. To resume a requested Agent experiment,
use the explicit `notebook_take_control` tool with the owner/generation observed by
`notebook_describe`. The server refuses transfer during active experiments; stale
intent, unresolved local runs, a stopped session and a changed Project also refuse.
This transfer keeps the same Notebook and kernel and does not interrupt anyone's run.

Metadata-only execution records live under `.jupyter/executions`. A durable owner
belongs to the conversation, independently of its model/Harness. Each submitted
run is recorded before HTTP and retains its original target/request identity.
Service session recreation and `/reset` retain the Notebook and its kernel;
unverified runs must be queried, never automatically replayed.

`notebook_reconcile_submission` resolves an original unaccepted attempt using its
persisted target, not model-provided execution metadata. It sends no source code.
The server either returns the existing correlated execution, or atomically proves
absence and permanently blocks that run ID from entering a kernel. A late original
POST cannot bypass the fence, including one already waiting for an RTC room.
Ownership loss, an unverified original kernel incarnation, recorded unknown native
sends, malformed proofs and network failures keep the attempt unresolved.

A verified `not_started` observation includes the full original target and a
durable `submissionFenced` flag. It invents no accepted handle, native request ID,
interrupt, idle confirmation or surviving kernel memory. Once reconciled, a user
can explicitly request a new experiment with a new run ID; the old one is never
resubmitted. A failed status read cannot erase an already verified terminal record;
an exact server handle reporting a contradictory unknown state remains visible.

`/stop` first fences native callbacks and inference. It then asks the server to
pause this controller generation and cancel its whole unsent queue atomically,
before interrupting the exact active run. The response reports confirmed
cancellation, already terminal runs, lost authority and unknown outcomes
separately. Idle inference does not prevent stopping a background Notebook run.
After a successful owner pause, an unknown attempt without an accepted handle is
also reconciled and fenced. Verified unsubmitted work is reported as already
terminal, not as a confirmed kernel cancellation. If the server finds an existing
run, stop follows its original handle and waits for its terminal observation.
A new host session resumes a paused generation only after recorded runs are
terminal; old callbacks cannot resume it. This local metadata store assumes one
Service writer; the Jupyter ledger enforces a single server writer.

## Legacy coordinator evidence

Tests and an opt-in real DSH probe cover native read/edit/run, continuation with
persisted session/run identity, exact stop, background execution after inference
ends, owner stop and same-kernel continuation. Run the composed probe with
`tests/jupyter/coordinator-probe.py --host-session --dsh-checkout <checkout>` and
explicit authentication/model arguments; it uses only owned temporary resources.
These are component results, not Feishu or JupyterLab UI acceptance.

For the user's configured server, use the host-catalog mode documented in
[the acceptance probe guide](../tests/jupyter/README.md#configured-server-dsh-probe).
It checks authentication/coordinator readiness before any model or Notebook
operation, preserves a dedicated persistent Project, refuses a foreign owner
and verifies that accepted runs keep one kernel incarnation. A missing extension
is a blocked prerequisite, never a passing Notebook result.

The submission fence requires ledger schema 3. Earlier experimental schemas are
preserved and refused, with no reset or automatic migration. The configured
coordinator candidate would still need reviewed extension activation and actual
same-Notebook DSH/Feishu acceptance. That activation is not the 0.6.3 Datalayer
route. The old profile's unit checks do not establish the product loop for either
backend.

Daily and candidate default model selection remains `gpt-6-luna`. The designated
#5215/#5219 real-model acceptance explicitly uses `gpt-5.6-luna` without changing
that default. Real Feishu round trips, authenticated user-device entry,
Lab Run/Interrupt/input UI, full recovery/auth/network faults and research
report/artifact delivery remain separate acceptance requirements. Large output
truncation is visible and does not count as complete artifact delivery.
