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

- **stdout**: `~/Library/Logs/disclaude/disclaude-stdout.log` (all structured JSON logs)
- **stderr**: `~/Library/Logs/disclaude/disclaude-stderr.log` (typically empty)

Log format is one JSON object per line with fields: `level`, `time`, `context`, `msg`, plus arbitrary data. **Note**: Some non-JSON lines (e.g., `✓ Scheduler started`) from `console.log` may be mixed in — all commands below handle this gracefully.

## Diagnostic Workflow

Run these steps **in order**. Use the Bash tool for every command. After each step, briefly interpret the output before moving on.

**Important**: All `jq` commands use `grep '^{' | jq` to skip non-JSON lines mixed in by `console.log`.

### Step 1: Quick Health Overview

```bash
# Total lines and file size
wc -l ~/Library/Logs/disclaude/disclaude-stdout.log
ls -lh ~/Library/Logs/disclaude/disclaude-stdout.log

# Time range covered
echo "=== First entry ===" && grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | head -1 | jq -r '.time'
echo "=== Last entry ===" && grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | tail -1 | jq -r '.time'

# Error and warning counts (fast: grep -c is ~10x faster than jq for counting)
echo "=== Level distribution ==="
grep -c '"level":"error"' ~/Library/Logs/disclaude/disclaude-stdout.log | xargs -I{} echo "  error: {}"
grep -c '"level":"warn"' ~/Library/Logs/disclaude/disclaude-stdout.log | xargs -I{} echo "  warn: {}"
grep -c '"level":"info"' ~/Library/Logs/disclaude/disclaude-stdout.log | xargs -I{} echo "  info: {}"
grep -c '"level":"debug"' ~/Library/Logs/disclaude/disclaude-stdout.log | xargs -I{} echo "  debug: {}"

# Active contexts (modules)
echo "=== Top contexts ===" && grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -r '.context' | sort | uniq -c | sort -rn | head -15
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
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c "select(.time >= \"$cutoff\")"
```

For `--context`, filter with:
```bash
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c "select(.context == \"$CONTEXT_NAME\")"
```

### Step 3: Error Analysis

```bash
# All errors with context and message
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c 'select(.level == "error") | {time, context, msg, err: .err.message, chatId}'

# Group errors by type (msg)
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -r 'select(.level == "error") | .msg' | sort | uniq -c | sort -rn

# Group errors by context
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -r 'select(.level == "error") | .context' | sort | uniq -c | sort -rn

# Extract unique error messages
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -r 'select(.level == "error") | "\(.context): \(.err.message // .msg)"' | sort -u
```

### Step 4: Warning Patterns

```bash
# Warning frequency over time (grouped by 10-minute buckets)
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -r 'select(.level == "warn") | .time[:16]' | sort | uniq -c

# Top warning messages
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -r 'select(.level == "warn") | .msg' | sort | uniq -c | sort -rn | head -10

# Dead connection detection pattern (common issue)
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c 'select(.msg | test("Dead connection|dead.*connection"; "i")) | {time, context, elapsedMs, timeoutMs}'
```

### Step 5: WebSocket Connection Health

```bash
# Connection state transitions
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c 'select(.context == "WsConnectionManager" or .context == "FeishuChannel") | select(.msg | test("state changed|reconnect|established|closed|ready")) | {time, context, msg, oldState, newState, attempt}'

# Reconnect attempts and outcomes
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c 'select(.msg | test("reconnect"; "i")) | {time, context, msg, attempt, reconnectAttempt}'

# Reconnect success rate
echo "=== Successful reconnects ===" && grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c 'select(.msg | test("Reconnected successfully"))' | wc -l
echo "=== Reconnect attempts ===" && grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c 'select(.msg | test("Scheduling reconnect attempt"))' | wc -l

# Time between reconnects (detect loops)
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -r 'select(.msg | test("Reconnected successfully")) | .time' | head -20
```

### Step 6: Agent / AcpClient Health

```bash
# ACP client errors and reconnects
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c 'select(.context == "AcpClient") | {time, level, msg, reason}'

# ChatAgent errors
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c 'select(.context == "ChatAgent" and .level == "error") | {time, msg, chatId, err: .err.message, messageCount}'

# ACP subprocess spawn events
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c 'select(.msg | test("subprocess spawning")) | {time, context, command, ANTHROPIC_BASE_URL}'

# Timeout patterns
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -c 'select(.msg | test("timeout"; "i")) | {time, context, msg, reason}'

# Queries per chatId (load distribution)
grep '^{' ~/Library/Logs/disclaude/disclaude-stdout.log | jq -r 'select(.context == "ChatAgent") | .chatId // "cli"' | sort | uniq -c | sort -rn | head -10
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
