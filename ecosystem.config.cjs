/**
 * PM2 Ecosystem Configuration for Disclaude
 *
 * This configuration integrates PM2 process management with Pino logging:
 * - PM2 handles process lifecycle (start, stop, restart, monitoring)
 * - Pino handles all logging (formatting, file rotation, streams)
 * - PM2's internal logging is disabled to avoid conflicts
 *
 * Logging Strategy:
 * 1. Application logs → Pino → File rotation (pino-roll) + stdout
 * 2. PM2 stdout/stderr → Pino (already includes application logs)
 * 3. PM2 internal logs → Disabled (use pm2 logs --raw if needed)
 *
 * @see {@link https://pm2.keymetrics.io/docs/usage/application-declaration/}
 */

module.exports = {
  apps: [{
    // ===== Application Identity =====
    name: 'disclaude-feishu',

    // ===== Execution Configuration =====
    script: './dist/cli-entry.js',
    args: 'feishu',
    cwd: '/Users/hs3180/clawd/disclaude',

    // ===== Instance Management =====
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,

    // ===== Memory Management =====
    max_memory_restart: '500M',

    // ===== Environment Variables =====
    env: {
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug',
      LOG_DIR: './logs'
    },
    env_production: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      LOG_DIR: './logs'
    },

    // ===== Logging Configuration =====
    //
    // IMPORTANT: PM2 logging is DISABLED to avoid conflicts with Pino
    //
    // Why disable PM2 logging?
    // 1. Pino already handles all application logging
    // 2. Pino provides file rotation with pino-roll
    // 3. Pino provides structured JSON logs for production
    // 4. Avoids duplicate logs in different formats
    //
    // To view logs:
    // - Application logs: tail -f logs/disclaude-combined.log
    // - Pino pretty print: cat logs/disclaude-combined.log | pino-pretty
    // - PM2 stdout: pm2 logs disclaude-feishu --lines 100 (shows Pino output)
    //

    // Disable PM2 log file management (Pino handles file rotation)
    error_file: null,           // Disable PM2 error log file
    out_file: null,             // Disable PM2 output log file

    // Disable PM2 log timestamps (Pino adds its own timestamps)
    log_date_format: '',

    // Merge logs from multiple instances (if we ever use cluster mode)
    merge_logs: true,

    // Disable PM2 time prefix (Pino adds its own timestamps)
    time: false,

    // ===== Process Management =====
    kill_timeout: 5000,         // Time to wait for graceful shutdown
    wait_ready: false,          // Don't wait for ready signal
    listen_timeout: 3000,       // Timeout for WebSocket connection

    // ===== Advanced Configuration =====
    min_uptime: '10s',          // Minimum uptime before considering app stable
    max_restarts: 10,           // Max restarts within 1 second
    restart_delay: 4000,        // Delay between restarts (ms)

    // ===== Source Map Support =====
    source_map_support: true,

    // ===== Instance Variables =====
    instance_var: 'INSTANCE_ID',

    // ===== Logging Enhancement =====
    //
    // PM2 will still capture stdout/stderr for `pm2 logs` command
    // But it won't write to separate log files
    //
    // Logs flow:
    //   Application → Pino → stdout → PM2 → `pm2 logs`
    //   Application → Pino → pino-roll → logs/disclaude-combined.log
    //
  }],

  /**
   * Deployment configuration (optional)
   * Uncomment and configure if using PM2 deploy
   */
  /*
  deploy: {
    production: {
      user: 'node',
      host: 'server.example.com',
      ref: 'origin/main',
      repo: 'git@github.com:username/disclaude.git',
      path: '/var/www/disclaude',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.cjs --env production'
    }
  }
  */
};
