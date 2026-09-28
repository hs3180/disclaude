# Logging

Disclaude emits structured Pino JSON to stdout/stderr. Docker collectors can
read `docker compose logs`; host collectors can consume the service output or
the optional application log file. Disclaude does not send logs directly to an
Elasticsearch or other storage backend.

## File logging and rotation

| Setting | Behavior |
| --- | --- |
| `LOG_TO_FILE=true` | Write `disclaude-combined.log` under `LOG_DIR`. |
| `LOG_TO_FILE=tee` | Write the file and mirror output to stdout/stderr. |
| `LOG_MIRROR_STDOUT=true` | Mirror file output to stdout/stderr. |
| `LOG_ROTATE` / `logging.rotate` | Enable application-managed file rotation. |
| `LOG_ROTATE_SIZE` | Rotate at this size; default `50m`. |
| `LOG_ROTATE_LIMIT` | Total active plus rotated files to keep; default `3`. |
| `LOG_ROTATE_FREQUENCY` | Optional `daily` or `hourly` rotation. |

The Docker Compose service enables application rotation and stdout mirroring by
default. Its application log volume and Docker's stdout log driver are separate
outputs with separate retention settings. If an external collector is used,
choose stdout or the file output and configure that collector outside
Disclaude.

Use the application's rotation as the owner of its file log; do not deploy a
separate cleanup service to compensate for unbounded application logs. Avoid
running a second host rotation rule on the same file. To inspect recent
container output:

```sh
docker compose logs --tail=50 service
```

For macOS launchd logs, use `npm run --prefix "$(npm root -g)/disclaude" launchd:logs`.
