# 0.5.0 并行交付记录

截至 2026-09-09 19:15（Asia/Shanghai）。基线 `987e4b91`；以下均为待审 PR，未合并、未发布。详细步骤见 [PARALLEL-PLAN.md](PARALLEL-PLAN.md)。

| 范围 | 独立 PR | 已交付 / 仍需工作 |
|---|---|---|
| 计划 | [#4852](https://github.com/hs3180/disclaude/pull/4852) | 分工、依赖、实现与验收步骤 |
| S01 | [#4857](https://github.com/hs3180/disclaude/pull/4857) | 默认及按会话预设真实接线；真实跨后端验收待做 |
| S02 | [#4856](https://github.com/hs3180/disclaude/pull/4856) | dsh 协议与原生工具事件；真实 prompt 被 MISSING_CREDENTIAL 阻塞，外部工具注册协议不存在 |
| S03 | [#4863](https://github.com/hs3180/disclaude/pull/4863) | stop/queue 和明确的 steer 能力限制；真实 app-server steer 尚未交付 |
| S04 | [#4866](https://github.com/hs3180/disclaude/pull/4866) | 终态投递失败可观测、finalize 失败触发降级；真实渠道回执待验 |
| S05 | [#4858](https://github.com/hs3180/disclaude/pull/4858) | 动态地址、独立 CLI；已做隔离双实例/重启及仓库外 pack 安装执行 |
| S06 历史 | [#4859](https://github.com/hs3180/disclaude/pull/4859) | 首消息单次有界快照 |
| S06 账本 | [#4855](https://github.com/hs3180/disclaude/pull/4855) | 有界活跃轮次与无损归档；72 轮字节守恒回归 |
| S06 调度 | [#4867](https://github.com/hs3180/disclaude/pull/4867) | 每 tick 独立原生会话；不重置用户；模型覆盖与旧配置迁移 |
| S06 脚本 | [#4851](https://github.com/hs3180/disclaude/pull/4851) | 既有 PR，非本批重复实现；组合审阅中 |
| S07 提示 | [#4861](https://github.com/hs3180/disclaude/pull/4861) | 稳定前缀与动态输入分离；未声称实测缓存收益 |
| S07 SDK | [#4864](https://github.com/hs3180/disclaude/pull/4864) | 自报版本与安装的 SDK 一致 |
| S07 GLM | [#4865](https://github.com/hs3180/disclaude/pull/4865) | 去掉失效隐式端点，保留显式代理与迁移诊断 |
| S08 cwd | [#4860](https://github.com/hs3180/disclaude/pull/4860) | 绑定目录丢失时拒绝执行，不回退共享目录 |
| S08 日志 | [#4862](https://github.com/hs3180/disclaude/pull/4862) | 等待轮转日志退出刷盘；真实临时目录轮转验证 |
| S09 gate | [#4853](https://github.com/hs3180/disclaude/pull/4853) | 44 条验收清单和证据 gate，拒绝空白/过期/跳过证据；不是 E2E runner |
| S09 文档 | [#4854](https://github.com/hs3180/disclaude/pull/4854) | 撤回过早的已发布/全部完成表述 |

## 验证与集成边界

- 19:11 查询时 #4852–#4864 均通过远端 lint/type、build、unit、coverage 四项 CI。其余新提交的 CI 仍需跟踪；这些结果只属于各分支 SHA。
- #4867 本地全量 202 文件 / 4441 测试通过，类型和 lint 通过。
- 本地独立 integration worktree 正在组合检查；不推送或合并 main。S01/S03 命令注册、类型、CLI 接线需保留两方新增项；S01/S06 pool import 需取并集。#4851 与新调度逻辑仍需行为级协调，不可只消除文本冲突。
- 所有外部验收仍须绑定最终候选 SHA；单 PR 的绿色 CI 不能替代组合候选证据。

## 操作事故与剩余阻塞

隔离 launchd 演练清理时，worker 将多项环境变量放在 shell 标量后传给 env，隔离参数可能未生效，误触默认卸载路径。发现默认 `com.disclaude.primary` 未加载、现有 plist 仍在；操作前状态尚不能证实。已停止所有 launchctl 操作，告知用户并等待是否恢复的明确授权。不能将本次演练记为成功或声称未触碰现网。后续须加入隔离参数缺失时 fail-closed 防护及无副作用回归测试。

Docker 在当前环境不存在；不自动安装。DeepSeek 缺有效模型认证。真实飞书发送、生产服务恢复、发布/合并均不借验收名义扩大授权。真实 steer、部署完整演练、后端工具产物与渠道回执、最终候选统一矩阵仍未完成，因此 0.5.0 当前不可宣布发布就绪。
