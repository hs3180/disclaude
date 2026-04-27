---
name: diagnose-logs
description: "Diagnose disclaude service logs — analyze errors, warnings, WebSocket health, ACP client issues, and agent behavior from launchd log files. Use when user says keywords like 'diagnose logs', 'check logs', 'debug service', 'what went wrong', 'service health', 'log analysis', '查看日志', '诊断日志'."
argument-hint: "[--last 30m] [--errors] [--ws] [--agent] [--context Name]"
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob
---

# Log Diagnostics

Diagnose the disclaude launchd service by analyzing pino JSON logs.

## Log Locations

- **Combined**: `~/Library/Logs/disclaude/disclaude-combined.log` (all structured JSON logs with pino-roll rotation)
- **Rotated**: `~/Library/Logs/disclaude/disclaude-combined.*.log.gz` (rotated and compressed by pino-roll)

Log format is one JSON object per line with fields: `level`, `time`, `context`, `msg`, plus arbitrary data. **Note**: Some non-JSON lines (e.g., `✓ Scheduler started`) from `console.log` may be mixed in — all commands below handle this gracefully.

Log directory permissions are 0o700 (owner-only) to prevent information leakage.

## Diagnostic Workflow

Run these steps **in order**. Use the Bash tool for every command. After each step, briefly interpret the output before moving on.

**Important**: All `jq` commands use `grep '^{' | jq` to skip non-JSON lines mixed in by `console.log`.

### Step 1: Quick Health Overview

```bash
# Resolve log file path (uses ~/Library/Logs/disclaude/ on launchd, ./logs/ otherwise)
LOG_FILE="${DISCLAUDE_LOG_DIR:-$HOME/Library/Logs/disclaude}/disclaude-combined.log"
echo "Log file: $LOG_FILE"

# Total lines and file size
wc -l "$LOG_FILE"
ls -lh "$LOG_FILE"

# Time range covered
echo "=== First entry ===" && grep '^{' "$LOG_FILE" | head -1 | jq -r '.time'
echo "=== Last entry ===" && grep '^{' "$LOG_FILE" | tail -1 | jq -r '.time'

# Error and warning counts (fast: grep -c is ~10x faster than jq for counting)
echo "=== Level distribution ==="
grep -c '"level":"error"' "$LOG_FILE" | xargs -I{} echo "  error: {}"
grep -c '"level":"warn"' "$LOG_FILE" | xargs -I{} echo "  warn: {}"
grep -c '"level":"info"' "$LOG_FILE" | xargs -I{} echo "  info: {}"
grep -c '"level":"debug"' "$LOG_FILE" | xargs -I{} echo "  debug: {}"

# Active contexts (modules)
echo "=== Top contexts ===" && grep '^{' "$LOG_FILE" | jq -r '.context' | sort | uniq -c | sort -rn | head -15

# Rotated files
ls -lh "${DISCLAUDE_LOG_DIR:-$HOME/Library/Logs/disclaude}/" 2>/dev/null | head -10
```

### Step 2: Parse Arguments

Check `$ARGUMENTS` for filters:

| Argument | Action |
|----------|--------|
| (empty) | Full diagnostic (all steps) |
| `--last 30m` | Only analyze last 30 minutes of logs |
| `--errors` | Jump to Step 3 (errors only) |
| `--ws` | Jump to Step 5 (WebSocket health) |
| `--agent` | Jump to Step 6 (agent/AcpClient health) |
| `--context Name` | Filter to a specific context/module |

For `--last`, compute the cutoff timestamp:
```bash
cutoff=$(date -u -v-${MINUTES}M +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || python3 -c "import datetime; print((datetime.datetime.utcnow() - datetime.timedelta(minutes=${MINUTES})).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
```

Then pipe all subsequent commands through:
```bash
grep '^{' "$LOG_FILE" | jq -c "select(.time >= \"$cutoff\")"
```

For `--context`, filter with:
```bash
grep '^{' "$LOG_FILE" | jq -c "select(.context == \"$CONTEXT_NAME\")"
```

### Step 3: Error Analysis

```bash
# All errors with context and message
grep '^{' "$LOG_FILE" | jq -c 'select(.level == "error") | {time, context, msg, err: .err.message, chatId}'

# Group errors by type (msg)
grep '^{' "$LOG_FILE" | jq -r 'select(.level == "error") | .msg' | sort | uniq -c | sort -rn

# Group errors by context
grep '^{' "$LOG_FILE" | jq -r 'select(.level == "error") | .context' | sort | uniq -c | sort -rn

# Extract unique error messages
grep '^{' "$LOG_FILE" | jq -r 'select(.level == "error") | "\(.context): \(.err.message // .msg)"' | sort -u
```

### Step 4: Warning Patterns

```bash
# Warning frequency over time (grouped by 10-minute buckets)
grep '^{' "$LOG_FILE" | jq -r 'select(.level == "warn") | .time[:16]' | sort | uniq -c

# Top warning messages
grep '^{' "$LOG_FILE" | jq -r 'select(.level == "warn") | .msg' | sort | uniq -c | sort -rn | head -10

# Dead connection detection pattern (common issue)
grep '^{' "$LOG_FILE" | jq -c 'select(.msg | test("Dead connection|dead.*connection"; "i")) | {time, context, elapsedMs, timeoutMs}'
```

### Step 5: WebSocket Connection Health

```bash
# Connection state transitions
grep '^{' "$LOG_FILE" | jq -c 'select(.context == "WsConnectionManager" or .context == "FeishuChannel") | select(.msg | test("state changed|reconnect|established|closed|ready")) | {time, context, msg, oldState, newState, attempt}'

# Reconnect attempts and outcomes
grep '^{' "$LOG_FILE" | jq -c 'select(.msg | test("reconnect"; "i")) | {time, context, msg, attempt, reconnectAttempt}'

# Reconnect success rate
echo "=== Successful reconnects ===" && grep '^{' "$LOG_FILE" | jq -c 'select(.msg | test("Reconnected successfully"))' | wc -l
echo "=== Reconnect attempts ===" && grep '^{' "$LOG_FILE" | jq -c 'select(.msg | test("Scheduling reconnect attempt"))' | wc -l

# Time between reconnects (detect loops)
grep '^{' "$LOG_FILE" | jq -r 'select(.msg | test("Reconnected successfully")) | .time' | head -20
```

### Step 6: Agent / AcpClient Health

```bash
# ACP client errors and reconnects
grep '^{' "$LOG_FILE" | jq -c 'select(.context == "AcpClient") | {time, level, msg, reason}'

# ChatAgent errors
grep '^{' "$LOG_FILE" | jq -c 'select(.context == "ChatAgent" and .level == "error") | {time, msg, chatId, err: .err.message, messageCount}'

# ACP subprocess spawn events
grep '^{' "$LOG_FILE" | jq -c 'select(.msg | test("subprocess spawning")) | {time, context, command, ANTHROPIC_BASE_URL}'

# Timeout patterns
grep '^{' "$LOG_FILE" | jq -c 'select(.msg | test("timeout"; "i")) | {time, context, msg, reason}'

# Queries per chatId (load distribution)
grep '^{' "$LOG_FILE" | jq -r 'select(.context == "ChatAgent") | .chatId // "cli"' | sort | uniq -c | sort -rn | head -10
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

### [If ACP/Agent issues found]
**AcpClient**: {count} timeouts, {count} transport closures.
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
