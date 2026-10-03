# Notebook tools in the Service

DSH is the primary native adapter for Notebook tools. The Service binds the
shared document and execution APIs to Project references; neither Notebook
identity nor execution authority comes from a Harness session ID. Select
`agentBackend: deepseek` and the supported DSH provider route. Other adapters
currently reject these native tools explicitly. No Codex CLI/MCP process is
required for Notebook access.

## Host connection configuration

The Service reads `JUPYTER_CONNECTIONS_FILE`, or
`~/.disclaude/jupyter/connections.json`. Create a private file (mode 0600):

```json
{
  "version": 1,
  "connections": [
    {
      "id": "research",
      "baseUrl": "https://jupyter.example/",
      "authorizationFile": "/private/path/jupyter-authorization"
    }
  ]
}
```

The authorization file contains the complete HTTP authorization header and must
also have mode 0600. Alternatively use `authorizationEnv` with a host environment
variable name. This variable is removed from the environment passed to model
processes. URLs must not contain credentials or tokens. Password login and
automatic credential refresh are not implemented.

Cookie identity is kept in a private `sessions` directory beside the host
configuration, with connection definition and server namespace isolation.
Restarting a Service connection restores that cookie identity. Project files and
native tool descriptors contain no credentials or cookies. The host must already
run the pinned managed Jupyter extension described in [the backend guide](../jupyter/README.md).
The Service does not install Python packages, start a server, delete kernels or
edit an existing external server configuration.

## Project and conversation state

`<workingDir>/.jupyter/config.json` contains only authorized Notebook references
(`connectionId`, `serverNamespace`, `documentId`, `contentPath`, optional observed
version). An unresolved path is replaced with its server-issued stable identity
only while the original reference still matches. Each operation rechecks Project
references and current control; a model cannot supply a foreign Notebook URL.

The seven native tools list resources, describe live cells, read/edit a cell,
submit an exact version, query a run, and stop that exact run. Per-message context
refreshes bounded live previews so human parameter and Markdown edits are visible.
Full cell source and execution results are read on demand. Changing Project
fences callbacks against the old directory.

Metadata-only execution records live under `.jupyter/executions`. A durable owner
belongs to the conversation, independently of its model/Harness. Each submitted
run is recorded before HTTP and retains its original target/request identity.
Service session recreation and `/reset` retain the Notebook and its kernel;
unverified runs must be queried, never automatically replayed.

`/stop` first fences native callbacks and inference. It then asks the server to
pause this controller generation and cancel its whole unsent queue atomically,
before interrupting the exact active run. The response reports confirmed
cancellation, already terminal runs, lost authority and unknown outcomes
separately. Idle inference does not prevent stopping a background Notebook run.
A new host session resumes a paused generation only after recorded runs are
terminal; old callbacks cannot resume it. This local metadata store assumes one
Service writer; the Jupyter ledger enforces a single server writer.

## Evidence and remaining work

Tests and an opt-in real DSH probe cover native read/edit/run, continuation with
persisted session/run identity, exact stop, background execution after inference
ends, owner stop and same-kernel continuation. Run the composed probe with
`tests/jupyter/coordinator-probe.py --host-session --dsh-checkout <checkout>` and
explicit authentication/model arguments; it uses only owned temporary resources.
These are component results, not Feishu or JupyterLab UI acceptance.

Daily and candidate default model selection remains `gpt-6-luna`. The designated
#5215/#5219 real-model acceptance explicitly uses `gpt-5.6-luna` without changing
that default. Real Feishu round trips, authenticated user-device entry,
Lab Run/Interrupt/input UI, full recovery/auth/network faults and research
report/artifact delivery remain separate acceptance requirements. Large output
truncation is visible and does not count as complete artifact delivery.
