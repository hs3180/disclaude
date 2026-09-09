---
name: diagnose-logs
description: "Diagnose disclaude logs from local launchd files or an authorized Elasticsearch backend; analyze errors, warnings, WebSocket health, agent behavior, and correlated sessions. Use for 'diagnose logs', 'check logs', 'debug service', 'service health', 'log analysis', 'ES日志', 'Elasticsearch日志', '查看日志', or '诊断日志'."
argument-hint: "[--last 30m] [--errors] [--ws] [--agent] [--context Name]"
disable-model-invocation: true
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

### Data Minimization (mandatory)

- Treat every log field as potentially sensitive, including `msg`, `err`, `command`, URLs, headers, prompt/message text, email addresses, user IDs, chat IDs, IPs, model metadata, and correlation IDs.
- Default execution mode is **metadata-only**: emit counts, timestamps, fixed field names, allow-listed enum values, and short one-way identifiers only when correlation is required. Do not print log documents or extracted free-text values to the agent context.
- Before any query, define an explicit `_source` allowlist containing only the fields needed for the current metric. Never retrieve `_source: *`, message bodies, stack traces, headers, environment objects, or request/response payloads.
- Prefer server-side aggregation (`_count`, `terms`, `date_histogram`, `cardinality`, and bounded `top_hits` containing only safe scalar fields) so raw documents do not cross the query boundary. Use `track_total_hits: false` unless an exact count is required.
- Normalize free text into a fixed category before output (for example, `timeout`, `auth_failure`, `connection_closed`, `other`). Do not output the original text. When correlation is required, replace identifiers with a salted one-way hash scoped to the current diagnostic run; never expose raw identifiers or raw prefixes.
- Use a restricted temporary file only when streaming is unavoidable; set restrictive permissions, avoid shell history, delete it immediately after aggregation, and do not read it back wholesale. Do not take screenshots or save command output containing log data.
- Keep tool output bounded: aggregate in the command, then return at most the requested summary. Never use `tee`, `set -x`, `env`, `printenv`, `ps eww`, or debugging modes that can expose environment values.

### Safe execution preflight

Before Step 1 or any ES query, establish the following in the working shell:

```bash
set +x
umask 077
export HISTCONTROL=ignorespace
# Never print the environment or authenticated command arguments.
```

If a command unexpectedly emits a secret or raw user content, stop immediately, do not quote or copy the value, remove any temporary artifact, and report only: `敏感信息暴露，诊断已停止；请轮换凭据并重试。`

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
  | jq -r '.[] | [.index, ."docs.count"] | @tsv' | head -50
```

The snippet is illustrative only: adapt it to the runtime's secret-safe authentication helper before execution. Never replace `${ES_API_KEY}`, `${ES_USERNAME}`, or `${ES_PASSWORD}` with literal credentials, and never enable `set -x` around it.

If the endpoint returns `401`, stop and request a temporary read-only username/password or API key. If it returns `403`, stop and report the missing permission. Do not try credential guessing, scan other hosts, or use credentials found in unrelated files. If TLS is enabled, use `https://` and the configured CA; never disable certificate verification merely to make a query work.

### ES Query and Session Correlation

After the index is identified, inspect mappings before choosing fields:

```bash
curl -fsS "${ES_AUTH[@]}" "$ES_BASE/${ES_INDEX:?set ES_INDEX}/_mapping" \
  | jq -r 'paths(scalars) as $p | ($p[-1] | tostring) as $k | select($k | test("password|token|secret|authorization|api[_-]?key|message|prompt|content|url|email|ip|chat|user|request|response"; "i") | not) | ($p | map(tostring) | join("."))' | head -100
```

Use the timestamp field actually present in the mapping (`time`, `@timestamp`, or an equivalent), and use `search_after` or a point-in-time search for large result sets. Start with a small `size` (for example, 10) and `_source` filtering. Prefer correlation keys in this order: explicit `sessionId`/`conversationId`, then `chatId` plus a bounded time window, then event/request IDs. Never infer a complete session from message previews alone; report the coverage limitation.

