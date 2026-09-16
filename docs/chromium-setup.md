# Browser selection and setup

`disclaude chromium-cdp setup` offers terminal selection of an installed Chromium/Chrome or an absolute custom executable. Installed independent Chromium is listed first. Each discovered candidate shows its path, actual version and existing-local-executable source before selection. A failed or timed-out version probe is shown as unavailable; selecting that candidate still requires the strict version check. The confirmation/JSON summary distinguishes an existing local executable from a verified download; local discovery is not a signature or provenance verification. The wizard asks for a dedicated persistent profile, loopback CDP port, visible/headless mode and login autostart, displays the selected executable and its actual version, and requires confirmation before delegating to the platform service manager.

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

The native service E2Es separately report `NATIVE_SERVICE_COOKIE_PERSISTENCE`.
They create an expiring synthetic cookie in the owned service's default profile,
verify it while running, then query the newly started browser after restart and
failed replacement recovery. Linux requires retention; macOS reports the result
without treating restricted credential storage as failure of ordinary navigation,
input or screenshots. Neither test verifies a real account login or old encrypted
credential migration, and it never changes Keychain settings.

Observed on macOS ARM64, Chromium 155.0.8057.0, runtime source `d5025315`:
the service cookie existed before restart but was absent after both restart and
failed replacement recovery (30.86-second full launchd case). File/profile markers,
health, input and screenshots passed; the isolated service/profile were removed.
This initial observation alone did not establish its cause. Linux headed and
headless both subsequently failed the same post-restart assertion (Actions run
35147489967). A passing temporary doctor profile must not be substituted for
these service-profile results.

The follow-up shutdown probe found no test cookie row after SIGTERM, whereas
`Browser.close` saved an encrypted row and a fresh browser read it successfully.
The service adapters now request normal browser shutdown before invoking the
service manager. They first verify loopback discovery and listener ancestry under
the selected service PID, recheck ownership and wait for the original listener
processes to exit. Recovery uses the endpoint of the service actually started,
including when the failed candidate selected a different port. Unavailable or
unhealthy CDP produces a warning and the normal manager stop still proceeds;
that fallback does not promise persistence. No Keychain settings are changed.

With this fix, macOS ARM64/Chromium155.0.8057.0 retained newly written synthetic
cookies across restart, failed replacement on another port, and explicit
stop/start; the complete native service case passed in 34.02 seconds and removed
its service/profile. Foreign listeners, mismatched websocket endpoints and changed
service owners are rejected without sending a browser command. Fixed Linux
headed/headless acceptance is pending. Real-account login and credential migration
remain unverified.

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

## Copy an offline profile before switching

To preserve an existing Chromium user-data directory, select a new destination profile and use `--copy-profile-from /absolute/source`. In a terminal, choosing a profile path that does not yet exist also offers an optional copy question. The source browser must be closed explicitly; setup does not stop another browser for this operation.

```sh
disclaude chromium-cdp setup --binary /absolute/path/to/browser \
  --profile /absolute/path/to/new-profile \
  --copy-profile-from /absolute/path/to/closed-profile \
  --headless --yes
```

The source must contain a regular JSON `Local State` file (the user-data root, rather than its `Default` subdirectory). Preview reports canonical source/destination paths, entry count and bytes; `--dry-run` creates no copy. Existing destinations, nested paths, live/unknown profile owners and known major-version downgrades are refused. After a successful copy, repeat ordinary setup with the new profile and omit the copy option; copying again never overwrites an existing destination.

The copier checks space, stages privately beside the destination, compares source metadata and content before publishing and supports cancellation. It keeps the original profile unchanged. Source file growth, changed previews and unsupported links/special files fail explicitly. Only root-level runtime markers (`SingletonLock`, `SingletonSocket`, `SingletonCookie`, `DevToolsActivePort`, `RunningChromeVersion`) and this copier's previous provenance record are omitted. Other symlinks are not followed or silently dropped. Files retain owner permission bits inside private directories. A new `.disclaude-profile-copy.json` records source, time, size and a content digest.

These are offline consistency checks, not a filesystem snapshot against concurrent independent writers. The destination is reserved exclusively before publication; a changed/nonempty reservation is preserved on failure. Failed or cancelled staging is removed. A completed copy is retained if subsequent browser activation fails, and the existing service adapter handles its configuration recovery. Copying does not decrypt cookies, change Keychain/system settings, verify real-account login portability or roll back profile schema changes. Actual source/profile preservation and startup acceptance are recorded in the PR; login persistence remains a separate criterion.

Observed on macOS ARM64 with Chromium 155.0.8057.0: the copy/setup lifecycle passed in 58.22 seconds on source 364f70e1, preserving the original marker/version, starting from the copied profile and rejecting a live source and existing destination. An installed distribution loaded the updated setup command and passed offline start/stop/restart in 26.89 seconds. A separate real terminal session selected copying and supplied the source path; dry-run displayed the plan without creating the destination. These observations cover source/profile preservation and startup, not real-account login transfer. Native Linux copy acceptance is recorded separately when available.


### Import an old browser configuration

Use `disclaude chromium-cdp setup --import-config /absolute/path/to/old.env --dry-run`
to inspect a legacy deployment before changing services. The source may be a
literal `.env` file or a version-1 Chromium configuration JSON file. Only the six
`CHROMIUM_CDP_*` browser settings are imported; unrelated application credentials
are neither copied nor displayed. Shell expansion and commands are never executed.
Duplicate browser assignments, invalid values, non-loopback addresses and files
larger than 64 KiB are refused. Use literal absolute browser/profile paths.

Remove `--dry-run` to review and confirm interactively, or use `--yes` after
reviewing the preview. Explicit selection flags override imported fields;
imported fields override the current saved defaults. The source binary is used
unless `--binary` or `--download` explicitly replaces it. The preview lists the
source path, digest, imported field names and final effective selection. A changed
source after confirmation is refused. The active configuration destination cannot
also be the import source.

The source file remains intact. The verified platform activation writes the new
configuration outside the installation directory and keeps its existing failure
recovery behavior. Existing profiles are reused only after ownership/version
checks; `--copy-profile-from` can instead prepare a new profile explicitly.
An independently managed live browser must first be stopped through its original
manager by its operator. Import does not stop arbitrary services, rewrite an
unmanaged systemd unit, remove legacy managers or prove account-login migration.
Keep the old service definition/configuration until the new endpoint is verified;
this import is not automatic adoption of every historical deployment format.
