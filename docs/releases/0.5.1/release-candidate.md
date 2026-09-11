# 0.5.1 发布候选记录

状态：发布准备尚有安装阻断；尚未创建正式标签或 GitHub Release。

## 分发方式

- 根包版本：0.5.1；package-lock 根版本同步。
- 根包保持 `private: true`，仅通过 GitHub 分发。
- 正式标签发布后：`npm install -g "github:hs3180/disclaude#v0.5.1"`。
- 标签发布前，以固定提交 SHA 在隔离 prefix/cache 中验证同一 GitHub 安装路径。

## 本轮验证

测试代码候选：`5a62c402`（后续撤销实验性安装 workaround 后，运行代码保持一致）。环境：macOS arm64、Node.js 24.8.0。

| 检查 | 结果 |
| --- | --- |
| 全量覆盖率测试 | 219 文件 / 4669 测试通过；statements/lines 90.48%，branches 89.47%，functions 93.37% |
| Lint、type-check/build | 通过 |
| 干净 worktree `npm ci --include=dev` + `npm pack` | 通过，产物版本 0.5.1 |
| 干净产物审计 | 11870 文件，100222358 bytes；旧 tracker 0，敏感配置路径 0 |
| 干净 .tgz 隔离全局安装 | 通过；`disclaude --version` 为 v0.5.1，`disclaude start --help` 可运行 |
| 安装后的 PrimaryNode 离线启动/停止 | 通过，使用占位 YAML 凭据、deferScheduler，不调用模型或发送消息 |
| GitHub SHA 全局安装 | **失败，仍为发布阻断**；npm 10.9.9、11.6.0、11.19.1 均复现 |

干净产物 SHA-512 integrity：
`sha512-80nJjKmiFn6YdBwurGIGP/FShlAzDOAkk6aBBKJRMNHp6jffzdZXSyJJevQCGba+FCYlRY3IdcD7Q13kfbt2Fg==`。

### 安装阻断与实验边界

从 GitHub 固定提交执行 `npm install -g --prefix <isolated-prefix> --cache <isolated-cache> github:hs3180/disclaude#5a62c402` 时，嵌套 Git 依赖准备没有正确安装 workspace 开发依赖，`prepare: husky` 报 command not found。

实验性准备脚本强制安装本地依赖后，npm 虽返回成功，最终全局链接却指向已删除的临时 clone，CLI 不可用。因此该 workaround 已撤销，不能计作安装通过。

已有开发工作区直接打包还会保留异常嵌套依赖布局，导致运行时无法解析 Claude SDK；全新 worktree 的 npm ci + pack 解决了该制品问题。最终分发必须采用干净构建，而不能复用开发目录产物。

如保留单条 GitHub-tag 全局安装作为发布要求，必须先修复并通过该路径；已通过的 .tgz 安装不等同于 GitHub-tag 安装。不在本轮擅自更换已约定的安装入口。

本机日志：`/tmp/disclaude-051-release-coverage.log`、`/tmp/disclaude-051-github-install.log`、`/tmp/disclaude-051-github-install-new-npm.log`、`/tmp/disclaude-051-github-install-npm10.log`、`/tmp/disclaude-051-clean-pack.json`、`/tmp/disclaude-051-clean-tar-startup.log`。原始日志对外分享前需检查脱敏。

## 已有真实验收

- 0.5.1 功能候选的 4669 项测试曾全部通过。
- 指定飞书普通群的文本、文件和文本 parent 回复真实投递成功；API 回读确认目标及 parent/root 归属。
- DeepSeek V4 Flash 经 Claude 后端使用显式 100k 阈值，3 轮成功；自动压缩事件 104396 → 885 tokens，压缩后保留随机标记并继续执行指令。
- DeepSeek 模型元数据 API 不提供 context 上限；新的发现逻辑实测告警且不注入猜测值。API 返回有效 context 上限的计算路径由回归测试覆盖。

## 发布边界

- 超大单次输入仍可能先失败再压缩，不能宣称所有上下文溢出场景已解决。
- 0.5.1 真实飞书验收不外推到 P2P、topic-mode 群和卡片回复。
- 暂保留已测试的过期构建产物清理脚本；改为全量干净构建属于后续维护简化，不在最终发布准备中扩大改动。

## 正式发布前

1. 合并发布准备 PR，确认目标 main 提交 CI 全绿。
2. 经确认在目标提交创建 v0.5.1 标签，并使用上级发布说明创建 GitHub Release。
3. 对正式标签执行安装检查；发布准备阶段不会创建该标签，也不会执行 npm publish。
