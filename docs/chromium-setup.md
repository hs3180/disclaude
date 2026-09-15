# Browser selection and setup

`disclaude chromium-cdp setup` offers terminal selection of an installed Chromium/Chrome or an absolute custom executable. Installed independent Chromium is listed first. The wizard asks for a dedicated persistent profile, loopback CDP port, visible/headless mode and login autostart, displays the selected executable and its actual version, and requires confirmation before delegating to the platform service manager.

On a fresh configuration, visible mode is the default. Existing saved profile/port/mode are offered as defaults; explicit flags take precedence. A Linux headless server can select `--headless`. The selected program is reused with the dedicated automation profile.

For non-interactive use, provide the executable and explicit confirmation:

```sh
disclaude chromium-cdp setup \
  --binary /absolute/path/to/browser \
  --profile /absolute/path/to/automation-profile \
  --port 9222 --headless --no-autostart --yes
```

Use `--dry-run` instead of `--yes` to print the selection as JSON without writing configuration, creating the profile or managing a service. It still invokes the selected executable's `--version`. Without a TTY or explicit confirmation the command fails promptly. Cancelling terminal confirmation also leaves the service untouched.

Applying setup uses the existing platform adapter: install when inactive, restart when already running. The adapter performs disposable-profile preflight, real CDP/process checks and caught-failure recovery. Repeating setup preserves profile data. An unhealthy Linux service can still be selected for restart; its failed health report is not treated as a successful setup. The command forwards termination signals to its direct adapter process; this does not add durable recovery across process termination.

This first setup entry supports existing executables. Downloading independent Chromium and existing deployment/profile migration remain in #4828. `--autostart` / `--no-autostart` select login autostart; the interactive question and saved `CHROMIUM_CDP_AUTOSTART=1|0` provide the same choice. Repeated setup/restart uses the saved preference. macOS places manual-only definitions outside LaunchAgents while retaining crash restart behavior for a manually started service; Linux enables/disables the user unit. Neither platform logs the user out or enables lingering. It does not claim service-profile login persistence from temporary-profile doctor results.

## Acceptance

The opt-in `tests/e2e/chromium-setup.test.ts` invokes the actual `bin/disclaude.js` entry, previews, rejects a missing non-interactive confirmation, applies and repeats setup, verifies saved configuration/profile preservation and removes its unique test service. It uses the guarded `--isolated` selector with explicit test service labels/configuration/profile/ports. The ordinary command cannot override production service labels without the adapter's isolation settings.

Observed on macOS ARM64 with Chromium 155.0.8057.0: real CLI setup E2E passed in 7.93 seconds. Separate actual PTY runs exercised browser choice, profile/port/mode questions, dry-run and cancellation, with no profile directory created. The original native Linux setup case passed in 8.33 seconds (run 35008808989). The expanded macOS autostart case passed in 44.07 seconds: toggle off/on, saved preference on repeat, and failed browser replacement plus autostart change restoring the old service/definition/preference. Expanded Linux CI is pending. Tests inspect definition placement/unit enablement and actual running services; they do not log the desktop out and back in.
