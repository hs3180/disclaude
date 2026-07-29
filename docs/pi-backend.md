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

## 4. 校验与回退

- **校验**：配置加载时（`packages/core/src/config/loader.ts`）会校验 `agent.agentBackend` 的取值；非 `claude`/`pi` 会抛出明确错误，列出已注册的后端供修正。
- **回退**：若运行时注册失败（如 pi 后端未注册或加载出错），`PrimaryNode` 不会崩溃，而是记日志后**回退到默认 `claude` 后端**继续启动。日志关键词：`Agent SDK backend selected from config` / `Unknown agent.agentBackend ... falling back to "claude"`。

## 5. 当前限制（重要）

pi 后端目前是「已可注册、能力受限」状态。切换前请知悉：

1. **MCP 非原生**：pi 后端尚无原生 MCP 支持。Disclaude 重度依赖的 MCP（如 Playwright MCP、内联工具）在 pi 后端下**不可用**，需由适配层桥接——该工作跟踪于 [#4417](https://github.com/hs3180/disclaude/issues/4417)（createMcpServer 适配器），落地前 pi 后端无法驱动 MCP 工具。
2. **无内置权限系统**：pi 运行时本身不带权限门控（与 claude-code 的 `permissionMode` 不同）。pi 后端的权限补齐跟踪于 [#4389](https://github.com/hs3180/disclaude/issues/4389)，落地前请勿在 pi 后端上依赖细粒度权限控制。

> 这两项会随 #4417 / #4389 的推进更新；本页描述以它们当前（open）状态为准。

## 6. 何时该用 pi / 何时该留在 claude

- **用 `pi`**：想体验/对比 earendil-works/pi 运行时、做后端可替换性验证、且当前任务**不依赖 MCP 工具与权限门控**。
- **留在 `claude`（默认）**：生产环境、或任务需要 MCP（浏览器自动化等）/ 权限模式时——这是功能最全的后端。
