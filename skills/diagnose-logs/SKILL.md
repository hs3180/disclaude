---
name: diagnose-logs
description: "Diagnose disclaude logs from local launchd files or an authorized Elasticsearch backend; analyze errors, warnings, WebSocket health, agent behavior, and correlated sessions. Use for 'diagnose logs', 'check logs', 'debug service', 'service health', 'log analysis', 'ES日志', 'Elasticsearch日志', '查看日志', or '诊断日志'."
allowed-tools: Bash, Read, Grep, Glob
---

# Log Diagnostics

Diagnose the disclaude launchd service by analyzing pino JSON logs.

## Log Locations

- **stdout**: `/tmp/disclaude-stdout.log` (all structured JSON logs)
- **stderr**: `/tmp/disclaude-stderr.log` (typically empty)

## Elasticsearch Source (optional)

Use Elasticsearch only when the user requests it and an authorized, read-only connection is available. The application forwards structured Pino logs through infrastructure such as Filebeat; do not assume the ES index name or that every document contains a complete conversation.

Configuration is read from environment variables and must never be printed:

- `ES_HOST` (default only when explicitly confirmed; do not guess a remote host)
- `ES_PORT` (default `9200`)
- `ES_USERNAME` and `ES_PASSWORD` for Basic authentication, or `ES_API_KEY` for API-key authentication
- `ES_INDEX` / `ELASTICSEARCH_INDEX` as an optional index pattern
- `ES_CA_CERT` or `ES_INSECURE=true` only when the deployment requires custom TLS handling

### Credential Safety (mandatory)

- Never put a real username, password, API key, token, certificate, or `Authorization` header in this Skill, a command example, a task record, a report, or chat output.
- Obtain credentials only through the runtime environment or an approved secret manager. Do not search unrelated files for credentials or echo them for debugging.
- Disable shell tracing (`set +x`) before constructing authenticated commands. Do not interpolate secrets into URLs, query strings, logs, screenshots, or error reports.
- Treat command arguments as potentially observable through process listings. Prefer the deployment's secure stdin/config-file mechanism for authenticated clients; if the shown shell snippet must be used, redact all command output and never copy credentials into the script itself.
- Before saving or sending any diagnostic artifact, scan it for secret-shaped values and remove them. If a secret is exposed, stop, report only that exposure occurred, and request rotation.

Before retrieving log documents, perform these read-only checks with `curl` and `jq`, suppressing credentials and response bodies that may contain user content:

```bash
ES_BASE="http://${ES_HOST:?set ES_HOST}:${ES_PORT:-9200}"
# Credentials must already be supplied by the runtime secret mechanism.
# Do not replace these variable references with literal values.
ES_AUTH=()
if [ -n "${ES_API_KEY:-}" ]; then
  ES_AUTH=(-H "Authorization: ApiKey ${ES_API_KEY}")
elif [ -n "${ES_USERNAME:-}" ] && [ -n "${ES_PASSWORD:-}" ]; then
  ES_AUTH=(-u "${ES_USERNAME}:${ES_PASSWORD}")
else
  echo "No ES credentials configured" >&2; exit 2
fi

# Connectivity/authentication only; do not print the response body.
curl -fsS -o /dev/null -w 'ES HTTP %{http_code}\n' "${ES_AUTH[@]}" "$ES_BASE/"

# Discover indices and mappings, returning names/types only.
curl -fsS "${ES_AUTH[@]}" "$ES_BASE/_cat/indices?format=json&h=index,docs.count,store.size" \
  | jq -r '.[] | [.index, ."docs.count", ."store.size"] | @tsv'
```

The snippet is illustrative only: adapt it to the runtime's secret-safe authentication helper before execution. Never replace `${ES_API_KEY}`, `${ES_USERNAME}`, or `${ES_PASSWORD}` with literal credentials, and never enable `set -x` around it.

If the endpoint returns `401`, stop and request a temporary read-only username/password or API key. If it returns `403`, stop and report the missing permission. Do not try credential guessing, scan other hosts, or use credentials found in unrelated files. If TLS is enabled, use `https://` and the configured CA; never disable certificate verification merely to make a query work.

### ES Query and Session Correlation

After the index is identified, inspect mappings before choosing fields:

