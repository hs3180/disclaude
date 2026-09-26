# Chromium service activation and recovery

On macOS, `disclaude chromium-cdp install`, `start` and `restart` validate the
selected executable with `browser doctor` using disposable state before changing
persistent configuration. An unavailable executable or unrelated process
holding the requested CDP port leaves the existing service and configuration
intact. If the service is already loaded, use `restart` to apply new settings.

Readiness requires three consecutive checks of the same launchd PID, listener
PIDs and CDP discovery identity. Every listener on the selected port must descend
from the service process; a successful `launchctl load` alone is not enough.
Preflight and readiness have bounded deadlines.

If activation fails, the command unloads the candidate, restores the previous
configuration and plist bytes/permissions, and checks the prior service when it
was loaded. A failed recovery is reported as incomplete, never as a successful
installation. Browser profiles are preserved. Mutating commands use a
per-service exclusive lock; inspect the recorded PID before removing a stale
lock. Recovery covers command-observed failures, not machine failure, external
`launchctl` changes or manual replacement of saved files.

## Login autostart

`CHROMIUM_CDP_AUTOSTART=1|0` stores the selected preference. Automatic
definitions live in `~/Library/LaunchAgents`; manual-only definitions live in
`~/Library/Application Support/disclaude/services`. A verified change moves the
definition only after the new service is ready; failed activation restores the
previous service and files. Both definitions retain crash restart behavior when
explicitly loaded. This does not modify the launchd disabled-state database or
log the user in.

## Profile safety

Before activation, the selected profile is checked for a `SingletonLock` owned
by another process, host or unverifiable owner. Such locks are preserved and
activation fails before replacing the service. The CLI does not stop another
browser or delete its lock. A known profile major version newer than the
candidate is rejected before persistent changes; same-major compatibility is
not guaranteed across every build.

The temporary-profile doctor does not establish service-profile login
persistence, migrate credentials or roll back a browser profile schema. See
[browser setup](chromium-setup.md) and the [native Linux service guide](chromium-linux-service.md)
for setup on the respective platforms.
