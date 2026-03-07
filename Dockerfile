# =============================================================================
# Disclaude Dockerfile
# =============================================================================
# Multi-stage build for production-ready Disclaude Feishu bot image.
#
# The container connects to Chrome on the host via CDP (Chrome DevTools Protocol).
# Start Chrome CDP on host first: ./scripts/start-playwright-cdp.sh
#
# Build:
#   docker build -t disclaude:latest .
#
# Run Modes:
#   This image supports two deployment modes:
#
#   1. Primary Node (default) - Handles Feishu WebSocket + Agent execution
#      docker run -v $(pwd)/disclaude.config.yaml:/app/disclaude.config.yaml disclaude:latest
#
#   2. Worker Node - Handles Pilot/Agent task execution only
#      docker run -v $(pwd)/disclaude.config.yaml:/app/disclaude.config.yaml \
#        -e COMM_URL=ws://primary:3001 \
#        disclaude:latest pm2-runtime start ecosystem.worker.config.json
#
# For production deployment with both nodes, use docker-compose.yml.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies
# -----------------------------------------------------------------------------
FROM docker.m.daocloud.io/library/node:18-bookworm-slim AS deps
WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json ./

# Configure npm mirror and install dependencies
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --omit=dev && \
    npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 2: Builder
# -----------------------------------------------------------------------------
FROM docker.m.daocloud.io/library/node:18-bookworm-slim AS builder
WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json ./

# Configure npm mirror and install all dependencies (including devDependencies for building)
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci

# Copy source code
COPY . .

# Build the project
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: Production Image
# -----------------------------------------------------------------------------
FROM docker.m.daocloud.io/library/node:18-bookworm-slim AS production
WORKDIR /app

# Install runtime dependencies and Playwright library dependencies
# Note: Browser binaries are NOT installed here - container uses CDP to connect
# to Chrome running on the host machine
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Procps for health check (pgrep)
    procps \
    # Curl for downloading GitHub CLI
    curl \
    # CA certificates for HTTPS connections
    ca-certificates \
    # Playwright library dependencies (for @playwright/mcp package)
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Install PM2 globally for process management and logging
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g pm2@latest

# Create non-root user for running the application
RUN groupadd -g 1001 disclaude && \
    useradd -r -u 1001 -g disclaude -d /app -s /usr/sbin/nologin -c "Disclaude user" disclaude

# Create directories for runtime with proper permissions
# Also create .claude.json with empty JSON object to avoid SDK config parse errors
# SDK requires this file to be valid JSON or it will crash on startup
RUN mkdir -p /app/workspace /app/logs /app/.claude /app/.claude/backups /app/.claude/debug /app/.pm2 && \
    echo '{}' > /app/.claude.json && \
    chown -R disclaude:disclaude /app

# Copy built artifacts from builder and production dependencies from deps
# Use --chown to set ownership during copy, avoiding slow recursive chown of node_modules
COPY --from=builder --chown=disclaude:disclaude /app/dist ./dist
COPY --from=deps --chown=disclaude:disclaude /app/node_modules ./node_modules
COPY --from=builder --chown=disclaude:disclaude /app/package.json ./

# Copy PM2 ecosystem configs for Docker (one for each mode)
COPY --from=builder --chown=disclaude:disclaude /app/ecosystem.primary.config.json ./
COPY --from=builder --chown=disclaude:disclaude /app/ecosystem.worker.config.json ./

# Copy skills directory if it exists
COPY --from=builder --chown=disclaude:disclaude /app/skills ./skills

# Set environment variables
ENV NODE_ENV=production
ENV DISCLAUDE_MODE=primary

# Health check - check if PM2 process is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD pm2 pid disclaude-primary > /dev/null 2>&1 || exit 1

# Switch to non-root user
USER disclaude

# Default command: run Primary Node with PM2
#
# This image supports two modes:
#   - primary: Primary Node (Feishu WebSocket + Agent handler) - DEFAULT
#   - worker: Worker Node (Agent handler only, connects to Primary)
#
# Usage examples:
#
#   # Run with default primary mode (recommended for most users)
#   docker run -v $(pwd)/disclaude.config.yaml:/app/disclaude.config.yaml disclaude:latest
#
#   # Run worker mode (for distributed deployment)
#   docker run -v $(pwd)/disclaude.config.yaml:/app/disclaude.config.yaml \
#     -e COMM_URL=ws://primary:3001 \
#     disclaude:latest pm2-runtime start ecosystem.worker.config.json
#
# For full two-node deployment, use docker-compose.yml which configures both modes.
#
# Logs will be available at:
#   - /app/logs/disclaude-combined.log (pino application logs)
#   - ~/.pm2/logs/ (PM2 stdout/stderr logs)
CMD ["pm2-runtime", "start", "ecosystem.primary.config.json"]
