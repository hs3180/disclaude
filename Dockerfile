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
# Run:
#   docker run -v $(pwd)/disclaude.config.yaml:/app/disclaude.config.yaml disclaude:latest
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

# Install dependencies
RUN npm ci --omit=dev && \
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

# Install all dependencies (including devDependencies for building)
RUN npm ci

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
RUN npm install -g pm2@latest

# Copy built artifacts from builder and production dependencies from deps
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy PM2 ecosystem configs for Docker (one for each mode)
COPY --from=builder /app/ecosystem.comm.config.json ./
COPY --from=builder /app/ecosystem.exec.config.json ./

# Copy skills directory if it exists
COPY --from=builder /app/skills ./skills

# Create non-root user for running the application
RUN groupadd -g 1001 disclaude && \
    useradd -r -u 1001 -g disclaude -d /app -s /usr/sbin/nologin -c "Disclaude user" disclaude

# Give disclaude user ownership of /app (needed for SDK config files)
RUN chown -R disclaude:disclaude /app

# Create directories for runtime with proper permissions
RUN mkdir -p /app/workspace /app/logs /app/.claude && \
    chown -R disclaude:disclaude /app/workspace /app/logs /app/.claude

# Set environment variables
ENV NODE_ENV=production

# Health check - check if PM2 process is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD pm2 pid disclaude-docker > /dev/null 2>&1 || exit 1

# Switch to non-root user
USER disclaude

# Default command: run with PM2 for process management and logging
# Logs will be available at:
#   - /app/logs/disclaude-combined.log (pino application logs)
#   - ~/.pm2/logs/ (PM2 stdout/stderr logs)
CMD ["pm2-runtime", "start", "ecosystem.config.docker.cjs"]
