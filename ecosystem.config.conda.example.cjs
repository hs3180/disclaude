// PM2 配置文件 - 在 conda 环境下运行
module.exports = {
  apps: [{
    name: 'my-app-in-conda',
    // 使用 conda 环境的 Python 解释器（绝对路径）
    interpreter: '/Users/hs3180/anaconda/anaconda3/envs/falcon/bin/python',
    // 你的应用入口文件
    script: './src/index.py',
    // 或者如果是 Python 命令
    // script: '-m',
    // args: 'my_module.main',

    // 工作目录
    cwd: '/path/to/your/app',

    // 环境变量（可选，用于覆盖 conda 环境变量）
    env: {
      PYTHONPATH: '/Users/hs3180/anaconda/anaconda3/envs/falcon/lib/python3.12/site-packages',
      // 其他环境变量
      NODE_ENV: 'production',
    },

    // PM2 配置
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env_production: {
      NODE_ENV: 'production'
    }
  }]
};
