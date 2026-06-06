# Infrastructure-Level Log Forwarding

The application uses [Pino](https://getpino.io/) for structured JSON logging. Since v0.4.0, application-level Elasticsearch transport has been removed in favor of infrastructure-level log forwarding. This approach is more reliable, configurable, and requires zero application code changes.

Pino outputs structured JSON to stdout/stderr, which can be consumed by any log shipper.

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
# docker-compose.yml — add alongside your primary service
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

Alternative to Fluentd, using Filebeat to read container log files:

```yaml
# filebeat.yml
filebeat.inputs:
  - type: log
    paths:
      - /var/lib/docker/containers/*/*.log
    json.keys_under_root: true
    json.message_key log
    processors:
      - decode_json_fields:
          fields: ["log"]
          target: ""
          overwrite_keys: true

output.elasticsearch:
  hosts: ["localhost:9200"]
  index: "disclaude-logs"

setup.ilm.enabled: false
setup.template.name: disclaude-logs
setup.template.pattern: disclaude-logs-*
```

## macOS (launchd): Filebeat

For non-Docker macOS deployments using launchd:

### Step 1: Configure Filebeat

```yaml
# /usr/local/etc/filebeat/filebeat.yml
filebeat.inputs:
  - type: log
    paths:
      - ~/Library/Logs/disclaude/*.log
    json.keys_under_root: true
    json.add_error_key: true

output.elasticsearch:
  hosts: ["localhost:9200"]
  index: "disclaude-logs"

setup.ilm.enabled: false
setup.template.name: disclaude-logs
setup.template.pattern: disclaude-logs-*
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

Expected output format:

```json
{
  "level": 30,
  "time": 1717660800000,
  "pid": 1,
  "hostname": "disclaude-primary",
  "msg": "Server started",
  "module": "primary"
}
```
