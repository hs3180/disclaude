# 0.5.0 并行交付记录

截至 2026-09-09 20:10（Asia/Shanghai）。实现基线 `987e4b91`；原工作区 main 已快进至 `55f60914`，保留用户已有改动。计划 #4852 及部分实现 PR 已由外部操作合并。以下记录各主题的交付与验证，不代替 GitHub 实时合并状态；未发布。详细步骤见 [PARALLEL-PLAN.md](PARALLEL-PLAN.md)。

三个并行实现 agent 均使用 `gpt-5.6-sol`。本地 gitignored `disclaude.config.yaml` 的 `agent.model` 已改为 `gpt-5.6-sol` 并重新解析验证；含私密环境配置的文件未提交到 PR。

| 范围 | 独立 PR | 已交付 / 仍需工作 |
|---|---|---|
| 计划 | [#4852](https://github.com/hs3180/disclaude/pull/4852) | 分工、依赖、实现与验收步骤 |
| S01 | [#4857](https://github.com/hs3180/disclaude/pull/4857) | 默认及按会话预设真实接线；真实跨后端验收待做 |
| S01 原生话题 | [#4875](https://github.com/hs3180/disclaude/pull/4875) | 同 chat 不同话题用不同原生 session key；stacked on #4857 |
| S01 callbacks | [#4876](https://github.com/hs3180/disclaude/pull/4876) | 回收/reset 释放旧 callbacks，保留用户选择；stacked on #4857 |
| S02 | [#4856](https://github.com/hs3180/disclaude/pull/4856) | dsh 协议与原生工具事件；真实 prompt 被 MISSING_CREDENTIAL 阻塞，外部工具注册协议不存在 |
| S03 | [#4863](https://github.com/hs3180/disclaude/pull/4863) | stop/queue 与 exec 的 steer 能力限制；可选 app-server 接线见 #4877/#4880，真实模型场景待验 |
| S03 恢复 | [#4871](https://github.com/hs3180/disclaude/pull/4871) | 修复 thread.started 已到达但 run close 未结束时回收漏存原生 thread ID 的竞态 |
| S03 传输 | [#4873](https://github.com/hs3180/disclaude/pull/4873) | app-server stdio transport、超时、退出、EPIPE 与 fail-closed |
| S03 provider | [#4877](https://github.com/hs3180/disclaude/pull/4877) | 显式 app-server 配置、provider/lifecycle、身份/取消/并发控制；stacked on #4873；默认仍 exec |
| S03 命令 | [#4880](https://github.com/hs3180/disclaude/pull/4880) | `/steer` 全链等待 ACK，并校验仍是同一回合；stacked on #4863，与 #4877 组合 |
| S04 | [#4866](https://github.com/hs3180/disclaude/pull/4866) | 终态投递失败可观测、finalize 失败触发降级；真实渠道回执待验 |
| S05 | [#4858](https://github.com/hs3180/disclaude/pull/4858) | 动态地址、独立 CLI；已做隔离双实例/重启及仓库外 pack 安装执行 |
| S05/S06 启动 | [#4870](https://github.com/hs3180/disclaude/pull/4870) | 等 REST 实际地址就绪后再启 cron；stacked on #4858 |
| S06 历史 | [#4859](https://github.com/hs3180/disclaude/pull/4859) | 首消息单次有界快照 |
| S06 账本 | [#4855](https://github.com/hs3180/disclaude/pull/4855) | 有界活跃轮次与无损归档；72 轮字节守恒回归 |
| S06 调度 | [#4867](https://github.com/hs3180/disclaude/pull/4867) | 每 tick 独立原生会话；不重置用户；模型覆盖与旧配置迁移 |
| S06 脚本 | [#4851](https://github.com/hs3180/disclaude/pull/4851) | 既有 PR，非本批重复实现；组合审阅中 |
| S06 进程 | [#4874](https://github.com/hs3180/disclaude/pull/4874) | ScriptRunner 预取消、进程组 TERM/KILL、有界输出；stacked on #4851；含顽固子进程实际回归 |
| S06 停机 | [#4878](https://github.com/hs3180/disclaude/pull/4878) | 停机跨 await 屏障、同任务多执行独立取消；stacked on #4874 |
| S07 提示 | [#4861](https://github.com/hs3180/disclaude/pull/4861) | 稳定前缀与动态输入分离；未声称实测缓存收益 |
| S07 SDK | [#4864](https://github.com/hs3180/disclaude/pull/4864) | 自报版本与安装的 SDK 一致 |
| S07 审计 | [#4868](https://github.com/hs3180/disclaude/pull/4868) | 逐项记录 SDK workaround 来源、保留理由与后续验证条件 |
| S07 GLM | [#4865](https://github.com/hs3180/disclaude/pull/4865) | 去掉失效隐式端点，保留显式代理与迁移诊断 |
| S08 cwd | [#4860](https://github.com/hs3180/disclaude/pull/4860) | 绑定目录丢失时拒绝执行，不回退共享目录 |
| S08 日志 | [#4862](https://github.com/hs3180/disclaude/pull/4862) | 等待轮转日志退出刷盘；真实临时目录轮转验证 |
| S08 launchd | [#4869](https://github.com/hs3180/disclaude/pull/4869) | 隔离哨兵与 fail-closed 参数验证；stacked on #4858；事故见下，不计为完整验收通过 |
| S09 gate | [#4853](https://github.com/hs3180/disclaude/pull/4853) | 44 条验收清单和证据 gate，拒绝空白/过期/跳过证据；不是 E2E runner |
| S09 加固 | [#4879](https://github.com/hs3180/disclaude/pull/4879) | 真实 commit、canonical 要求与证据路径范围；明确可信 runner 边界 |
| S09 文档 | [#4854](https://github.com/hs3180/disclaude/pull/4854) | 撤回过早的已发布/全部完成表述 |

## 验证与集成边界

依赖顺序、已处理的代码冲突和证据归属见 [INTEGRATION-NOTES.md](INTEGRATION-NOTES.md)。

- 19:11 查询时 #4852–#4864 均通过远端 lint/type、build、unit、coverage 四项 CI。其余新提交的 CI 仍需跟踪；这些结果只属于各分支 SHA。
- #4867 本地全量 202 文件 / 4441 测试通过，类型和 lint 通过。
- 本地独立 integration worktree 已组合所有交付；不推送或合并 main。S01/S03 命令注册、类型、CLI 接线保留两方新增项；S01/S06 pool import 取并集。#4851 与新调度逻辑已按 INTEGRATION-NOTES 中的不变量协调，并纳入组合测试。
- 所有外部验收仍须绑定最终候选 SHA；单 PR 的绿色 CI 不能替代组合候选证据。
- 第一轮组合构建、类型、lint 通过；4508 测试通过、1 项 Codex eviction/resume 间歇失败，已交 agent 查根因，不标记组合测试通过。#4867、#4865、#4868 的远端四项 CI 已通过。
- 修复 #4871 后的组合 SHA `b56d972f37d9df78fd39fb17a5813fe931f8e1cc`：207 文件 / 4520 测试全部通过；coverage 再运行同样 4520 项通过，statements/lines 90.4%、branches 89.41%、functions 93.4%。后续增加的脚本/传输补丁尚不属于该 SHA 的全量证据，已分别通过组合定向 182 项 / 6 项。
- #4869/#4870 等 stacked PR 目标是 feature branch，当前 CI 仅匹配 main/master，所以没有远端 checks，不是成功。修复 workflow 的本地提交 `e2d301d8`（`ci/050-check-stacked-prs`）已做 YAML/触发器结构校验，但 GitHub App 缺 `workflows` 权限，push 被拒绝，**未创建 PR**。未绕过权限；需有权限的维护者提交，或前置合并后改 target 并等待 CI。
- 后续组合 SHA `88f4c81768af9f5ff045c94807874c8af53d5d95` 已含脚本停机、话题隔离与 gate 加固：210 文件 / 4554 测试、coverage 全部通过（statements/lines 90.4%、branches 89.18%、functions 93.53%）。仍未包含正在收尾的 app-server provider/命令接线。
- 最终本地组合 SHA `353e24783f0ca2c9363cf8a18aa006c24e860964` 已包含 #4877 最终 `212b3c49` 与 #4880 `8e74f3bc`：类型检查（含构建）、lint、211 文件 / 4565 测试全部通过；coverage statements/lines 90.35%、branches 88.97%、functions 93.43%。这是本地组合证据，不是远端合并或真实模型 E2E 验收。

## 操作事故与剩余阻塞

约 19:07，隔离 launchd 演练清理时，worker 将多项环境变量放在 zsh 标量后传给 env，隔离参数未按预期展开，误触默认卸载路径，输出 `Service unloaded.`。随后默认 `com.disclaude.primary` 未加载、测试 label 仍加载；默认 plist 未删除/改写，操作前服务状态尚不能证实。已知默认目标操作是 unload，测试目标随后使用显式参数清理。已停止所有 launchctl 操作，告知用户并等待是否恢复的明确授权。不能将本次演练记为成功或声称未触碰现网。#4869 已补不依赖 env 展开的 `isolated <command>` 哨兵，以及缺参数时在副作用前拒绝的 37 项测试；事故后未重新进行服务演练。

Docker 在当前环境不存在；不自动安装。DeepSeek 缺有效模型认证。真实飞书发送、生产服务恢复、发布/合并均不借验收名义扩大授权。真实模型执行中的 steer 验收、部署完整演练、后端工具产物与渠道回执、最终候选统一矩阵仍未完成，因此 0.5.0 当前不可宣布发布就绪。
