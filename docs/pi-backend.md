# Pi 后端（agentBackend）指南

Disclaude 的 Agent 运行时（agent runtime）可通过配置切换。默认使用 `claude`（claude-code CLI）；本页介绍如何启用 `pi` 后端（[earendil-works/pi](https://github.com/earendil-works/pi) agent 运行时），以及它当前的边界。

> 配置项随 Issue [#4388](https://github.com/hs3180/disclaude/issues/4388) / PR [#4406](https://github.com/hs3180/disclaude/pull/4406) 落地。父特性：[#4383](https://github.com/hs3180/disclaude/issues/4383)。

## 目录

- [1. 什么是 agentBackend](#1-什么是-agentbackend)
- [2. 与 provider（模型层）的关系](#2-与-provider模型层的关系)
- [3. 启用 pi 后端](#3-启用-pi-后端)
- [4. 校验与回退](#4-校验与回退)
- [5. 当前限制（重要）](#5-当前限制重要)
- [6. 何时该用 pi / 何时该留在 claude](#6-何时该用-pi--何时该留在-claude)
- [7. 验证记录（实验）](#7-验证记录实验)

---

## 1. 什么是 agentBackend

`agentBackend` 选择 Disclaude 启动时加载的 **Agent SDK 运行时**：

| 值 | 运行时 | 说明 |
|---|---|---|
| `claude`（默认） | claude-code CLI | 生产默认，功能最全（含 MCP、权限模式等） |
| `pi` | earendil-works/pi | 替代 agent 运行时，用于实验/对比；部分能力仍在补齐（见第 5 节） |

启动时 `PrimaryNode` 会读取 `Config.AGENT_BACKEND`，在首个 `ChatAgent` 创建之前调用 `setDefaultProvider(agentBackend)`，从而决定后续所有 agent 走哪个后端。

## 2. 与 provider（模型层）的关系

`agentBackend` 与 `provider` **正交、互不冲突**，二者组合使用：

- `provider`（`anthropic` / `glm`）选的是 **LLM API**（模型调用层）。
- `agentBackend`（`claude` / `pi`）选的是 **agent 运行时**（编排/工具循环层）。

例如可以「pi 后端 + GLM 模型」同时使用。配置里两者分属不同字段，互不覆盖。

## 3. 启用 pi 后端

在 `disclaude.config.yaml` 的 `agent` 段设置（默认注释掉，取消注释即启用）：

```yaml
agent:
  provider: "glm"          # 模型层（anthropic | glm），与 agentBackend 正交
  agentBackend: "pi"        # agent 运行时（claude | pi），默认 claude
  model: "glm-4.7"
```

完整示例见 `disclaude.config.example.yaml`（搜索 `agentBackend`）。

> **前置条件（重要）**：仅改配置不足以让 pi 真正可用。pi 后端还要求运行环境满足：
> - 实际可导入的包是 **`@earendil-works/pi-agent-core`**（上方链接的 `earendil-works/pi` 是 monorepo，被 import 的子包才是它）。pi provider 用 `createRequire(import.meta.url).resolve('@earendil-works/pi-agent-core')` 在运行时探测它（`packages/core/src/sdk/providers/pi/provider.ts`）。
> - 通过 `pi-ai` 配好模型 provider 的 API key。
>
> **未满足时不会崩溃，也不会自动回退 claude**——pi 仍被选为默认后端，但其方法（agent loop / MCP）在调用时抛 not-implemented（详见第 4、5 节）。可用 `getAvailableProviders()` 查看 `pi` 的 `available` 字段确认是否就绪。

## 4. 校验与回退

- **取值校验（加载时）**：`packages/core/src/config/loader.ts` 的 `validateConfig()` 校验 `agent.agentBackend`；非 `claude`/`pi` 时返回失败并记录错误，例如：`agent.agentBackend must be one of: claude, pi (got "...")`。
- **未知后端名 → 回退 claude（启动时）**：`PrimaryNode.start()` 用 `setDefaultProvider(agentBackend)` 设默认后端；传入**未注册**的后端名会抛 `Unknown provider type: ... Available: claude, pi`，`PrimaryNode` 捕获后**不崩溃、回退 `claude`**（日志 `Unknown agent.agentBackend in config — falling back to "claude"`）。
- **⚠️ 注意：pi 缺前置条件 *不会* 触发上述回退**。`pi` 已在工厂表中硬注册（`packages/core/src/sdk/factory.ts`），故 `setDefaultProvider('pi')` 总是成功、pi 成为默认后端。当 `@earendil-works/pi-agent-core` 未安装 / `pi-ai` key 缺失时，pi 的 `validateConfig()` 返回 `false`、`getInfo().available === false`，但**启动照常以 pi 为默认**，直到首次调用 agent loop / MCP 才抛 not-implemented（见第 5 节）。即：缺前置条件 = 运行期方法报错，**而非**静默回退 claude。

## 5. 当前限制（重要）

pi 后端目前是「已可注册、能力受限」状态。切换前请知悉：

1. **MCP 非原生**：pi 后端尚无原生 MCP 支持。Disclaude 重度依赖的 MCP（如 Playwright MCP、内联工具）在 pi 后端下**不可用**，需由适配层桥接——该工作跟踪于 [#4417](https://github.com/hs3180/disclaude/issues/4417)（createMcpServer 适配器），落地前 pi 后端无法驱动 MCP 工具。
2. **无内置权限系统**：pi 运行时本身不带权限门控（与 claude-code 的 `permissionMode` 不同）。pi 后端的权限补齐跟踪于 [#4389](https://github.com/hs3180/disclaude/issues/4389)，落地前请勿在 pi 后端上依赖细粒度权限控制。

> 这两项会随 #4417 / #4389 的推进更新；本页描述以它们当前（open）状态为准。

## 6. 何时该用 pi / 何时该留在 claude

- **用 `pi`**：想体验/对比 earendil-works/pi 运行时、做后端可替换性验证、且当前任务**不依赖 MCP 工具与权限门控**。
- **留在 `claude`（默认）**：生产环境、或任务需要 MCP（浏览器自动化等）/ 权限模式时——这是功能最全的后端。

## 7. 验证记录（实验）

为确认本页描述与代码一致，编写一次性脚本直接调用 `@disclaude/core` 的真实模块（`config/loader.ts` 的 `validateConfig`、`sdk/factory.ts` 的注册表与 `setDefaultProvider`、`sdk/providers/pi/provider.ts` 的 `PiAgentProvider`），对各项断言实测。测试环境：**未安装** `@earendil-works/pi-agent-core`（即模拟「缺前置条件」的常见情形）。

结果 **14 项断言全部通过**，关键观测值如下（合并展示）：

| 断言（对应章节） | 实测结果 |
|---|---|
| `validateConfig`：`'pi'`/`'claude'` → true；缺省 → true（跳过）；`'bogus'` → false（§3、§4 校验） | ✅ bogus 失败，错误串含 `must be one of: claude, pi` |
| `setDefaultProvider('pi')` 成功，默认后端变为 pi（§1） | ✅ `getDefaultProviderType() === 'pi'` |
| `setDefaultProvider('bogus')` 抛错并列出可用项（§4 回退） | ✅ `Unknown provider type: bogus. Available: claude, pi` |
| `getProvider('pi')` 是 `PiAgentProvider` | ✅ name=`pi`，version=`0.0.0-skeleton` |
| 注册表同时含 claude 与 pi（§1） | ✅ `[claude(available=true), pi(available=false)]` |
| `pi.createMcpServer()` 抛错（§5 MCP 非原生，#4417） | ✅ `... not implemented yet ... tools/MCP in #4387 (S4)` |
| 未装 pi-ai 时 `pi.validateConfig()` → false（§3 前置条件） | ✅ false |
| `pi.getInfo().available === false` 且原因提及 pi-agent-core | ✅ reason=`pi-agent-core package not installed or not configured` |
| pi 无 permission 相关 API（§5 无权限系统，#4389） | ✅ 原型方法仅 `getInfo / queryStream / createInlineTool / createMcpServer / validateConfig / dispose` |
| `provider=glm + agentBackend=pi` 同时通过校验（§2 正交） | ✅ true |
| `provider=anthropic + agentBackend=claude` 同时通过校验（§2 正交） | ✅ true |

> 断言「注册表 `[claude(available=true), pi(available=false)]`」与「`pi.validateConfig()===false`」直接支撑了第 4 节的关键结论：**pi 已注册、会被选为默认后端，但 `available=false`——缺前置条件不会触发 claude 回退**。脚本为一次性验证用，未随 PR 提交；如需复现，按本节所述导入上述三个模块即可。
