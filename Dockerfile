# =============================================================================
# Disclaude Dockerfile - Primary Node
# =============================================================================
# Multi-stage build for production-ready Disclaude Primary Node image.
#
# The container connects to Chrome on the host via CDP (Chrome DevTools Protocol).
# Start Chrome CDP on host first: ./scripts/start-playwright-cdp.sh
#
# Build:
#   docker build -t disclaude:primary .
#
# Run:
#   docker run -v $(pwd)/disclaude.config.yaml:/app/disclaude.config.yaml disclaude:primary
#
# For production deployment with worker node, use docker-compose.yml.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies
# -----------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json package-lock.json ./

# Configure npm mirror and install dependencies
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --omit=dev && \
    npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 2: Builder
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

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
FROM node:20-alpine AS production
WORKDIR /app

# Install runtime dependencies
# - bash: required by some npm packages
# - curl: for health checks and downloads
# - procps: for process management (pgrep)
# - chromium dependencies: for Playwright MCP integration
RUN apk add --no-cache \
    bash \
    curl \
    procps \
    nss \
    nspr \
    atk \
    at-spi2-core \
    cups-libs \
    libdrm \
    dbus-libs \
    libxkbcommon \
    libxcomposite \
    libxdamage \
    libxfixes \
    libxrandr \
    mesa-gl \
    alsa-lib

# Install GitHub CLI (gh)
RUN apk add --no-cache github-cli

# Install PM2 globally for process management and logging
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g pm2@latest

# Create non-root user for running the application
RUN addgroup -g 1001 -S disclaude && \
    adduser -S -D -H -u 1001 -h /app -s /sbin/nologin -G disclaude -g disclaude disclaude

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
# Logs will be available at:
#   - /app/logs/disclaude-combined.log (pino application logs)
#   - ~/.pm2/logs/ (PM2 stdout/stderr logs)
CMD ["pm2-runtime", "start", "ecosystem.primary.config.json"]
