# Browser selection and setup

`disclaude chromium-cdp setup` selects an installed Chromium/Chrome executable
or downloads an independent Chromium build, configures a dedicated profile and
loopback CDP port, and delegates activation to the platform service manager.
Installed local browsers are listed before download candidates. The wizard
shows the resolved executable/version, profile, headed mode and login-autostart
choice before applying changes. A fresh configuration defaults to visible mode;
Linux headless hosts can select `--headless`.

For non-interactive setup, supply an executable and explicit confirmation:

```sh
disclaude chromium-cdp setup \
  --binary /absolute/path/to/browser \
  --profile /absolute/path/to/automation-profile \
  --port 9222 --headless --no-autostart --yes
```

Use `--dry-run` to preview the selection without saving configuration, creating
the profile or managing a service. It still probes the selected executable's
version. Without a TTY or explicit confirmation, setup fails without changing
the service. Repeating setup reuses the saved selection and profile.

## Download an independent Chromium

Downloads are available on macOS ARM64/x64 and Linux x64. The source is the
[official Chromium snapshot archive](https://www.chromium.org/getting-involved/download-chromium/);
snapshots are development builds and do not update themselves. For example:

```sh
disclaude chromium-cdp setup --download --revision 1698254 \
  --browser-dir /absolute/path/to/downloaded-browsers \
  --profile /absolute/path/to/automation-profile \
  --headless --no-autostart --yes
```

Omit `--revision` to resolve the platform's current `LAST_CHANGE`. Downloads
default to `$XDG_DATA_HOME/disclaude/browsers`, or
`~/.local/share/disclaude/browsers`. Browser binaries and profiles are separate.

Setup checks the advertised archive size and checksum over HTTPS, records a
local SHA-256 identifier, and rejects unsafe archive paths or symlink chains.
The executable must report a version and pass `browser doctor` with a temporary
profile before publication. Reuse verifies the payload; changed files are
rejected without deleting the existing directory. On macOS, code-signature
verification is separate; failure requires an explicit interactive choice or
`--allow-unverified-signature` for unattended use. A successful signature
check is not a notarization claim. Old downloaded versions are retained.

Setup uses the selected persistent profile directory directly. It does not copy
or migrate data from another browser profile; choose the existing profile path
only when it is already the intended profile for this service.

## Inspect the service

`disclaude chromium-cdp status` returns JSON on macOS and Linux. `loaded` reports
the service-manager state; `cdpReady` checks stable discovery and that the
listener belongs to the service process. `configured` reports the saved
selection, executable availability, profile, and relevant version/lock metadata.
A `SingletonLock` marker does not prove that its owner is alive. Status does not
open the profile, read cookies, change the service or remove locks.

`disclaude chromium-cdp doctor` is also read-only and reports configuration,
service state, CDP reachability, and repair hints. Inside Docker, it reports the
service as external and leaves `cdpReady` unknown because the host cannot verify
which process owns the container's listener. On macOS, an existing legacy
`~/Library/Application Support/disclaude/chromium-cdp.json` remains readable
when the default XDG config file is absent; an explicit config path or
`XDG_CONFIG_HOME` takes precedence.

Configuration metadata can differ from a service that was already loaded when
files were externally changed. Restart through the service adapter after an
intentional configuration change; do not infer the loaded process's settings
from saved files alone.

If activation fails, the command reports whether the previous service was
restored. Profiles are preserved; status and recovery do not stop another
browser or remove an unverifiable lock.

## Import older configuration

Use `--import-config /absolute/path/to/old.env --dry-run` to inspect a literal
legacy `.env` or version-1 Chromium configuration JSON file. Only supported
browser settings are imported; unrelated credentials are neither copied nor
displayed. Shell expansion is not executed. Invalid, duplicate or unsafe values
are rejected. Review the preview before applying; the source file remains
unchanged. Import does not discover or stop independently managed services.

See the [native Linux guide](chromium-linux-service.md) for platform-specific
lifecycle behavior.