```bash
curl -fsS "${ES_AUTH[@]}" "$ES_BASE/${ES_INDEX:?set ES_INDEX}/_mapping" \
  | jq 'walk(if type == "object" then with_entries(select(.key | test("password|token|secret|authorization|api[_-]?key"; "i") | not)) else . end)'
```

Use the timestamp field actually present in the mapping (`time`, `@timestamp`, or an equivalent), and use `search_after` or a point-in-time search for large result sets. Start with a small `size` (for example, 10) and `_source` filtering. Prefer correlation keys in this order: explicit `sessionId`/`conversationId`, then `chatId` plus a bounded time window, then event/request IDs. Never infer a complete session from message previews alone; report the coverage limitation.

Example bounded query (adapt field names after mapping inspection):

```bash
curl -fsS "${ES_AUTH[@]}" -H 'Content-Type: application/json' \
  -X POST "$ES_BASE/${ES_INDEX:?set ES_INDEX}/_search" -d @- <<'JSON' \
| jq -c '.hits.hits[] | {id: ._id, source: {time: (._source.time // ._source."@timestamp"), context: ._source.context, msg: ._source.msg, chatId: ._source.chatId, sessionId: ._source.sessionId}}'
{
  "size": 10,
  "track_total_hits": false,
  "sort": [{"time": "asc"}, {"_id": "asc"}],
  "_source": ["time", "@timestamp", "context", "msg", "chatId", "sessionId", "conversationId", "requestId"],
  "query": {"bool": {"filter": [
    {"range": {"time": {"gte": "now-30m"}}}
  ]}}
}
JSON
```

For session analysis, group only documents sharing the chosen correlation key, sort by event time, detect gaps and missing roles, and distinguish event logs from actual user/assistant message content. Keep raw ES responses in memory or a restricted temporary location only as long as needed; do not include raw messages, credentials, headers, or personal identifiers in the report.

### Source Selection

| Request | Source |
|--------|--------|
| No source specified and local log exists | Local launchd log |
| Historical logs, index search, or explicit ES request | Authorized ES backend |
| ES requested but credentials/index are unavailable | Report the exact blocker; do not silently substitute local logs |

Apply the same error, warning, WebSocket, and agent analyses below to normalized ES records. State the source, index pattern, time range, document count, and whether the data represents complete sessions or log events.

Log format is one JSON object per line with fields: `level`, `time`, `context`, `msg`, plus arbitrary data. **Note**: Some non-JSON lines (e.g., `✓ Scheduler started`) from `console.log` may be mixed in — all commands below handle this gracefully.

## Diagnostic Workflow

Run these steps **in order**. Use the Bash tool for every command. After each step, briefly interpret the output before moving on.

**Important**: All `jq` commands use `grep '^{' | jq` to skip non-JSON lines mixed in by `console.log`.

### Step 1: Quick Health Overview

```bash
# Total lines and file size
wc -l /tmp/disclaude-stdout.log
ls -lh /tmp/disclaude-stdout.log

# Time range covered
echo "=== First entry ===" && grep '^{' /tmp/disclaude-stdout.log | head -1 | jq -r '.time'
echo "=== Last entry ===" && grep '^{' /tmp/disclaude-stdout.log | tail -1 | jq -r '.time'

# Error and warning counts (fast: grep -c is ~10x faster than jq for counting)
echo "=== Level distribution ==="
grep -c '"level":"error"' /tmp/disclaude-stdout.log | xargs -I{} echo "  error: {}"
grep -c '"level":"warn"' /tmp/disclaude-stdout.log | xargs -I{} echo "  warn: {}"
grep -c '"level":"info"' /tmp/disclaude-stdout.log | xargs -I{} echo "  info: {}"
grep -c '"level":"debug"' /tmp/disclaude-stdout.log | xargs -I{} echo "  debug: {}"

# Active contexts (modules)
echo "=== Top contexts ===" && grep '^{' /tmp/disclaude-stdout.log | jq -r '.context' | sort | uniq -c | sort -rn | head -15
```

### Step 2: Parse Arguments

Check `$ARGUMENTS` for filters:

| Argument | Action |
|----------|--------|
| (empty) | Full diagnostic (all steps) |
| `--last 30m` | Only analyze last 30 minutes of logs |
| `--errors` | Jump to Step 3 (errors only) |
| `--ws` | Jump to Step 5 (WebSocket health) |
| `--agent` | Jump to Step 6 (agent health) |
| `--context Name` | Filter to a specific context/module |

