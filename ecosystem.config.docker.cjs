/**
 * PM2 Configuration for Docker Environment
 *
 * This configuration is specifically designed for running Disclaude
 * inside Docker containers using PM2 for process management.
 *
 * Benefits:
 * - Centralized logging via `pm2 logs`
 * - Process monitoring via `pm2 status`
 * - `/restart` command support in Feishu bot
 * - Automatic restart on crashes
 *
 * Usage in docker-compose.yml:
 *   command: ["pm2-runtime", "start", "ecosystem.config.docker.cjs", "--", "comm"]
 *   or
 *   command: ["pm2-runtime", "start", "ecosystem.config.docker.cjs", "--", "exec"]
 */

const mode = process.argv[2] || 'comm';

const configs = {
  comm: {
    name: 'disclaude-docker',
    script: 'dist/cli-entry.js',
    args: 'start --mode comm',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    // PM2 log configuration
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '/app/logs/pm2-error.log',
    out_file: '/app/logs/pm2-out.log',
    merge_logs: true,
    // Environment
    env: {
      NODE_ENV: 'production',
    },
  },
  exec: {
    name: 'disclaude-docker',
    script: 'dist/cli-entry.js',
    args: 'start --mode exec --comm-url ws://localhost:3001',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    // PM2 log configuration
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '/app/logs/pm2-error.log',
    out_file: '/app/logs/pm2-out.log',
    merge_logs: true,
    // Environment
    env: {
      NODE_ENV: 'production',
    },
  },
};

module.exports = {
  apps: [configs[mode] || configs.comm],
};
