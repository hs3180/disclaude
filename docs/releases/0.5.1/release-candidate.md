# 0.5.1 发布候选记录

最新状态：正式 Git 标签 `v0.5.1` 已创建，指向从合并后 main 生成的预构建发行提交；GitHub Release 尚未公开发布。最新指向、安装及 CI 证据见 [tag 安装记录](npm-tag-acceptance.md)。以下内容保留历史候选的验证过程，不代表最新标签仍缺失。

## #4924 服务重构候选（2026-09-11）

- 实现 PR：[#4925](https://github.com/hs3180/disclaude/pull/4925)。源码 `ac1e7ed96152b06d7bc1a1012e48b9e8b44741c3`，干净 worktree 安装依赖并重新构建。
- 远程发行提交：`5c77edf3c87684c656099066ea3737c86f6e2bca`；指纹 `2539564935d40b6b312462c07130014ea5f9ecc3049b8227352cb5f9cec9f27e`。此前候选通过记录不能代替本次验收。
- 删除角色模型、旧包/CLI、无用 transport 配置、跨节点协议与远程卡片路由；处置和数据保护见 [迁移说明](../../migrations/0.5.1-service.md)。
- 本地回归：218 文件 / 4674 测试通过（不含单独执行的 Git 发行 gate）；lint、build、type-check 通过。
- macOS：Node 20.20.2/npm 10.9.9 和 Node 22.23.2/npm 11.6.0 的远程 SHA 安装通过，包含公共 CLI 启停/重启、HTTP `instanceId`、旧入口缺失和数据保留检查。
- macOS launchd：独立测试 label/config/workspace 完成 plist 校验、安装、健康检查、重启（实例 ID 变化）、停止及卸载；保留测试数据。未修改或重启用户的现有服务。
- 现有 Linux CI 执行 Node 20/22 × npm 10/11 四种组合；macOS 由本机隔离安装完成对应组合。最终 CI 结果及交叉组合证据补充在 PR 中。
- Docker 在此主机不可用，仅完成构建/Compose 配置静态回归，不能宣称容器运行实测通过。正式 tag 尚未创建，仍须按 #4922 复核精确 tag 命令。

## 分发方式

- 根包版本：0.5.1；package-lock 根版本同步。
- 根包保持 `private: true`，仅通过 GitHub 分发。
- 正式发行标签发布后：`npm install -g "github:hs3180/disclaude#v0.5.1"`；`.tgz` 仅为补充路径。
- 当时的候选 SHA 与源码指纹使用仓库 fixture 记录；该机制现已移除。现有 CI 从当前 checkout 生成临时分发包进行安装回归，远程 SHA/标签安装在发布时单独验证；额外 [跨平台工作流模板](../package-install.workflow.yml) 尚待维护者安装，未运行项不能计作通过。
- Husky 仅通过开发者命令 `npm run hooks:install` 初始化，不参与用户安装。

## 历史验证（安装修复 PR 之前）

测试代码候选：`5a62c402`（后续撤销实验性安装 workaround 后，运行代码保持一致）。环境：macOS arm64、Node.js 24.8.0。

| 检查 | 结果 |
| --- | --- |
| 全量覆盖率测试 | 219 文件 / 4669 测试通过；statements/lines 90.48%，branches 89.47%，functions 93.37% |
| Lint、type-check/build | 通过 |
| 干净 worktree `npm ci --include=dev` + `npm pack` | 通过，产物版本 0.5.1 |
| 干净产物审计 | 11870 文件，100222358 bytes；旧 tracker 0，敏感配置路径 0 |
| 干净 .tgz 隔离全局安装 | 通过；`disclaude --version` 为 v0.5.1，`disclaude start --help` 可运行 |
| 安装后的旧 PrimaryNode 离线启动/停止（历史） | 通过，使用占位 YAML 凭据、deferScheduler，不调用模型或发送消息；不代表 #4924 新服务验收 |
| GitHub SHA 全局安装 | **失败，仍为发布阻断**；npm 10.9.9、11.6.0、11.19.1 均复现 |

干净产物 SHA-512 integrity：
`sha512-80nJjKmiFn6YdBwurGIGP/FShlAzDOAkk6aBBKJRMNHp6jffzdZXSyJJevQCGba+FCYlRY3IdcD7Q13kfbt2Fg==`。

### 安装阻断与实验边界

从 GitHub 固定提交执行 `npm install -g --prefix <isolated-prefix> --cache <isolated-cache> github:hs3180/disclaude#5a62c402` 时，嵌套 Git 依赖准备没有正确安装 workspace 开发依赖，`prepare: husky` 报 command not found。

实验性准备脚本强制安装本地依赖后，npm 虽返回成功，最终全局链接却指向已删除的临时 clone，CLI 不可用。因此该 workaround 已撤销，不能计作安装通过。

已有开发工作区直接打包还会保留异常嵌套依赖布局，导致运行时无法解析 Claude SDK；全新 worktree 的 npm ci + pack 解决了该制品问题。最终分发必须采用干净构建，而不能复用开发目录产物。

已通过的 .tgz 安装不等同于 GitHub-tag 安装。#4921 的资产分发提议不能替代后续 #4922 明确的 tag 直装目标。

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
2. 经确认在已验收的预构建发行提交创建 v0.5.1 标签（不是源码 main），并使用上级发布说明创建 GitHub Release。
3. 按 [Git 发行流程](../git-install.md) 验证固定远程候选 SHA；经授权为已验收发行提交打标签后，复核精确的 tag 直装命令。发布准备阶段不创建正式标签、不执行 npm publish。
