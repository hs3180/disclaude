# Native Linux Chromium service

`disclaude chromium-cdp` uses the user-level systemd adapter on Linux. It
requires a non-root user, a working user systemd manager and `lsof`. If the
manager is unavailable, the command reports that before changing a service; it
does not install systemd, enable lingering, or substitute a background shell.

Select a browser and a dedicated persistent profile:

```sh
CHROMIUM_CDP_BINARY=/usr/bin/google-chrome \
CHROMIUM_CDP_PROFILE_DIR="$HOME/.local/share/disclaude/chromium-cdp" \
CHROMIUM_CDP_HEADED=0 \
disclaude chromium-cdp install
```

The Linux default is headed and requires `DISPLAY` or `WAYLAND_DISPLAY`. Set
`CHROMIUM_CDP_HEADED=0` for a headless host. CDP is loopback-only. The selected
browser is saved outside the package and reused by restart; explicit environment
overrides take precedence.

`install` enables user-login autostart after readiness succeeds;
`install --no-autostart` disables it. The saved `CHROMIUM_CDP_AUTOSTART=1|0`
preference is used for later start/restart operations. Setup offers the same
choice interactively or through `--autostart` / `--no-autostart`. Supported
commands include `restart`, `stop`, `status`, `logs`, `generate` and
`uninstall`. `generate` writes configuration and a unit but does not assert
browser readiness. Uninstall removes/disables the managed unit and retains the
browser configuration and profile. Autostart requires the user's login session;
this command does not enable lingering.

The unit is `disclaude-chromium-cdp.service` in the user's systemd unit
directory. It executes the selected browser directly and terminates its control
group. Only display-related variables are inherited. A pre-existing unit
without the Disclaude managed marker is preserved for explicit migration.

Activation runs the browser doctor with disposable state and rejects unrelated
listeners on the selected port. Readiness requires stable CDP discovery and
listener ancestry under the unit's main process. If activation fails, the prior
configuration and service are restored and checked; incomplete recovery is
reported explicitly. A stale lock contains the owning PID—confirm that process
has exited before removing it. The activation lock does not make changes
transactional across process or machine failure.

Temporary-profile Cookie persistence is reported separately from service-profile
login persistence. It does not migrate credentials or prove that an account
session transfers. Browser download and setup options are in [browser setup](chromium-setup.md).
Externally changed systemd units or configuration need explicit reconciliation.

See upstream [systemd service semantics](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).
