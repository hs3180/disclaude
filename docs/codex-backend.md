# Codex 后端（agentBackend）指南

Disclaude 的 Agent 运行时（agent runtime）可通过配置切换。默认使用 `claude`（claude-code CLI）；本页介绍如何启用 `codex` 后端（OpenAI 官方 [Codex CLI](https://developers.openai.com/codex/cli) 的 `codex exec` 非交互模式），以及它当前的边界。

与 claude/pi 后端的本质区别：**codex 后端用 ChatGPT 订阅额度（而非 API key）驱动 agent**——社区测算的量级约为 Plus（$20/月）饱和使用 ≈ 每周 $100–110 API 等效算力（约 20×，非官方数字、随政策变动；ToS 姿态与风险见第 8 节）。

> 配置项随 Issue [#4629](https://github.com/hs3180/disclaude/issues/4629)（S1）落地；exec 桥接/会话/权限/配额分别为 #4630 / #4628 / #4631 / #4632。父特性：[#4627](https://github.com/hs3180/disclaude/issues/4627)。行为实证基于 **codex-cli 0.132.0**。

## 目录

- [1. 启用 codex 后端](#1-启用-codex-后端)
- [2. 前置条件（重要）](#2-前置条件重要)
- [3. 与 provider（模型层）的关系——不正交](#3-与-provider模型层的关系不正交)
- [4. 会话语义](#4-会话语义)
- [5. 权限映射](#5-权限映射)
- [6. 配额可观测与限额降级](#6-配额可观测与限额降级)
- [7. 当前限制（重要）](#7-当前限制重要)
- [8. ToS 姿态](#8-tos-姿态)
- [9. 何时该用 codex / 何时该留在 claude](#9-何时该用-codex--何时该留在-claude)

---

## 1. 启用 codex 后端

在 `disclaude.config.yaml` 的 `agent` 段设置：

```yaml
agent:
  agentBackend: "codex"     # agent 运行时（claude | pi | codex），默认 claude

  # 可选：显式沙箱级别（S4，#4631）。不设则按 permissionMode 推导：
  #   bypassPermissions（bot 默认）→ workspace-write
  #   default（ask）→ read-only（无头模式没有审批人，保守降级）
  # danger-full-access 只能通过此配置显式开启。
  # codexSandbox: "workspace-write"

  # 并发治理（S7，#4634）——每进程上限，默认 3 / 2：
  # codex:
  #   maxActiveSessions: 3    # 同时存活的 codex 会话数
  #   maxConcurrentRuns: 2    # 同时执行的 codex exec 子进程数
```

完整示例见 `disclaude.config.example.yaml`（搜索 `agentBackend`）。

加载时校验：`agentBackend` 非 `claude`/`pi`/`codex`、或 `codexSandbox` 非三个合法值时，`validateConfig()` 失败并给出可操作的错误信息（`packages/core/src/config/loader.ts`）。

## 2. 前置条件（重要）

仅改配置**不足以**让 codex 后端可用，还需在运行 disclaude 的机器上：

```bash
# 1. 安装 Codex CLI
npm install -g @openai/codex

# 2. 一次性交互式登录（Sign in with ChatGPT OAuth）
codex login
```

- 登录凭据由 codex 自己保存在 `~/.codex/auth.json`（`CODEX_HOME` 可重定位）。**disclaude 不存储、不解析、不刷新任何凭据**（仅探测 auth.json 是否存在做环境自检）。
- 登录过期/失效时（401），bot 会收到可操作的重新授权提示（`codex login`），不会静默失败。
- 网络要求：与 `api.openai.com` / `wss://api.openai.com` 的出站连通。

环境自检：provider 的 `validateConfig()` 会同步检查二进制在 PATH 上 + auth.json 存在（返回 boolean，不中断启动）；`getInfo().unavailableReason` 会分别给出安装提示与登录提示。缺前置条件时**不会自动回退 claude**——codex 仍是所选后端，首次查询即抛可操作错误。另：API-key 方式认证（`OPENAI_API_KEY`，不落 auth.json）的用户会收到登录提示，属当前探测的已知边界。

## 3. 与 provider（模型层）的关系——不正交

这是 codex 后端与 claude/pi 的**关键差异**（跟踪于 [#4637](https://github.com/hs3180/disclaude/issues/4637)）：

- claude/pi 后端：`agentBackend`（运行时）与 `provider`（LLM API）**正交可组合**（如 pi + GLM）。
- codex 后端：**LLM 与运行时绑定**。Codex CLI 既是 agent 运行时，又只从已登录的 ChatGPT 账户取模型——因此：
  - `glm.apiKey` / `agent.provider` / `ANTHROPIC_API_KEY` 在 codex 后端下**被忽略**；
  - 模型只能是该订阅可服务的型号（gpt-5.x family），传 GLM/Claude 模型名会在 CLI 内部报错。

选 codex 后端 = 选「用订阅额度当算力」，不是选「换一个模型供应商」。

## 4. 会话语义

- **多轮续接**：每个 chatId 一个会话。首个 turn 用 `codex exec` 开新 thread，后续 turn 自动 `codex exec resume <thread_id>` 续接同一会话（上下文跨 turn 保留）。
- **`/reset`**：清除该 chatId 的会话映射，下一条消息开新 thread。
- **空闲回收**：沿用 ChatAgent 的按 chatId 空闲清理（默认 30 分钟）——回收即断开，下条消息开新会话。
- **重启**：会话映射在内存中，进程重启后所有对话开新 thread（rollout 文件仍在 `~/.codex/sessions`，由 codex 自有管理，disclaude 不读不删）。
- **自愈**：resume 目标丢失（如 rollout 被清理）时自动降级为新会话并告知用户，无需手动 `/reset`。
- **磁盘与隐私**：续接需要会话落盘（S3 起 `--ephemeral` 已移除）——每个对话的完整内容会写进 `~/.codex/sessions/` 且**长期保留**（disclaude 与 codex CLI 默认都不清理）。长期运行的 bot 请知悉该增长，并考虑为 codex 后端设置独立的 `CODEX_HOME`（隔离 bot 会话与个人会话、便于按需清理）。
- **并发治理（S7，#4634）**：每进程默认最多 **3 个活跃会话**（`agent.codex.maxActiveSessions`）、**2 个并发 exec 子进程**（`agent.codex.maxConcurrentRuns`）。会话满时按 LRU 驱逐最闲的会话——**被驱逐的 chat 下一条消息自动续接原会话**（thread 锚点被暂存），只有用户主动 `/reset` 才真正开新会话。排队的 turn 会收到「⏳ 排队中，前面还有 N 个」提示，绝不静默。

## 5. 权限映射

codex `exec` 是无头模式，**没有逐调用的审批钩子**（0.132.0 实证：`codex exec -a` 直接报参数错误——审批轴只存在于交互 TUI）。disclaude 的权限策略因此映射到唯一可用的沙箱轴（`packages/core/src/sdk/providers/codex/sandbox-policy.ts`）：

| disclaude 策略 | codex 沙箱 |
|---|---|
| `permissionMode: bypassPermissions`（bot 默认/未设） | `workspace-write` |
| `permissionMode: default`（ask） | `read-only`（无审批人，保守降级） |
| 显式 `agent.codexSandbox` | 该级别（`danger-full-access` 的唯一入口） |
| disallowedTools 含变异类工具（`Bash`/`Write`/`shell`/`file_change`…） | 封顶 `read-only`，**压过显式覆盖**（安全策略 > 便利偏好） |
| disallowedTools 仅 claude 专属名（`EnterPlanMode`/`Cron*`…＝ChatAgent 默认列表） | 无影响（无对应能力即无效果） |
| disallowedTools 含 `WebSearch` | **拒绝运行**（见第 7 节限制） |

沙箱经 `-c sandbox_mode=<level>` 传递（fresh 与 resume 两种 argv 统一此形式；`-s` 被 `exec resume` 拒绝——0.132.0 实证）。`read-only` 的写入阻断已在两条路径上实测验证。

## 6. 配额可观测与限额降级

- **可观测**：每个完成的 turn 产生一条结构化 info 日志（`codex quota usage`），含当轮 input/cached/output/reasoning tokens 与进程级累计；Kibana/Loki 可直接检索。`getQuotaStats()` 已就绪；接入 `/status` 展示是后续工作（本 stack 不含）。
- **限额降级**：撞上 ChatGPT 滚动窗口限额（5 小时/周）时，用户收到友好提示（含 codex 自己的 "Try again at \<时间\>" 重置时间），而非原始报错。
- **免重启恢复**：限额失败的 turn 不改变会话锚点——窗口重置后**直接重发消息**即自动 resume 原会话，无需重启服务或 `/reset`。

## 7. 当前限制（重要）

1. **tools/MCP 映射未实现**：`createInlineTool` / `createMcpServer` 抛 not-supported（codex 有自己的 MCP 配置面，映射是 [#4627](https://github.com/hs3180/disclaude/issues/4627) 的开放问题）。落地前，disclaude 侧的 MCP 工具（如 Playwright MCP）在 codex 后端下**不可用**。
2. **LLM 供应商绑定**：见第 3 节（#4637）。glm/anthropic 配置静默忽略——后续会在 config 校验层显式告警。
3. **web_search 无法禁用**：0.132.0 实证 `-c tools.web_search=false` 与 `--disable web_search` 均无效。因此 denylist 含 `WebSearch` 时 codex 后端**拒绝启动查询**（可操作的报错），而不是静默违反策略。
4. **无逐调用审批**：见第 5 节。细于沙箱级别的「询问用户」语义在 codex 后端不可表达。
5. **事件 schema 随 CLI 版本漂移**：适配层按结构性镜像 + 未知事件容忍跳过设计（不炸桥），但行为实证锁定 0.132.0；升级 CLI 后建议跑冒烟（两轮记忆 + read-only 写入阻断）。
6. **模型名受限**：仅订阅可服务型号（gpt-5.x family）；`agent.model` 传其他家族名会在 CLI 内报错。

## 8. ToS 姿态

- **支持的形态**：**单一所有者**用自己的 ChatGPT 订阅做个人自动化。按 OpenAI 当期条款（[Codex 使用条款](https://openai.com/policies)），订阅额度包含 Codex 使用权；条款可能变化，以官方当期表述为准。disclaude 只是通过官方 CLI 非交互模式消费它。
- **明确不支持**（与父特性 [#4627](https://github.com/hs3180/disclaude/issues/4627) Non-goals 一致）：
  - **账户池化 / 多人共享一个订阅**（account pooling / group sharing）；
  - 社区「codex-to-api」代理（违反 ToS 且不稳定）。
- **风险自担**：高频饱和使用订阅额度可能触发 OpenAI 的限流或账户审查；请自行评估使用强度与 ToS 边界。本仓库不提供任何规避检测的手段。

## 9. 何时该用 codex / 何时该留在 claude

- **用 `codex`**：单人 bot 想把 ChatGPT 订阅当算力、任务**不依赖** disclaude 侧 MCP 工具（Playwright 等）与细粒度逐调用审批。
- **留在 `claude`（默认）**：生产环境、需要 MCP / 权限模式 / 多模型供应商组合（GLM 等）——这是功能最全的后端。
