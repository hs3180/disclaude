# disclaude 协作约定

## 仓库与 Git worktree

- disclaude 只维护一个本地仓库作为 Git 对象库和分支来源。不要为任务重新 `git clone`、下载压缩包、复制完整仓库，或先拉取一份新目录再称为 worktree。
- 需要分支隔离时，从现有仓库运行 `git worktree add <路径> <已有分支>`；新分支使用 `git worktree add -b <分支> <路径> <基准分支>`。worktree 共享同一仓库的对象和 refs，不是第二份 clone。
- 创建前先运行 `git worktree list`。优先复用当前任务已有的 worktree；只有确实需要并行工作或隔离分支时才创建新的 worktree。不要让同一分支同时检出到多个 worktree。
- 不要跨 worktree 链接整个 workspace 的 `node_modules`，以免依赖指向其他分支源码。按需安装依赖并复用包管理器缓存。
- 任务结束清理前，检查每个候选目录的 `git status`、上游领先/落后、detached HEAD、忽略文件和运行进程。保留未提交或归属不明的改动、用户数据、运行配置和正在使用的服务目录；不要用 `--force` 掩盖这些状态。移除已结束且可安全清理的目录时使用 `git worktree remove`，保留所需本地分支或为 detached 提交建立 refs，最后运行 `git worktree prune`。临时依赖、构建产物和验证副本仅在确认归本任务所有后清理。

## 0.6.0 反馈与交付记录

- 每次开始任务时检查 `hs3180/disclaude` 的 0.6.0 issues，以及相关 PR 的 reviews、行评论、讨论和 CI。持续会话每 15 分钟检查一次，并在阶段结束或等待 CI 等空闲点复查；不要为轮询中断正在执行的工作。若 `gh` 未认证，公开数据使用 GitHub 公共 API 只读核查。
- 优先处理评审阻塞和实际用例失败。明确区分产品验收、实验结果和未验证条件；Agentic Research 验收对象是持久 Project 与 workspace UX，不能用 Skill Workflow 替代。
- 将检查时间、重要反馈和下一步记入主仓库 `.local/060-feedback.md`。没有新证据时不重复发布 GitHub 评论，也不更新交付状态；不得把真实验收暂缓或未验证写成通过。

## PR 与生产服务边界

- 不得自行合并 PR、启用 auto-merge、加入 merge queue，或通过直接推送目标分支绕过评审。可以按任务需要修改 PR；合并由用户决定并执行。
- 日常 disclaude 飞书服务保持运行。用户已授权在生产环境短暂切换到候选版本进行真实验收；操作时保留原配置和 workspace，避免建立竞争的机器人 WebSocket 连接，记录候选来源与实际中断，并在验收后恢复原服务、核验健康。
- disclaude 日常运行、候选启动、真实模型测试和协议探针统一使用 `gpt-5.6-luna`，禁止使用 Astra。启动前核对实际加载配置中的默认模型、Codex 预设和命令行覆盖，不依赖不确定的全局默认值。

## 飞书 Computer use 验收

- 每轮先设少量 UI 操作预算，控制调用次数与多模态 token。
- API、日志、协议记录和文件可核验时优先使用这些证据；只有必要的原生交互或视觉状态检查才使用 UI，避免重复截图、完整无障碍树和盲目重试。
