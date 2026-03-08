# =============================================================================
# Disclaude Dockerfile
# =============================================================================
# Multi-stage build for production-ready Disclaude Feishu bot image.
#
# This is the default Dockerfile for Primary Node.
# For Worker Node, use Dockerfile.worker.
# For MCP Server, use Dockerfile.mcp.
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
# Stage 1: Dependencies (production only)
# -----------------------------------------------------------------------------
FROM docker.m.daocloud.io/library/node:20-alpine AS deps
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
FROM docker.m.daocloud.io/library/node:20-alpine AS builder
WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json package-lock.json ./
COPY packages ./packages

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
FROM docker.m.daocloud.io/library/node:20-alpine AS production
WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    curl \
    ca-certificates \
    procps

# Install GitHub CLI (gh)
RUN apk add --no-cache github-cli

# Install PM2 globally for process management and logging
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g pm2@latest

# Create non-root user for running the application
RUN addgroup -g 1001 disclaude && \
    adduser -D -u 1001 -G disclaude -h /app -s /sbin/nologin disclaude

# Create directories for runtime with proper permissions
RUN mkdir -p /app/workspace /app/logs /app/.claude /app/.claude/backups /app/.claude/debug /app/.pm2 && \
    echo '{}' > /app/.claude.json && \
    chown -R disclaude:disclaude /app

# Copy built artifacts from builder and production dependencies from deps
COPY --from=builder --chown=disclaude:disclaude /app/dist ./dist
COPY --from=deps --chown=disclaude:disclaude /app/node_modules ./node_modules
COPY --from=builder --chown=disclaude:disclaude /app/package.json ./
COPY --from=builder --chown=disclaude:disclaude /app/ecosystem.primary.config.json ./
COPY --from=builder --chown=disclaude:disclaude /app/ecosystem.worker.config.json ./
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
CMD ["pm2-runtime", "start", "ecosystem.primary.config.json"]
