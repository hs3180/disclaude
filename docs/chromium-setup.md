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

Setup supports existing executables and verified independent Chromium downloads. Existing deployment/profile migration remains in #4828. `--autostart` / `--no-autostart` select login autostart; the interactive question and saved `CHROMIUM_CDP_AUTOSTART=1|0` provide the same choice. Repeated setup/restart uses the saved preference. macOS places manual-only definitions outside LaunchAgents while retaining crash restart behavior for a manually started service; Linux enables/disables the user unit. Neither platform logs the user out or enables lingering. It does not claim service-profile login persistence from temporary-profile doctor results.

## Acceptance

The opt-in `tests/e2e/chromium-setup.test.ts` invokes the actual `bin/disclaude.js` entry, previews, rejects a missing non-interactive confirmation, applies and repeats setup, verifies saved configuration/profile preservation and removes its unique test service. It uses the guarded `--isolated` selector with explicit test service labels/configuration/profile/ports. The ordinary command cannot override production service labels without the adapter's isolation settings.

Observed on macOS ARM64 with Chromium 155.0.8057.0: real CLI setup E2E passed in 7.93 seconds. Separate actual PTY runs exercised browser choice, profile/port/mode questions, dry-run and cancellation, with no profile directory created. The original native Linux setup case passed in 8.33 seconds (run 35008808989). The expanded macOS autostart case passed in 44.07 seconds: toggle off/on, saved preference on repeat, and failed browser replacement plus autostart change restoring the old service/definition/preference. Expanded Linux CI passed in 49.35 seconds (run 35009736307). Tests inspect definition placement/unit enablement and actual running services; they do not log the desktop out and back in.

## Download independent Chromium

The terminal menu also offers an independent download on macOS ARM64/x64 and Linux x64. If no installed Chromium is found, this is the suggested choice. Other architectures must select an existing executable. The source is the [official Chromium snapshot archive](https://www.chromium.org/getting-involved/download-chromium/); snapshots are development builds and do not update themselves.

```sh
disclaude chromium-cdp setup --download --revision 1698254 \
  --browser-dir /absolute/path/to/downloaded-browsers \
  --profile /absolute/path/to/automation-profile \
  --headless --no-autostart --yes
```

Omit `--revision` to resolve the platform's current `LAST_CHANGE`. `--dry-run` fetches metadata and prints the candidate source, size, checksum and destination without downloading or creating directories. Downloads default to `$XDG_DATA_HOME/disclaude/browsers`, or `~/.local/share/disclaude/browsers`. Browser binaries and the persistent profile are separate.

Installation pins the object generation and checks the advertised size and published MD5 over HTTPS. It records a locally computed SHA-256; this is an audit identifier, not an independently published signature. Before OS extraction it bounds expanded size and rejects unsafe ZIP paths and symlink chains. Temporary downloads and their installation locks are removed after ordinary failure or cancellation; a lock left by an uncatchable termination requires inspecting its recorded owner before manual removal.

On macOS, `codesign --verify --deep --strict` is a separate check. Failure defaults to rejection before executing the candidate. Interactive use requires an explicit choice; unattended use requires `--allow-unverified-signature` after reviewing the result. This does not change Gatekeeper, Keychain or system settings, and a successful code-signature check is not a notarization claim.

A candidate is published only after its actual executable reports a version and passes headless `browser doctor` with a temporary profile. `verification.json` records the archive, signature result, diagnosis mode/time and payload digest. Reuse verifies the entire payload; changed files cause rejection while preserving the directory. Reuse retains the original diagnosis timestamp, while every setup separately checks the requested service mode and real CDP readiness. Temporary-profile cookie results do not establish login persistence in the user's service profile. Old versions are retained; this command does not automatically remove existing browsers or profiles.

Acceptance: nine archive/integrity boundary tests pass. On macOS ARM64, the actual revision 1698254 archive (174,014,049 bytes) passed download integrity and extraction; the code-signature check failed with a resource-signature error. The default decline path stopped before executing the candidate, preserved caller data and removed staging/locks (11.25 seconds). This is evidence for refusal and cleanup, not successful execution of that snapshot. `tests/e2e/chromium-download.test.ts` exercises the real Linux download through setup, service startup, verified reuse, changed-payload refusal and cleanup; the actual Ubuntu 22.04 x64 lifecycle passed in 51.88 seconds (run 35012801423, source ece98b0a), using Chromium 156.0.8061.0 from revision 1698254, archive SHA-256 `b20e3a8a27834bb324d541fec2390b825e515d8ff47941eea510dfa32513b17d`. The first Ubuntu 24.04 run failed during preflight with `No usable sandbox!`; downloaded snapshots cannot start under that default policy. Setup now reports that limitation directly and discards the candidate before service changes. CI retains Ubuntu 24.04 as an explicit refusal/cleanup contract (passed in run 35012801423) alongside Ubuntu 22.04 for the complete lifecycle. Neither job changes the sandbox or system security policy; passing refusal does not mean the browser is usable in that environment. See the [Chromium AppArmor documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).


## Inspect the selected browser and service

`disclaude chromium-cdp status` returns JSON on macOS and Linux. `loaded` reports the service manager state; `cdpReady` independently checks stable discovery and that the listener belongs to the service process. A loaded service that fails this check exits with status 1. macOS status previously returned human-readable launchctl text; scripts consuming it must use the JSON fields now.

`configured` reports the saved browser selection, independently of invocation-only candidate overrides: executable path/availability, known snapshot source and recorded signature/version, profile path, the profile's `Last Version` marker and whether `SingletonLock` exists. A lock marker alone does not prove that its owner is alive. Status does not open the profile, read cookies, change the service or remove locks. Snapshot attribution comes from its nearby matching verification record; `payloadRevalidatedByStatus: false` explicitly means status has not rerun the payload integrity check.

The top-level endpoint comes from the service definition used for the health probe. `configurationMayDifferFromLoadedService` warns that externally edited configuration/definitions can differ from an already-loaded process; metadata is not proof that the process was restarted with those settings. The report also gives service-definition/configuration locations and, on macOS, log paths. Existing-profile migration and live login persistence remain separate work.
