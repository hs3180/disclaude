# macOS 部署指南：使用 launchd 替代 PM2

> 解决 macOS TCC 权限问题：PM2 进程链导致麦克风等受保护资源访问被静默拒绝。

## 问题背景

macOS 的 TCC (Transparency, Consent, and Control) 安全系统**沿进程链追踪权限**。当 disclaude 通过 PM2 fork 模式运行时：

```
PM2 (node/PID) → claude → zsh → python/audio-tool
```

PM2 的 node 进程祖先没有 TCC 权限，导致**所有后代进程**被静默拒绝访问麦克风、摄像头等受保护资源，返回全零数据且无任何错误提示。

## 解决方案：launchd

macOS 使用 `launchd` 作为原生进程管理器。进程链干净：

```
launchd → node → disclaude
```

首次运行时，macOS 会自动弹出 TCC 授权弹窗，授权后所有子进程正常访问受保护资源。

### 优缺点对比

| 特性 | launchd (macOS) | PM2 (Linux) |
|------|-----------------|-------------|
| TCC 兼容 | ✅ 完美 | ❌ 进程链断裂 |
| 开机自启 | ✅ RunAtLoad | ✅ pm2 startup |
| 崩溃重启 | ✅ KeepAlive | ✅ autorestart |
| 监控 UI | ❌ 无 | ✅ pm2 monit |
| 集群管理 | ❌ 单实例 | ✅ 多实例 |
| 日志管理 | ✅ 文件输出 | ✅ pm2 logs |
| 负载均衡 | ❌ 无 | ✅ cluster mode |

## 快速开始

### 1. 自动安装（推荐）

```bash
# 构建项目并安装为 LaunchAgent
npm run launchd:install
```

这个命令会：
1. 运行 `npm run build`（如需要）
2. 从模板生成 plist 文件（自动替换路径）
3. 加载 LaunchAgent 服务
4. 验证服务状态

### 2. 手动安装

```bash
# 1. 复制模板
cp com.disclaude.plist.example ~/Library/LaunchAgents/com.disclaude.plist

# 2. 编辑 plist，替换所有 /path/to/disclaude 为实际路径
# 必须替换的字段：
#   - ProgramArguments 中的 node 和 cli.js 路径
#   - WorkingDirectory
#   - StandardOutPath
#   - StandardErrorPath
vim ~/Library/LaunchAgents/com.disclaude.plist

# 3. 验证 plist 格式
plutil -lint ~/Library/LaunchAgents/com.disclaude.plist

# 4. 创建日志目录
mkdir -p logs

# 5. 加载服务
launchctl load ~/Library/LaunchAgents/com.disclaude.plist
```

## 日常管理

```bash
# 查看服务状态
npm run launchd:status

# 查看日志（实时跟踪，Ctrl+C 退出）
npm run launchd:logs

# 重启服务（先 build 再重启）
npm run launchd:restart

# 卸载服务
npm run launchd:uninstall
```

### 直接使用 launchctl

```bash
# 停止服务（保持 plist，不自动重启）
launchctl unload ~/Library/LaunchAgents/com.disclaude.plist

# 启动服务
launchctl load ~/Library/LaunchAgents/com.disclaude.plist

# 强制停止当前进程（launchd 会自动重启，除非先 unload）
launchctl kickstart -k gui/$(id -u)/com.disclaude

# 查看服务详情
launchctl print gui/$(id -u)/com.disclaude
```

## PM2 → launchd 迁移指南

### 步骤 1：停止 PM2 服务

```bash
npm run pm2:stop
npm run pm2:delete
```

### 步骤 2：确认配置文件就位

确保 `disclaude.config.yaml` 已正确配置：

```bash
# 如果还没有配置文件
cp disclaude.config.example.yaml disclaude.config.yaml
# 编辑配置...
```

### 步骤 3：安装 launchd 服务

```bash
npm run launchd:install
```

### 步骤 4：授权 TCC 权限

首次运行时，macOS 会弹出 TCC 授权弹窗。**必须点击"允许"**。

如果没有弹出弹窗，可以手动在系统设置中授权：

1. 打开 **系统设置** → **隐私与安全性**
2. 找到 **麦克风**（或摄像头等）
3. 找到 `node` 或 `Terminal`，勾选允许

也可以通过命令行重置 TCC 权限（调试用）：

```bash
# 重置 Node.js 的 TCC 权限（macOS 会重新弹出授权弹窗）
tccutil reset Microphone com.disclaude
```

### 步骤 5：验证

```bash
# 检查服务状态
npm run launchd:status

# 查看日志确认正常运行
npm run launchd:logs
```

## 配置说明

### plist 模板字段

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `Label` | LaunchAgent 唯一标识 | `com.disclaude` |
| `ProgramArguments` | 启动命令 | `node cli.js start` |
| `WorkingDirectory` | 项目根目录 | 需手动设置 |
| `RunAtLoad` | 登录时自动启动 | `true` |
| `KeepAlive` | 崩溃自动重启 | `true` |
| `ThrottleInterval` | 重启间隔（秒） | `10` |
| `StandardOutPath` | 标准输出日志 | `logs/launchd-stdout.log` |
| `StandardErrorPath` | 错误日志 | `logs/launchd-stderr.log` |
| `SoftResourceLimits.RSS` | 内存限制 | 1GB |

### 环境变量

所有配置应通过 `disclaude.config.yaml` 管理，**不要在 plist 中设置敏感环境变量**。

唯一的环境变量是 `NODE_ENV=production`，已内置在模板中。

## 故障排除

### 服务启动后立即退出

```bash
# 查看错误日志
cat logs/launchd-stderr.log

# 常见原因：
# 1. Node.js 路径不正确 → 检查 ProgramArguments 中的 node 路径
# 2. cli.js 不存在 → 运行 npm run build
# 3. 配置文件缺失 → 检查 disclaude.config.yaml
# 4. 端口被占用 → 检查是否有 PM2 残留进程
```

### TCC 权限仍然被拒绝

```bash
# 1. 确认确实在使用 launchd（而非 PM2）
launchctl list | grep disclaude

# 2. 确认进程链干净（无 PM2 中间层）
ps aux | grep disclaude

# 3. 检查 TCC 数据库
# macOS 14+: 系统设置 → 隐私与安全性 → 麦克风
# 确认 node 或 Terminal 已被授权

# 4. 重置 TCC 权限（调试用）
tccutil reset Microphone com.disclaude
```

### 日志文件过大

```bash
# 手动清理日志
> logs/launchd-stdout.log
> logs/launchd-stderr.log

# 推荐使用 logrotate 或在 disclaude.config.yaml 中启用日志轮转
# logging:
#   rotate: true
```

### 升级 disclaude 后服务异常

```bash
# 拉取最新代码后，重新 build 并重启
cd /path/to/disclaude
git pull
npm install
npm run launchd:restart
```

## Linux 用户

Linux 不受 TCC 限制，继续使用 PM2：

```bash
npm run pm2:start    # 启动
npm run pm2:restart  # 重启
npm run pm2:logs     # 查看日志
npm run pm2:status   # 查看状态
```

## 参考资料

- [Apple Developer: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [launchd.plist(5) man page](https://manpagearchive.net/launchd.plist.5.html)
- [macOS TCC 深度分析](https://developer.apple.com/documentation/bundleresources/entitlements)
