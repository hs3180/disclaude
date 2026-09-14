# Persistent Chromium service selection

The macOS `disclaude chromium-cdp generate/install/start/restart` commands save
the resolved browser path, profile, port, address and headed mode to
`~/.config/disclaude/chromium-cdp.json` (or `$XDG_CONFIG_HOME/disclaude/…`).
`DISCLAUDE_CHROMIUM_CONFIG` selects an absolute custom file path.

Resolution order is explicit environment, saved configuration, legacy package
`.env`, then existing defaults. Only the five `CHROMIUM_CDP_*` settings are saved,
with file mode 0600; unrelated credentials and process environment are excluded.
The file survives npm replacement and works from any cwd. `uninstall` retains it
and the profile. Corrupt configuration fails explicitly; stop/uninstall/logs
remain available for recovery.

For migration, supply the actual existing binary/profile/port/headed settings
when generating the service once. Read the existing plist first: this change
does not automatically import hand-written launchd definitions. Subsequent
restarts read the saved selection without a package `.env` symlink. An explicit
missing binary now fails instead of silently selecting another installed browser.
Generation and config validation happen before restart unloads the service.

This change only persists the current macOS command's selection. It does not yet
provide interactive setup/download, Linux service adapters, CDP readiness,
transactional launch failure rollback, or authoritative loaded-service status.
`status` labels its resolved profile as configured, which can differ from the
loaded service after `generate`. These remain tracked in #4828/#4982.