Example bounded query (adapt field names after mapping inspection):

```bash
curl -fsS "${ES_AUTH[@]}" -H 'Content-Type: application/json' \
  -X POST "$ES_BASE/${ES_INDEX:?set ES_INDEX}/_search" -d @- <<'JSON' \
  | jq -c '.hits.hits[] | {time: (._source.time // ._source."@timestamp"), context: ._source.context, level: ._source.level}'
{
  "size": 10,
  "track_total_hits": false,
  "sort": [{"time": "asc"}, {"_id": "asc"}],
  "_source": ["time", "@timestamp", "level", "context"],
  "query": {"bool": {"filter": [
    {"range": {"time": {"gte": "now-30m"}}}
  ]}}
}
JSON
```

For session analysis, group only documents sharing the chosen correlation key, sort by event time, detect gaps and missing roles, and distinguish event logs from actual user/assistant message content. Replace correlation values with salted, run-scoped hashes before output. Keep raw ES responses in memory or a restricted temporary location only as long as needed; do not include raw messages, credentials, headers, or personal identifiers in the report.

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
echo "=== First entry ===" && grep '^{' /tmp/disclaude-stdout.log | head -1 | jq -r 'if (.time|type)=="string" then .time else "present" end'
echo "=== Last entry ===" && grep '^{' /tmp/disclaude-stdout.log | tail -1 | jq -r 'if (.time|type)=="string" then .time else "present" end'

# Error and warning counts (fast: grep -c is ~10x faster than jq for counting)
echo "=== Level distribution ==="
grep -c '"level":"error"' /tmp/disclaude-stdout.log | xargs -I{} echo "  error: {}"
grep -c '"level":"warn"' /tmp/disclaude-stdout.log | xargs -I{} echo "  warn: {}"
grep -c '"level":"info"' /tmp/disclaude-stdout.log | xargs -I{} echo "  info: {}"
grep -c '"level":"debug"' /tmp/disclaude-stdout.log | xargs -I{} echo "  debug: {}"

# Active contexts (modules)
echo "=== Top contexts ===" && grep '^{' /tmp/disclaude-stdout.log | jq -r '.context // "unknown"' | sed -E 's/[^A-Za-z0-9_.:-]/_/g' | sort | uniq -c | sort -rn | head -15
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

For `--last`, compute the cutoff timestamp. Run the remaining workflow in the same shell so the filter variables remain available:
```bash
cutoff=$(date -u -v-${MINUTES}M +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || python3 -c "import datetime; print((datetime.datetime.utcnow() - datetime.timedelta(minutes=${MINUTES})).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
```

For `--context`, set the requested context name:
```bash
CONTEXT_NAME='requested-context'
```

Every aggregate in Steps 3–6 must apply both optional filters inside its `jq` program before selecting its metric. Use this predicate (with the metric appended after the final pipe); never print the filtered records themselves:
```bash
grep '^{' /tmp/disclaude-stdout.log \
  | jq -r --arg cutoff "${cutoff:-}" --arg context "${CONTEXT_NAME:-}" \
      'select(($cutoff == "" or ((.time // "") >= $cutoff)) and ($context == "" or .context == $context)) | "entry"' \
  | wc -l
```

The commands below show their metric selectors without repeating this predicate. When either filter is present, combine the predicate and metric selector in the same `jq` invocation; a report generated without doing so is invalid.

### Step 3: Error Analysis

```bash
# Group errors by safe category, never by the original message.
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "error") | ((.msg // "") + " " + (.err.type // "")) | if test("auth|401|403|credential"; "i") then "auth_failure" elif test("timeout"; "i") then "timeout" elif test("connect|socket|network"; "i") then "connection_failure" else "other" end' | sort | uniq -c | sort -rn

# Group errors by context
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "error") | .context' | sort | uniq -c | sort -rn

# Extract only a bounded safe category summary; do not extract unique messages.
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "error") | (.context // "unknown")' | sed -E 's/[^A-Za-z0-9_.:-]/_/g' | sort | uniq -c | sort -rn | head -20
```

