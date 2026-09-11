# Log Rotation Configuration

The application writes to `disclaude-combined.log`. Rotation can be handled
either **in-app** (recommended for container/Docker, where no system logrotate
exists) or by **system-level tools** on a host that has them.

> Issue #3416 removed in-app rotation, delegating it to system tools. That left
> Docker deployments with **no** rotation at all — `/data/logs/disclaude-combined.log`
> grew unbounded (observed **49GB**). Issue #4777 restored opt-in in-app
> rotation (pino-roll) so containerized setups self-limit. Issue #4786 added an
> optional stdout mirror so `docker logs` still captures the app log.

---

## Option A — In-app rotation (recommended for Docker)

Set `LOG_TO_FILE=true` plus rotation env vars. Applies size/count-based rolling
via `pino-roll`; rotated files are deleted automatically when the limit is hit,
so the volume stays bounded even though containers have no logrotate.

| Env / config            | Default | Effect |
|-------------------------|---------|--------|
| `logging.rotate` / `LOG_ROTATE` | `false` | Enable rotation |
| `LOG_ROTATE_SIZE`       | `50m`    | Roll a file once it exceeds this size (`k`/`m`/`g`) |
| `LOG_ROTATE_LIMIT`      | `3`      | Total log files kept (current + N-1 rolled) |
| `LOG_ROTATE_FREQUENCY`  | —        | Optional schedule: `daily` / `hourly` |

In the shipped `docker-compose.yml` the `service` service sets
`LOG_ROTATE=true` by default (override in `.env`), so `log_data` stays bounded
out of the box. E.g. `LOG_ROTATE_SIZE=50m LOG_ROTATE_LIMIT=3` keeps at most
~150MB across the current file plus two rolled files.

> Note: with `LOG_ROTATE_FREQUENCY` unset, rotation is purely size-based and
> old files are removed eagerly by the size `limit` — the file set never grows.

> **Filenames change when rotation is on.** pino-roll never writes the bare
> `disclaude-combined.log`. It splits the trailing extension off and inserts
> the sequence number *before* it, so the files on disk are
> `disclaude-combined.1.log`, `disclaude-combined.2.log`, … — **not**
> `disclaude-combined.log.1`. A `current.log` symlink in the same directory
> points at the live file. Anything watching a fixed path must follow
> `current.log` or glob `disclaude-combined.*.log`; the shipped `filebeat.yml`
> covers both, and `scripts/launchd.mjs logs` falls back to `current.log` when
> the bare path is absent.

Manual smoke check:

```bash
npm run build
LOG_TO_FILE=true LOG_DIR=/tmp/lrot LOG_ROTATE=true LOG_ROTATE_SIZE=1m \
  npx tsx packages/service/src/cli.ts start --api-port 19200   # watch /tmp/lrot
ls -la /tmp/lrot   # expect disclaude-combined.1.log/.2.log plus a current.log symlink
```

---

## Option B — Host system tools (Linux / macOS)

Callers running directly on a host (not a container) can keep in-app rotation
off (`logging.rotate: false`) and use the host's logrotate/newsyslog.

### Linux: logrotate

Create `/etc/logrotate.d/disclaude`:

```
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

**Key options:**
- `copytruncate`: Creates a copy then truncates the original — no file handle issues
- `rotate 30`: Keep 30 days of logs
- `maxsize 10M`: Rotate if file exceeds 10MB even before daily cycle
- `compress`: Gzip old logs to save disk space

### macOS: newsyslog

Create `/etc/newsyslog.d/disclaude.conf`:

```
# logfilename                         [owner:group]  mode  count  size    when    flags  [/pid_file]  [sig_num]
~/Library/Logs/disclaude/disclaude-combined.log   644   30     10240   *       ZC
```

**Key options:**
- `30`: Keep 30 archived log files
- `10240`: Rotate when file exceeds 10MB (in KB)
- `Z`: Compress archived logs with gzip
- `C`: Use copy-truncate mode (safe for open file handles)

### Manual Testing

```bash
# Linux: force rotation
logrotate -vf /etc/logrotate.d/disclaude

# macOS: force rotation
sudo newsyslog -Fv
```

---

## Docker logs collection (Issue #4786)

With `LOG_TO_FILE=true`, all pino records go to the file, so `docker logs` (and
Docker's `json-file` driver `max-size`/`max-file`) see nothing — only entrypoint
text. Two options:

- **Mirror to stdout** (recommended): set `LOG_MIRROR_STDOUT=true`
  (or `LOG_TO_FILE=tee`). The app then copies every record to both the file and
  `stdout`, so `docker logs` captures it and Docker's `max-size: 10m` /
  `max-file: 3` bounds the stdout copy. The file copy is unaffected.
  Enabled by default in `docker-compose.yml`.
- **Rely on JSON-level mirroring** for warn/error only — not yet built; the
  simple all-level mirror above covers the common case.

`docker compose logs -f disclaude` then shows the full app log while
the file in `log_data` stays bounded by Option A rotation.

---

## Recovering an existing oversized file

A file that already ballooned (e.g. 49GB) is not retroactively trimmed by
rotation. To reclaim the disk once, either:

```bash
# compress in place (keep a compressed copy, then you can remove the original)
du -h /path/to/logs/disclaude-combined.log
cp /path/to/logs/disclaude-combined.log /path/to/logs/disclaude-combined.log.gz
> /path/to/logs/disclaude-combined.log          # truncate the live file
```

or attach a fresh `log_data` volume after rotating via a one-off cleanup, then
let in-app rotation keep future growth bounded.