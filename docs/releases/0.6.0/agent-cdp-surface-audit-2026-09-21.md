# 0.6.0 Agent 浏览器入口与 CDP 文档范围审计

> 日期：2026-09-21
> 基线：`origin/main` / `d6be9e5e`
> 类型：发现记录，不是修复提交，也不是发布通过声明。

## 结论

当前运行时代码已经在协调模式下通过 `browserAgentEnv()` 清除 Agent 子进程的
`BU_CDP_*`、`CHROMIUM_CDP_*`、浏览器直连和上游 daemon 环境，并强制保留私有
IPC socket/launcher。`skills/browser-use/SKILL.md`、README 的主入口说明和
协调器测试也把 IPC 作为 Agent 入口。

但 `docs/cdp-endpoint.md` 仍保留一组会被读者当作可执行说明的旧 CDP 入口：
它要求把 `BU_CDP_URL`/`BU_CDP_WS` 交给 browser-use，描述 Agent 侧 attach/fallback
语义，并把没有 endpoint 时的 native self-launch 说成默认行为。文件顶部虽然标记
为 service-internal，但正文仍与 0.6.0 的 Agent IPC-only 约束冲突。这是文档/验收
入口不一致，不据此推断运行时已经旁路连接 CDP。

## 现状证据

- `packages/core/src/utils/browser-env.ts` 在有协调 socket 时清除 `BU_CDP_*`、
  `CHROMIUM_CDP_*`、`DISCLAUDE_CHROMIUM_*`、daemon/runtime 变量，并设置
  `BH_RUNTIME_DIR=/dev/null`、`BH_REQUIRE_EXISTING_DAEMON=1`。
- `skills/browser-use/SKILL.md` 要求从协调器 IPC launcher 执行，明确禁止直接
  连接 CDP；`README.md` 的 Agent 段落也明确禁止 Agent 接收 CDP URL/端口。
- `docs/cdp-endpoint.md` 的以下活跃段落仍直接给出旧入口或旧默认行为：
  `Endpoint contract`、`Pointing drivers at the endpoint`、
  `Skill ↔ CDP configuration contract` 以及 `BU_CDP_URL` 无配置时的 self-launch
  说明。历史矩阵和服务内部的 nginx/CDP 诊断可以保留，但不能继续作为 Agent
  配置指导。
- `.env.example` 和 `docs/browser-coordination.md` 中的 `BU_CDP_URL` 说明属于
  service/operator 配置（例如 existing-browser 模式），不能简单删除；修复必须
  明确其不会进入 Agent harness，而不是破坏协调器对受管服务的内部连接。

## 验收缺口

需要一个独立修复 PR，直接基于 `main`：

1. 将 `docs/cdp-endpoint.md` 收敛为 Docker/Chromium 服务内部的 CDP wiring 和
   operator diagnostics；移除或改写 Agent attach、self-launch、Skill 配置和
   端点切换说明。
2. 保留浏览器服务自身所需的端口、nginx、`/json/version`、WS upgrade 和故障
   诊断说明，并明确这些不是 Agent API。
3. 增加针对 release-facing 文档的回归检查，防止重新出现 `BU_CDP_URL`、
   `BU_CDP_WS` 或 direct-CDP Agent 指引；检查应允许 service/operator 配置和
   历史验收证据中的受限命中。
4. 用当前提交重新运行文档/架构检查及浏览器 IPC 单测；真实产品入口、竞争、
   broker 故障和跨平台迁移仍须以已有的当前提交证据单独核对，不能由文档修复
   代替。

发现与修复必须保持两个独立 PR，修复 PR 不以本发现分支为 base，也不因此关闭
#5014/#5002 的真实验收门槛。