For `--last`, compute the cutoff timestamp:
```bash
cutoff=$(date -u -v-${MINUTES}M +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || python3 -c "import datetime; print((datetime.datetime.utcnow() - datetime.timedelta(minutes=${MINUTES})).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
```

Then pipe all subsequent commands through:
```bash
grep '^{' /tmp/disclaude-stdout.log | jq -c "select(.time >= \"$cutoff\")"
```

For `--context`, filter with:
```bash
grep '^{' /tmp/disclaude-stdout.log | jq -c "select(.context == \"$CONTEXT_NAME\")"
```

### Step 3: Error Analysis

```bash
# All errors with context and message
grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.level == "error") | {time, context, msg, err: .err.message, chatId}'

# Group errors by type (msg)
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "error") | .msg' | sort | uniq -c | sort -rn

# Group errors by context
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "error") | .context' | sort | uniq -c | sort -rn

# Extract unique error messages
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "error") | "\(.context): \(.err.message // .msg)"' | sort -u
```

### Step 4: Warning Patterns

```bash
# Warning frequency over time (grouped by 10-minute buckets)
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "warn") | .time[:16]' | sort | uniq -c

# Top warning messages
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "warn") | .msg' | sort | uniq -c | sort -rn | head -10

# Dead connection detection pattern (common issue)
grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.msg | test("Dead connection|dead.*connection"; "i")) | {time, context, elapsedMs, timeoutMs}'
```

### Step 5: WebSocket Connection Health

```bash
# Connection state transitions
grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.context == "WsConnectionManager" or .context == "FeishuChannel") | select(.msg | test("state changed|reconnect|established|closed|ready")) | {time, context, msg, oldState, newState, attempt}'

# Reconnect attempts and outcomes
grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.msg | test("reconnect"; "i")) | {time, context, msg, attempt, reconnectAttempt}'

# Reconnect success rate
echo "=== Successful reconnects ===" && grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.msg | test("Reconnected successfully"))' | wc -l
echo "=== Reconnect attempts ===" && grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.msg | test("Scheduling reconnect attempt"))' | wc -l

# Time between reconnects (detect loops)
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.msg | test("Reconnected successfully")) | .time' | head -20
```

### Step 6: Agent Health

```bash
# ChatAgent errors
grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.context == "ChatAgent" and .level == "error") | {time, msg, chatId, err: .err.message, messageCount}'

# SDK subprocess spawn events
grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.msg | test("subprocess spawning")) | {time, context, command, ANTHROPIC_BASE_URL}'

# Timeout patterns
grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.msg | test("timeout"; "i")) | {time, context, msg, reason}'

# Queries per chatId (load distribution)
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.context == "ChatAgent") | .chatId // "cli"' | sort | uniq -c | sort -rn | head -10
```

### Step 7: Synthesize Diagnosis

After collecting data, produce a structured report:

```
## Log Diagnosis Report

### Service Health: [HEALTHY | DEGRADED | UNHEALTHY]

**Time range**: {first} to {last}
**Total entries**: {count}
**Errors**: {count} | **Warnings**: {count}

### Key Findings

1. [Most impactful issue]
2. [Second issue]
3. [Third issue]

### [If WebSocket issues found]
**WebSocket**: {reconnect count} reconnects in {timespan}, {success rate}% success rate.
Pattern: [describe — e.g., "Dead connection every ~3 minutes due to 130s idle timeout"]

### [If Agent issues found]
**ChatAgent**: {count} errors, {count} timeouts.
Affected chats: {list of chatId prefixes}
Root cause hint: [e.g., "GLM proxy not responding within timeout"]

### Recommendations

1. [Actionable fix]
2. [Actionable fix]
```

## Efficiency Tips

- Prefer `jq` with `select()` filters over piping through `grep` — it's faster and handles JSON properly.
- Use `tail -N | jq` instead of `jq ... file` when you only need recent lines from large files.
- For quick counts, `grep -c '"level":"error"'` is faster than `jq`.
- Use `jq -r` to extract raw strings when you only need one field.
- Always pipe large outputs through `head` or `tail` to avoid flooding context.

## DO NOT

- Do NOT read the full log file with Read tool — use Bash + jq/grep/tail for efficiency.
- Do NOT dump raw JSON at the user — always summarize with `uniq -c | sort -rn`.
- Do NOT skip Step 7 — the synthesis is the most valuable output.
