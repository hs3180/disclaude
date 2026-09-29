# Browser automation in disclaude

Agents use the `browser-use` skill and pipe Python scripts to the installed
upstream `browser-use` CLI. Disclaude provides a transparent launcher that
serializes each complete CLI invocation with a local OS file lock; it does not
implement a broker, queue protocol, browser API, or Python runtime.

The service selects the CDP endpoint from installed Chromium configuration,
falling back to service-only `BU_CDP_URL` when needed. The launcher passes
connection settings to the upstream CLI, not to the Agent harness. Shared pages
are expected; control is exclusive for one whole CLI invocation. Put dependent
navigation, input and verification in one script.

Operators: see [browser control](../../docs/browser-coordination.md) and the
[CDP endpoint contract](../../docs/cdp-endpoint.md). No coordinator socket,
Python runtime, or separate service configuration is required.
