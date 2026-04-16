# Production Deployment Guide

This guide covers platform-specific deployment for Disclaude.

## Platform Selection

| Platform | Process Manager | TCC Permissions | Recommendation |
|----------|----------------|-----------------|----------------|
| **macOS** | launchd | ✅ Full support | **Recommended for macOS** |
| **Linux** | PM2 | N/A | **Recommended for Linux** |
| **Docker** | N/A (container) | N/A | See [Docker Guide](#docker-deployment) |

> ⚠️ **macOS Users**: Do NOT use PM2 on macOS. PM2 fork mode creates a process chain that breaks macOS TCC (Transparency, Consent, and Control) permissions. This causes microphone, camera, and other protected resources to silently fail with zero-length data. See [Issue #1957](https://github.com/hs3180/disclaude/issues/1957) for details.

---

## macOS Deployment (launchd)

### Why launchd on macOS

macOS TCC tracks the **entire process chain** when evaluating permission requests. Under PM2 fork mode:

```
PM2 (node/PID) → claude → zsh → python/audio-tool
                                        ↑ TCC denied here
```

The PM2 node ancestor lacks TCC permission, causing all descendant processes to be silently blocked. launchd provides a clean process chain:

```
launchd → node → disclaude
           ↑ TCC permission dialog works correctly
```

### Prerequisites

- macOS 10.15+ (Catalina or later)
- Node.js >= 18 installed via Homebrew or nvm
- Disclaude cloned and built (`npm run build`)

### Step 1: Configure plist Templates

Edit the plist templates to match your environment:

```bash
# Primary Node
vim scripts/launchd/com.disclaude.primary.plist.example

# Worker Node (if needed)
vim scripts/launchd/com.disclaude.worker.plist.example
```

Key fields to update:

| Field | Description | Example |
|-------|-------------|---------|
| `ProgramArguments[0]` | Path to Node.js binary | `/opt/homebrew/bin/node` |
| `ProgramArguments[1]` | Path to CLI entry point | `/Users/you/disclaude/packages/primary-node/dist/cli.js` |
| `WorkingDirectory` | Project root | `/Users/you/disclaude` |
| `StandardOutPath` | Stdout log path | `/Users/you/disclaude/logs/launchd-primary-out.log` |
| `StandardErrorPath` | Stderr log path | `/Users/you/disclaude/logs/launchd-primary-err.log` |

### Step 2: Install Services

```bash
# Install and start both primary and worker nodes
npm run launchd:install

# Or install only the primary node
npm run launchd:install:primary
```

The install script will:
1. Generate plist files with correct paths (replacing `/path/to/disclaude`)
2. Copy them to `~/Library/LaunchAgents/`
3. Start the services via `launchctl bootstrap`

### Step 3: Grant TCC Permissions

On first run, macOS may show permission dialogs for:
- **Microphone** (if using audio features)
- **Camera** (if using video features)

Grant these permissions when prompted. The clean `launchd → node` process chain ensures TCC correctly identifies the requesting application.

### Common Commands

```bash
# Check service status
npm run launchd:status

# View logs (last 100 lines)
npm run launchd:logs

# Follow logs (live tail)
npm run launchd:logs:follow

# Restart after code changes
npm run launchd:restart

# Restart only primary node
npm run launchd:restart:primary

# Stop services
npm run launchd:stop

# Start services
npm run launchd:start

# Completely remove services
npm run launchd:uninstall
```

### Troubleshooting

**Service won't start:**
```bash
# Check for errors in the log files
cat logs/launchd-primary-err.log

# Verify the plist is loaded
launchctl list | grep disclaude

# Check plist syntax
plutil -lint ~/Library/LaunchAgents/com.disclaude.primary.plist
```

**Permission denied errors:**
```bash
# Reset TCC permissions (requires logout/login)
tccutil reset Microphone
tccutil reset Camera

# Then restart the service
npm run launchd:restart
```

**Log rotation:** launchd does not handle log rotation. Consider using `logrotate` or adding a cron job:
```bash
# Add to crontab: rotate logs weekly
0 0 * * 0 mv ~/disclaude/logs/launchd-primary-out.log ~/disclaude/logs/launchd-primary-out.log.1
```

---

## Linux Deployment (PM2)

### Prerequisites

- Linux (any modern distribution)
- Node.js >= 18
- PM2 installed globally: `npm install -g pm2`

### Step 1: Configure PM2

```bash
# Copy the example configuration
cp ecosystem.config.example.cjs ecosystem.config.cjs

# Edit with your settings
vim ecosystem.config.cjs
```

### Step 2: Start Services

```bash
# Build and start with PM2
npm run pm2:start

# Enable auto-restart on system reboot
pm2 startup
pm2 save
```

### Common Commands

```bash
npm run pm2:status          # Check status
npm run pm2:logs            # View logs (nostream)
npm run pm2:logs:follow     # Follow logs (live)
npm run pm2:restart         # Restart service
npm run pm2:restart:build   # Build and restart
npm run pm2:stop            # Stop service
npm run pm2:monit           # Monitor dashboard
```

---

## Migrating from PM2 to launchd (macOS)

If you're currently running Disclaude under PM2 on macOS and experiencing TCC-related issues:

### Step 1: Stop PM2

```bash
npm run pm2:stop
npm run pm2:delete
```

### Step 2: Install launchd Services

```bash
npm run launchd:install
```

### Step 3: Verify

```bash
npm run launchd:status
npm run launchd:logs
```

### Step 4: Grant Permissions

When the service starts, macOS will show TCC permission dialogs. Grant microphone/camera permissions as needed.

### Reverting to PM2 (if needed)

```bash
# Uninstall launchd services
npm run launchd:uninstall

# Re-install PM2 services
npm run pm2:start
```

> **Note**: Reverting to PM2 on macOS will re-introduce TCC permission issues for microphone/camera access.

---

## Docker Deployment

Docker containers run in an isolated environment without TCC restrictions, making them suitable for server deployments.

### Using Docker Compose

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

See [docker-compose.yml](../docker-compose.yml) and [Dockerfile.primary](../Dockerfile.primary) for configuration details.

---

## Comparison: launchd vs PM2

| Feature | launchd (macOS) | PM2 (Linux) |
|---------|----------------|-------------|
| **TCC compatible** | ✅ Yes | ❌ No (macOS) |
| **Process chain** | `launchd → node` | `PM2 → node → app` |
| **Auto-restart** | ✅ KeepAlive | ✅ autorestart |
| **Boot startup** | ✅ RunAtLoad | ✅ pm2 startup |
| **Log management** | Basic (file redirect) | Advanced (rotation, clustering) |
| **Cluster mode** | ❌ No | ✅ Yes |
| **Monitoring UI** | ❌ No | ✅ pm2 monit |
| **Zero-downtime reload** | ❌ No | ✅ pm2 reload |
