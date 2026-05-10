# Log Rotation Configuration

The application writes to a single log file (`disclaude-combined.log`) using `pino.destination()`.
Log rotation is delegated to system-level tools for reliability.

## Linux: logrotate

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

## macOS: newsyslog

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

## Manual Testing

```bash
# Linux: force rotation
logrotate -vf /etc/logrotate.d/disclaude

# macOS: force rotation
sudo newsyslog -Fv
```
