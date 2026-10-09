# Optional Jupyter integration

Jupyter is accessed through the packaged [jupyter Skill](../skills/jupyter/SKILL.md)
and `disclaude jupyter` CLI. The CLI calls the existing remote Datalayer,
RTC, Contents and nbconvert interfaces through Node clients. It can also run
outside disclaude's chat service. See the [CLI contract and setup](../skills/jupyter/README.md).

The Jupyter MCP extension is not required. Connection discovery reads the native
Jupyter, RTC, nbmodel and nbconvert interfaces without calling `/mcp`.

```text
Agent's existing shell tool
  -> jupyter Skill / disclaude jupyter command
  -> on-demand Node Notebook tools
  -> remote Jupyter / Datalayer / kernel

Downloaded report paths
  -> existing channel Skill / CLI
  -> requested chat and thread
```

ChatAgent, its configuration/factory, ChatSessionPool, service startup and chat
control commands have no Jupyter imports, session extension, lifecycle hooks,
automatic per-message Notebook reads or Notebook delivery callbacks. The
existing ProjectManager still selects the working directory. The Skill reads
Project-local references only when Notebook work is requested.

`@disclaude/core/jupyter` is a dedicated transport entrypoint. Optional CLI
commands do not initialize SDK providers or load service configuration. RTC
dependencies are loaded when a document is opened. No new runtime dependency
or generic agent plugin framework is added.

State belongs to the resource: reference metadata and original run facts are
stored in the Project, while Notebook content and kernel memory remain on the
remote server. CLI process lifetime is independent from the kernel. The CLI
closes its RTC connections after each command and never recreates a missing
original kernel after a recorded execution.

`execute` returns an original run ID; `status` and `stop` address that run across
new CLI processes. Unknown submissions are not replayed. `stopConfirmed: true`
requires an observed terminal cancellation. Chat `/stop` retains its ordinary
inference behavior; remote cancellation is explicit through the Jupyter command.

`download-report` creates persistent local HTML/ipynb files and bounded images
from a verified snapshot, then returns paths and hashes. Channel delivery uses
its existing recipient/thread options and confirmation contract. The Notebook
tool does not retain a callback to the originating chat turn.

The earlier coordinator-backed agent session, controller/lease journal and
DSH service-composition probe are removed from this PR. The discarded historical
coordinator integration is outside delivery scope; this integration uses Datalayer only.
The existing `jupyter patch` installer remains Jupyter Terminal only.

`disclaude jupyter test` runs the configured-server core, edge, fault and report
suites and returns one JSON summary with source/check counts and private evidence
paths. `--suite` selects a subset; `--list` and `--help` need no authentication.
It reuses environment, `.env` and hidden interactive authentication. Model/image
and real Feishu delivery suites require explicit selection and their own inputs.
See the [test command guide](../jupyter/probes/README.md). Probes ship with the
standalone package, create only owned test resources, and do not start local
Jupyter, install packages or manage server deployment.

The CLI is an access mechanism for a persistent Project and live remote
Notebook. Installing a Skill by itself is not Project/workspace product
acceptance. Protocol fixtures, configured-server experiments, model research,
channel delivery and device feedback must be recorded separately for the tested
source revision. Manual Lab editing is outside the user's 0.6.3 acceptance scope.
