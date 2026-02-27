/**
 * PM2 Ecosystem Configuration for Disclaude
 *
 * Copy this file to `ecosystem.config.cjs` and configure as needed.
 * The actual config file is gitignored to protect secrets.
 *
 * Usage:
 *   cp ecosystem.config.example.cjs ecosystem.config.cjs
 *   # Edit ecosystem.config.cjs with your credentials
 *   npm run pm2:start
 *
 * @see {@link https://pm2.keymetrics.io/docs/usage/application-declaration/}
 */

module.exports = {
  apps: [{
    // ===== Application Identity =====
    name: 'disclaude-feishu',

    // ===== Execution Configuration =====
    script: './dist/cli-entry.js',
    args: 'start --mode primary',
    interpreter: 'node',
    cwd: '/path/to/disclaude',  // Change to your actual path

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
      LOG_DIR: './logs',
      // Add your secrets here or use environment variables
      // JOINQUANT_USERNAME: 'your-username',
      // JOINQUANT_PASSWORD: 'your-password',
    },
    env_production: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      LOG_DIR: './logs',
    },

    // ===== Logging Configuration =====
    // PM2 logging is DISABLED to avoid conflicts with Pino
    // Application logs → Pino → File rotation + stdout
    error_file: null,
    out_file: null,
    log_date_format: '',
    merge_logs: true,
    time: false,

    // ===== Process Management =====
    kill_timeout: 5000,
    wait_ready: false,
    listen_timeout: 3000,

    // ===== Advanced Configuration =====
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 4000,
    source_map_support: true,
    instance_var: 'INSTANCE_ID',
  }],
};
