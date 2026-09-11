# 0.5.0 交付追溯

对应 [SPECS](SPECS.md) 的 37 个主责 Issue。实现统一在 [PR #4884](https://github.com/hs3180/disclaude/pull/4884)，最新候选与实测状态见 [release-candidate.md](release-candidate.md)。Issue 状态不能代替验收；本表不自动关闭 Issue，也不把尚未合并的修复写成已发布。

| Issue | 验收 | 实现/精确回归入口 | 结论与边界 |
|---|---|---|---|
| [#4772](https://github.com/hs3180/disclaude/issues/4772) | S01-A1 | `packages/core/src/config/agent-presets.ts` | 预设配置与 resolver 回归 |
| [#4724](https://github.com/hs3180/disclaude/issues/4724) | S01-A2/A3 | `packages/primary-node/src/primary-agent-pool.ts` | 真实切换、失败保持原预设、chat 隔离 |
| [#4723](https://github.com/hs3180/disclaude/issues/4723) | S01-A2/A3 | `packages/core/src/control/commands/agent.ts` | 选择实际 backend/model；不承诺跨后端原生历史迁移 |
| [#4383](https://github.com/hs3180/disclaude/issues/4383) | S01-A4 | `packages/core/src/sdk/providers/pi/provider.ts` | pi 0.83 原生工具、取消、继续；可选安装，无外部 MCP 适配 |
| [#4740](https://github.com/hs3180/disclaude/issues/4740) | S02-A1–A5 | `packages/core/src/sdk/providers/deepseek/provider.ts` | dsh 0.1.2-rc.1 真实模型/工具/交付 |
| [#4741](https://github.com/hs3180/disclaude/issues/4741) | S02-A1 | `packages/core/src/config/config-validation-deepseek.test.ts` | 配置与凭证诊断；Issue 已关闭 |
| [#4742](https://github.com/hs3180/disclaude/issues/4742) | S02-A2 | `packages/core/src/sdk/providers/deepseek/dsh-transport.ts` | 分帧、关联、异常退出、取消与回收 |
| [#4743](https://github.com/hs3180/disclaude/issues/4743) | S02-A3 | `packages/core/src/sdk/providers/deepseek/event-adapter.ts` | 终态映射；消息边界文本，排除 reasoning 噪声 |
| [#4744](https://github.com/hs3180/disclaude/issues/4744) | S02-A4 | `packages/core/src/sdk/providers/deepseek/provider.ts` | 真实工具产物及飞书最终回执；dsh 原生工具策略 |
| [#4745](https://github.com/hs3180/disclaude/issues/4745) | S02-A4/A5 | `scripts/test-deepseek-live.mjs` | 单轮/多轮/工具/取消/新查询；README 接入说明 |
| [#4808](https://github.com/hs3180/disclaude/issues/4808) | S03-A1 | `packages/primary-node/src/agents/chat-agent.ts` | 按 messageId 结算、乱序/重复/过期回合 |
| [#4825](https://github.com/hs3180/disclaude/issues/4825) | S03-A2–A5 | `packages/core/src/sdk/providers/codex/app-server-lifecycle.ts` | 真实 steer 改变执行；取消等待终态，原线程继续 |
| [#4208](https://github.com/hs3180/disclaude/issues/4208) | S04-A1/A2 | `packages/primary-node/src/channels/feishu-channel.ts` | 真实 CardKit 更新收尾与失败降级回归 |
| [#4399](https://github.com/hs3180/disclaude/issues/4399) | S04-A1/A2 | `packages/core/src/utils/streaming-reply-driver.ts` | 状态转换、幂等 finalize、节流隔离与释放 |
| [#4398](https://github.com/hs3180/disclaude/issues/4398) | S04-A5 | `packages/core/src/utils/streaming-throttle.ts` | 200ms 默认/8000ms 退避上限；20 次更新采样。饱和压测按 SPECS 延期，Issue 保持 open |
| [#4774](https://github.com/hs3180/disclaude/issues/4774) | S04-A4 | `packages/core/src/sdk/providers/claude/message-adapter.ts` | tool_result 不误作新请求；保留诊断 |
| [#4747](https://github.com/hs3180/disclaude/issues/4747) | S04-A3 | `packages/primary-node/src/agents/chat-agent.ts` | 工具后无正文、失败与取消有明确终态 |
| [#4770](https://github.com/hs3180/disclaude/issues/4770) | S04-A3 | `packages/primary-node/src/agents/chat-agent.ts` | 未知错误可诊断；显式 stop 不误作熔断 |
| [#4746](https://github.com/hs3180/disclaude/issues/4746) | S04-A4 | `packages/primary-node/src/channels/feishu/message-filters.ts` | 原子去重及回合/投递可观测性 |
| [#4708](https://github.com/hs3180/disclaude/issues/4708) | S05-A1 | `bin/disclaude.js` | tarball 在仓库外真实 npm install 后执行 |
| [#4797](https://github.com/hs3180/disclaude/issues/4797) | S05-A1 | `packages/channel-cli/src/cli.ts` | 统一 channel push；不恢复独立 push-cli |
| [#4543](https://github.com/hs3180/disclaude/issues/4543) | S05-A4 | `packages/core/src/channel-api/client.ts` | REST 请求与缺失地址诊断；无 IPC 回退 |
| [#4707](https://github.com/hs3180/disclaude/issues/4707) | S05-A1/A5 | `tests/unified-cli.test.ts` | 仓库外调用；start 参数与真实 Primary 启动 |
| [#4824](https://github.com/hs3180/disclaude/issues/4824) | S05-A2/A3 | `packages/primary-node/src/primary-agent-pool.ts` | 双实例随机端口、受管环境传播、重启新地址 |
| [#4798](https://github.com/hs3180/disclaude/issues/4798) | S06-A1/A2 | `packages/core/src/scheduling/scheduler.ts` | 真实三次空轮询零模型调用；变化后 CLI 唤醒产出文件 |
| [#4812](https://github.com/hs3180/disclaude/issues/4812) | S06-A3 | `packages/core/src/scheduling/schedule-watcher.ts` | 定时独立会话及 clearContext 配置回归 |
| [#4810](https://github.com/hs3180/disclaude/issues/4810) | S06-A4 | `tests/compact-loop-ledger.test.ts` | 有界账本保留/归档/幂等 |
| [#4795](https://github.com/hs3180/disclaude/issues/4795) | S06-A4 | `packages/primary-node/src/agents/history-manager.ts` | 首轮快照、预算与并发读取 |
| [#4773](https://github.com/hs3180/disclaude/issues/4773) | S06-A5 | `packages/core/src/scheduling/schedule-watcher.ts` | 非法 tier 拒绝；合法模型与临时覆盖 |
| [#4813](https://github.com/hs3180/disclaude/issues/4813) | S07-A2/A3 | `packages/core/src/sdk/providers/stall-policy.ts` | 统一超时参数；移除全局监听器清理；限定 Claude 注入。详见兼容层审计 |
| [#4811](https://github.com/hs3180/disclaude/issues/4811) | S07-A1 | `package-lock.json` | SDK 0.3.263 / 内嵌 CLI 2.1.263；真实 SDK 接入 |
| [#4706](https://github.com/hs3180/disclaude/issues/4706) | S07-A4 | `packages/core/src/agents/message-builder/message-builder.ts` | 稳定前缀/动态结构验证；不宣称 cache hit 收益 |
| [#4735](https://github.com/hs3180/disclaude/issues/4735) | S07-A5 | `packages/core/src/config/config-validation-glm-endpoint.test.ts` | 失效 endpoint 清理与迁移错误 |
| [#4448](https://github.com/hs3180/disclaude/issues/4448) | S08-A1 | `tests/e2e/rfc3329/project-cwd-provider-e2e.test.ts` | 双实例不同实际 cwd；缺失路径/切换回归 |
| [#4777](https://github.com/hs3180/disclaude/issues/4777) | S08-A2/A3 | `packages/core/src/utils/logger.test.ts` | 隔离目录轮转/保留量；不触碰历史大日志 |
| [#4786](https://github.com/hs3180/disclaude/issues/4786) | S08-A2/A3 | `packages/core/src/utils/logger.test.ts` | 文件与 stdout 镜像；Docker 演练非阻塞 |
| [#4624](https://github.com/hs3180/disclaude/issues/4624) | S08-A4 | `scripts/rehearse-launchd.py` | 隔离安装/升级/回退/停止；清理 PM2 残留；Issue 已关闭 |

44 条验收证据保存在忽略目录 `tests/e2e/0.5.0/.local/delivery/`，包含候选 SHA、实际命令、精确测试用例、原始产物 SHA-256 与适用范围。结构和哈希通过不能代替测试通过，最终 gate 结合原始结果及审阅结论。

明确的非阻塞范围：Docker 部署演练遵循用户 2026-09-10 决定；#4398 饱和压测遵循 SPECS 与 Issue 延期决策；Research 等 P1 不包含在此次交付承诺中。其余 P0 不以“凭证不足”或 Issue 状态搁置。
