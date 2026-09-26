# Browser automation in disclaude

Agents use the `browser-use` skill and pipe Python scripts to the configured CLI.
In coordinated mode, the task environment supplies `DISCLAUDE_BROWSER_SOCKET`;
the IPC adapter is resolved relative to the socket and added to PATH. The
coordinator queues callers and owns connection recovery. It reuses upstream
browser-use helpers and harness execution.

Do not inject Chromium endpoints into agent environments or tell agents to reload
or launch daemons. An unavailable socket is an explicit failure, without a direct
connection fallback. Shared pages are expected; control is exclusive per operation
segment. Put dependent navigation, input and verification in one script.

Operators: see [IPC setup and acceptance](../../experiments/browser-control/HARNESS.md).
Chromium connection settings belong to the coordinator's private environment.
macOS launchd and Docker/Linux must both configure a private writable harness home.
Ordinary operations do not require Keychain access.
