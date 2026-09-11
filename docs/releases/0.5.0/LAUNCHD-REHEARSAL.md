# Isolated launchd installation, upgrade and rollback

Build two independent checkouts before running. The baseline must retain its own
workspace dependency links and build outputs; do not link its node_modules to the
candidate. This harness uses no Feishu credentials and performs no model calls.

```bash
python3 scripts/rehearse-launchd.py \
  --baseline-entry /absolute/previous-checkout/packages/service/dist/cli.js \
  --output /absolute/local-evidence/launchd
```

The harness creates a unique `com.disclaude.test.rc-*` service, temporary config,
workspace, log directory and PID lock. It installs the baseline, stops it, installs
the candidate, then stops it and reinstalls the baseline. Each stage checks the
actual assigned HTTP API address and a preserved workspace file. Finally it stops
and uninstalls only that test service, then checks that the label and plist are gone.

The JSON result retains checkout commits, built runtime hashes, health addresses
and cleanup status. A failed health check or failed cleanup returns nonzero. State
and logs remain in the reported temporary directory for review; only the generated
test plist is removed. No production service recovery or restart is performed.

The underlying `node scripts/launchd.mjs isolated <command>` requires the isolation
flag, a test-only label, absolute state directory and absolute test config.
`DISCLAUDE_LAUNCHD_ENTRY` optionally selects an absolute old/candidate CLI entry for
rehearsal. Entry overrides are rejected outside isolated commands. Launchctl receives
paths as individual arguments, including paths containing spaces.
