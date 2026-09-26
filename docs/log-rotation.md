# Log rotation

Use Disclaude's built-in size/count rotation to keep file logs bounded. The
Docker Compose service enables rotation and stdout mirroring by default; no
separate cleanup daemon is required.

## Application-managed rotation

| Setting | Default | Purpose |
| --- | --- | --- |
| `logging.rotate` / `LOG_ROTATE` | `false` outside the shipped Compose configuration | Enable file rotation |
| `LOG_ROTATE_SIZE` | `50m` | Rotate after the current file reaches this size (`k`, `m`, or `g`) |
| `LOG_ROTATE_LIMIT` | `3` | Maximum number of current and rotated files |
| `LOG_ROTATE_FREQUENCY` | unset | Optional `daily` or `hourly` rotation |
| `LOG_MIRROR_STDOUT` | enabled in the shipped Compose configuration | Also send application records to stdout |

With size-based rotation, old files are removed when the configured file limit
is reached. For example, `50m` and a limit of `3` keep approximately 150 MB
across the active and rotated files.

Rotated files use names such as `disclaude-combined.1.log` and
`disclaude-combined.2.log`; a `current.log` symlink identifies the active file.
Collectors should watch `current.log` or match `disclaude-combined.*.log` rather
than assuming that the active file keeps the unnumbered name.

In Docker, stdout mirroring lets `docker logs` and the configured Docker log
driver collect application output, while the file volume remains bounded by
application rotation:

```sh
docker compose logs -f service
```

## Host-managed rotation

For a host deployment that intentionally disables application rotation, use
the host's existing log manager. For example, a Linux `logrotate` rule can be:

```text
/path/to/logs/disclaude-combined.log {
    daily
    rotate 30
    maxsize 10M
    copytruncate
    compress
    delaycompress
    missingok
    notifempty
}
```

When using host rotation, make sure the rule matches the actual active log path
and coordinate it with any application rotation settings. Avoid running a
second Disclaude service solely to delete or truncate logs.
