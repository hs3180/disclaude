// PM2 配置文件 - 使用 shell 脚本包装
module.exports = {
  apps: [{
    name: 'my-app-with-shell',
    // 使用 bash 运行包装脚本
    interpreter: '/bin/bash',
    script: '/Users/hs3180/clawd/disclaude/start-conda-app.sh',

    // 工作目录
    cwd: '/Users/hs3180/clawd/disclaude',

    // PM2 配置
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
  }]
};