### Step 4: Warning Patterns

```bash
# Warning frequency over time (grouped by 10-minute buckets)
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "warn") | .time[:16]' | sort | uniq -c

# Top warning categories
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "warn") | ((.msg // "") + " " + (.err.type // "")) | if test("timeout"; "i") then "timeout" elif test("connect|socket|network"; "i") then "connection_failure" elif test("deprecated|deprecat"; "i") then "deprecated" else "other" end' | sort | uniq -c | sort -rn | head -10

# Dead connection detection pattern (common issue)
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select((.msg // "") | test("Dead connection|dead.*connection"; "i")) | "dead_connection"' | wc -l
```

### Step 5: WebSocket Connection Health

```bash
# Connection state transitions
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select((.context == "WsConnectionManager" or .context == "FeishuChannel") and ((.msg // "") | test("state changed|reconnect|established|closed|ready"))) | (.msg // "") | if test("reconnect"; "i") then "reconnect" elif test("closed"; "i") then "closed" elif test("ready|established"; "i") then "connected" else "state_change" end' | sort | uniq -c

# Reconnect attempts and outcomes
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select((.msg // "") | test("reconnect"; "i")) | "reconnect_event"' | sort | uniq -c

# Reconnect success rate
echo "=== Successful reconnects ===" && grep '^{' /tmp/disclaude-stdout.log | jq -r 'select((.msg // "") | test("Reconnected successfully")) | "success"' | wc -l
echo "=== Reconnect attempts ===" && grep '^{' /tmp/disclaude-stdout.log | jq -r 'select((.msg // "") | test("Scheduling reconnect attempt")) | "attempt"' | wc -l

# Time between reconnects (detect loops)
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select((.msg // "") | test("Reconnected successfully")) | .time[:16]' | head -20
```

### Step 6: Agent Health

```bash
# ChatAgent errors
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.context == "ChatAgent" and .level == "error") | "chatagent_error"' | wc -l

# SDK subprocess spawn events
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select((.msg // "") | test("subprocess spawning")) | "subprocess_spawn"' | wc -l

# Timeout patterns
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select((.msg // "") | test("timeout"; "i")) | "timeout"' | wc -l

# Queries per chatId (load distribution)
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.context == "ChatAgent") | if .chatId then "chat_present" else "cli_or_missing" end' | sort | uniq -c
```

### Step 7: Synthesize Diagnosis

After collecting data, produce a structured report. The report may contain only aggregate counts, bounded time buckets, safe categories, and salted, run-scoped correlation hashes:

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
Affected chats: {list of salted, run-scoped chat correlation hashes}
Root cause hint: [e.g., "GLM proxy not responding within timeout"]

### Recommendations

1. [Actionable fix]
2. [Actionable fix]
```

## Efficiency Tips

- Prefer `jq` with `select()` filters over piping through `grep` — it's faster and handles JSON properly.
- Use `tail -N | jq` instead of `jq ... file` when you only need recent lines from large files.
- For quick counts, `grep -c '"level":"error"'` is faster than `jq`.
- Use `jq -r` only for allow-listed scalar fields or fixed categories; never extract free-text log fields.
- Always pipe large outputs through `head` or `tail` to avoid flooding context.

## DO NOT

- Do NOT read the full log file with Read tool — use Bash + jq/grep/tail for efficiency.
- Do NOT dump raw JSON at the user — always summarize with `uniq -c | sort -rn`.
- Do NOT skip Step 7 — the synthesis is the most valuable output.
- Do NOT print raw `msg`, `err`, `command`, URLs, headers, prompt/message content, IDs, IPs, or environment-derived values.
- Do NOT use raw log excerpts to justify a finding; cite only counts, time buckets, safe categories, and salted, run-scoped correlation hashes.
