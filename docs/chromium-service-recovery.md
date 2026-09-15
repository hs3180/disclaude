# Chromium service activation and recovery

On macOS, `disclaude chromium-cdp install`, `start`, and `restart` validate the selected executable with `browser doctor` using disposable state before changing persistent configuration. An unavailable executable or another process holding the requested CDP port leaves the existing service and configuration intact. If the service is already loaded, use `restart` to change its settings.

Success requires three consecutive checks of the same launchd PID, listener PIDs, and CDP discovery identity. Every listener on the selected port must descend from the selected service process. A successful `launchctl load` alone is insufficient. The readiness deadline is 20 seconds; the disposable browser preflight is bounded to 90 seconds.

The command retains the previous configuration and plist bytes and permissions. If activation or readiness fails, it unloads the candidate, restores those files, and—if the previous service was loaded—starts and checks the previous endpoint. A failed recovery is reported as incomplete; it is never reported as a successful installation. Browser profiles are preserved, including a newly created candidate profile.

Mutating Chromium commands use a per-plist exclusive lock, also covering different configuration paths that target the same service label. A stale lock is reported with its path and contains the owning PID. Check that the recorded process is no longer active before removing it. This is recovery from command-observed failures, not a durable transaction across process termination, machine failure, external launchctl commands, or manual file replacement. Saved files must still describe the loaded service; arbitrary changes made outside this CLI are not reconciled automatically.

The preflight separately reports temporary-profile Cookie persistence. It does not test the persistent service profile, migrate credentials, prove login-state persistence under launchd, or require access to macOS Keychain for ordinary browser use. Existing headed/headless configuration is preserved. Interactive selection/download, native Linux service setup and migration remain tracked in #4828.

## Real macOS service acceptance

Run only with an explicitly selected browser and opt-in:

```sh
DISCLAUDE_E2E_CHROMIUM=/absolute/path/to/Chromium \
DISCLAUDE_E2E_CHROMIUM_LAUNCHD=1 \
npx vitest run tests/e2e/chromium-launchd.test.ts
```

The test uses `scripts/launchd.mjs chromium-isolated` with an explicit isolation flag, a unique `com.disclaude.test.*` label, state directory, loopback port, configuration and profile. Configuration/profile paths must stay inside the test state directory, including through existing symlink ancestors. It skips package `.env` loading and refuses incomplete isolation settings. It never selects the production service label.

The real browser starts under launchd, restarts, retains a profile marker, rejects an invalid executable and a conflicting port, then recovers the old service when a candidate executable passes the temporary-profile preflight but exits under the persistent service invocation. Independent CDP readback, page input and PNG screenshot checks verify the recovered browser. The test unloads its unique service before deleting its state. It runs only on macOS and is skipped by ordinary Linux CI; Linux CI does not count as native launchd acceptance.

Observed on 2026-09-16: macOS ARM64, Node 24.8.0, `/Applications/Chromium.app/Contents/MacOS/Chromium`, reported browser Chrome/155.0.8057.0. The complete service test passed in 32.88 seconds. All 45 related unit/process tests passed. The test service and temporary profiles were removed afterwards; the daily disclaude service remained running.
