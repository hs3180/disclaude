# Native Linux Chromium service

`disclaude chromium-cdp` selects the user-level systemd adapter on Linux. It requires a non-root user, a working user systemd manager and `lsof`. An unavailable manager produces a diagnostic before changing a service; the command does not install systemd, enable lingering, start a privileged service or substitute a background shell process.

Select the browser explicitly and use a dedicated persistent profile:

```sh
CHROMIUM_CDP_BINARY=/usr/bin/google-chrome \
CHROMIUM_CDP_PROFILE_DIR="$HOME/.local/share/disclaude/chromium-cdp" \
CHROMIUM_CDP_HEADED=0 \
disclaude chromium-cdp install
```

The native Linux default is headed and requires DISPLAY or WAYLAND_DISPLAY. Set `CHROMIUM_CDP_HEADED=0` for a headless host. The adapter supports loopback CDP only. It saves the browser selection with the existing version-1 configuration outside the package; subsequent restart uses that selection, with explicit environment overrides taking precedence.

`install` enables login-session autostart after readiness succeeds; `install --no-autostart` skips enabling. `start` preserves the current enablement state. `restart`, `stop`, `status`, `logs`, `generate` and `uninstall` are also supported. `generate` only writes configuration and a unit; it does not assert browser readiness. Uninstall removes/disables the managed unit and retains browser configuration and profile data. Autostart means the user manager's default target, not boot without login; this command does not enable lingering.

The unit is `disclaude-chromium-cdp.service` in the user's systemd unit directory. It executes the selected browser directly with Type=exec and control-group termination. Command arguments escape systemd specifier and environment expansion. A pre-existing unit without the managed marker is preserved for explicit migration. DISPLAY, WAYLAND_DISPLAY, XAUTHORITY and XDG_RUNTIME_DIR are the only inherited display environment entries written into the unit.

Activation first runs the product doctor against disposable state. It rejects unrelated port listeners before replacing a running service, then requires stable CDP discovery and listener ancestry under the unit's MainPID. The same file-preservation and caught-failure rollback mechanism is shared with macOS. A rollback rechecks the old endpoint and reports incomplete recovery explicitly. The per-unit activation lock is not a durable transaction across process or machine termination; inspect a stale lock's recorded PID before removing it.

Temporary-profile Cookie persistence is reported separately. It is not service-profile login persistence, credential migration, an interactive installer or a browser download facility. Existing externally changed unit/configuration state needs explicit reconciliation.

## Actual native Linux acceptance

The `Native Linux Browser Service E2E` workflow starts an isolated user manager in its disposable Ubuntu runner, then uses a unique `disclaude-test-*.service`, temporary configuration/profile and loopback port. It checks unit syntax, login-session enablement, install/restart, invalid executable, port conflict, failed candidate activation, recovered page input/screenshot and profile preservation, then uninstalls the test unit.

Opt-in test entry:

```sh
DISCLAUDE_E2E_CHROMIUM=/absolute/path/to/browser \
DISCLAUDE_E2E_CHROMIUM_SYSTEMD=1 \
npx vitest run tests/e2e/chromium-systemd.test.ts
```

This needs a working native user systemd manager. It is skipped on macOS and in ordinary tests. The initial native Linux run passed on 2026-09-16: Ubuntu x64, systemd 255 (255.4-1ubuntu8.17), Node 24, and Chrome 152.0.7977.82, in 36.83 seconds (Actions run 35005999891). This covered install, enablement, restart, invalid path, port conflict, replacement rollback, recovered input/screenshot and cleanup. The expanded native run also passed (source 4c451fb3, Actions run 35006329212): 59.47 seconds, including first-install failure cleanup, status and stop/start. The shared-helper macOS launchd regression passed separately in 33.09 seconds. These are actual platform service cases; ordinary local unit tests are not counted as native Linux acceptance.

The service semantics follow upstream [systemd.service documentation](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml). The adapter still checks application readiness after the service manager accepts startup.
