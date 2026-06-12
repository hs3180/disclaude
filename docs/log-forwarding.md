# Infrastructure-Level Log Forwarding

The application uses [Pino](https://getpino.io/) for structured JSON logging. Since v0.4.0, application-level Elasticsearch transport has been removed in favor of infrastructure-level log forwarding. This approach is more reliable, configurable, and requires zero application code changes.

Pino outputs structured JSON to stdout/stderr, which can be consumed by any log shipper.
With `LOG_TO_FILE=true`, Pino also writes to a log file that Filebeat can read directly.

## Docker: Fluentd via Logging Driver

### Step 1: Configure Docker Compose

```yaml
# docker-compose.yml
services:
  primary:
    # ... existing config ...
    logging:
      driver: fluentd
      options:
        fluentd-address: "localhost:24224"
        tag: disclaude
```

### Step 2: Fluentd Configuration

```conf
# fluentd/conf/fluent.conf

# Accept logs from Docker logging driver
# NOTE: In production, restrict bind to a specific interface (e.g., 127.0.0.1)
#       or use Docker network isolation instead of 0.0.0.0.
<source>
  @type forward
  port 24224
  bind 0.0.0.0
</source>

# Parse Pino JSON logs
<filter disclaude.**>
  @type parser
  key_name log
  reserve_data true
  <parse>
    @type json
    time_key time
    time_format %iso8601
  </parse>
</filter>

# Forward to Elasticsearch
<match disclaude.**>
  @type elasticsearch
  host elasticsearch
  port 9200
  logstash_format true
  logstash_prefix disclaude-logs
  include_tag_key true
  tag_key @log_name
  flush_interval 5s
</match>
```

### Step 3: Add Fluentd to Docker Compose (optional sidecar)

```yaml
# docker-compose.yml — add under services: alongside your primary service
services:
  fluentd:
    image: fluent/fluentd:v1.16
    container_name: disclaude-fluentd
    volumes:
      - ./fluentd/conf:/fluentd/etc:ro
    ports:
      - "24224:24224"
    restart: unless-stopped
```

## Docker: Filebeat Sidecar

Filebeat reads Pino JSON log files from a shared Docker named volume (`log_data`) and forwards to Elasticsearch.
Uses host networking — ES connection is fully configured via `.env` variables.

### Step 1: Configure Environment

```bash
# .env
LOG_TO_FILE=true                # Enable file logging for Filebeat to read
ES_HOST=localhost               # Elasticsearch address (any reachable host)
ES_PORT=9200

# Authentication — ONLY set these if your ES requires authentication.
# For local ES without security enabled, leave these commented out.
# ES_USERNAME=elastic
# ES_PASSWORD=your-password
```

### Step 2: Start Filebeat

```bash
# Start with the logging profile
docker compose --profile logging up -d

# Verify Filebeat is running and connected
docker compose logs filebeat --tail=20
```

### Architecture

```
┌──────────────────────┐  Docker volume   ┌──────────────────┐
│  disclaude-primary   │── log_data:/data ──→│   Filebeat       │
│  (Pino → stdout +    │   /logs (shared)   │  (host network)  │
│   file to /data/logs)│                    └───────┬──────────┘
└──────────────────────┘                            │
    host network                                     │
┌──────────────────┐                                │
│  Elasticsearch   │←───────────────────────────────┘
│  (any host:port) │
└──────────────────┘
```

### Configuration Details

The `filebeat.yml` reads `/data/logs/disclaude-combined.log`, parses Pino JSON
natively (`json.keys_under_root`), and forwards to Elasticsearch using env-var
credentials. Index pattern: `disclaude-logs-YYYY.MM.dd` with daily rollover.

ES address is configured via `ES_HOST` / `ES_PORT` in `.env` — works with any
Elasticsearch instance (local Docker, remote server, or cloud-managed).

See `filebeat.yml` in the project root for the full configuration.

### Notes

- **Registry persistence**: Filebeat tracks read positions in a Docker named volume
  (`filebeat_data`). This prevents re-reading all logs after container restarts.
- **Index templates**: Filebeat's auto-managed index template is disabled
  (`setup.template.enabled: false`). Filebeat 8.x generates a template with a
  top-level `data_stream: {}`, which — together with the `disclaude-logs-YYYY.MM.dd`
  index name matching ES's data-stream naming convention — would make ES auto-create
  data streams instead of plain indices. With the template disabled, ES creates plain
  indices (dynamic mappings) and no data streams. To use explicit field mappings,
  create your own plain index template in ES, e.g.
  `PUT _index_template/disclaude-logs` (no `data_stream` key).
- **Network mode**: Filebeat uses `network_mode: host` for maximum compatibility
  (same as primary and playwright services). If you need stricter network isolation,
  replace it with a custom bridge network and expose only the ES port.

## macOS (launchd): Filebeat

For non-Docker macOS deployments using launchd:

### Step 1: Configure Filebeat

```yaml
# /usr/local/etc/filebeat/filebeat.yml
filebeat.inputs:
  - type: log
    paths:
      - /Users/<username>/Library/Logs/disclaude/*.log
    json.keys_under_root: true
    json.add_error_key: true

output.elasticsearch:
  hosts: ["localhost:9200"]
  index: "disclaude-logs-%{+yyyy.MM.dd}"

setup.ilm.enabled: false
# Disable Filebeat's auto-template to avoid data streams (see Configuration Details)
setup.template.enabled: false
```

### Step 2: Start Filebeat

```bash
# Install via Homebrew
brew install elastic/tap/filebeat-full

# Start as launchd service
brew services start filebeat-full

# Verify
filebeat test config -c /usr/local/etc/filebeat/filebeat.yml
filebeat test output -c /usr/local/etc/filebeat/filebeat.yml
```

## Alternative Backends

Since forwarding is infrastructure-level, you can switch backends without touching application code:

- **Loki**: Replace the `<match>` block with `@type loki` (Fluentd) or use `output.loki` (Filebeat)
- **CloudWatch**: Use `@type cloudwatch_logs` (Fluentd) or `output.cloudwatch` (Filebeat)
- **Stdout only**: Keep the default `json-file` driver with rotation (see [log-rotation.md](log-rotation.md))

## Verifying Log Output

Pino outputs structured JSON. Verify logs are flowing:

```bash
# Docker: check container stdout
docker compose logs primary --tail 1 | jq .

# macOS: check log file
tail -1 ~/Library/Logs/disclaude/disclaude-combined.log | jq .
```

Expected output format (production):

```json
{
  "level": "info",
  "time": "2024-06-06T12:00:00.000Z",
  "pid": 1,
  "hostname": "disclaude-primary",
  "msg": "Server started",
  "context": "PrimaryNode"
}
```

> **Note**: In development mode, `level` appears as its numeric value (e.g., `30`) and `time` is an epoch millisecond timestamp. The Filebeat config only handles ISO 8601 timestamps (production mode); if you need to forward development-mode logs, add an epoch layout to the timestamp processor. The `context` field corresponds to the module name passed to `createLogger()`.
