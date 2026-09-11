# 并行 PR 集成注意事项（2026-09-09 历史存档）

原 #4881 的集成不变量和事故记录保留于此。下文的凭证、授权、CI、合并顺序和待办状态均是当时记录，**不代表当前阻塞项**。2026-09-10 的最新状态统一见 [RC 记录](release-candidate.md)。#4869 的 launchd 实现及进一步加固由 #4884 承接；#4881 的文档交接也由 #4884 承接。

这是评审/合并指南，不是授权自动合并。每个 PR 仍须独立评审；本次组合只发生在本地 `test/050-local-integration` 分支，未推送 main。

## 依赖与顺序

- #4858 动态地址 → #4869 launchd 隔离、#4870 REST ready 后启调度。
- #4857 运行时预设 → #4875 原生话题 session key、#4876 callbacks 释放。
- 既有 #4851 脚本调度 → #4874 进程生命周期 → #4878 停机/并发取消身份。
- #4873 app-server 传输 → #4877 provider/thread/turn 生命周期；#4863 基础控制 → #4880 异步 ACK 命令接点。两条组合后才具备可选 app-server `/steer`，默认 exec 不支持该能力，不把 queue 冒充 steer。
- #4853 证据结构 gate → #4879 真实 commit、canonical 要求与路径范围加固。
- #4871 的 Codex 回收竞态修复应进入最终候选，不能仅重跑原间歇失败用例后忽略缺陷。

## 已验证的冲突处理原则

| 交叉点 | 保留内容 / 不变量 |
|---|---|
| #4857 + #4863 的 control 注册、normalize、类型和 cli-main | 保留 `agent` 与 `steer` 两套分支/回调，不能取单边覆盖 |
| #4867 + #4875 的 AgentCreateOptions/ChatAgentConfig | 只保留一个同名 `sdkSessionKey?: string`；普通 chat 用 chatId、话题用复合键、scheduled tick 用执行唯一键；投递/历史/project 查找仍用真实 chatId |
| #4867 + #4857 的 pool import | 合并 ModelTier 和 preset 所需类型/函数，不删除任何运行时配置来源 |
| #4867 + #4851/#4874 的 watcher | 同时验证 fresh/skip/clearContext 迁移语义和 prompt/script 恰一项；script 不进入 LLM router |
| 同上 scheduler | script 在独立分支执行；只有 prompt 路径带 scheduleSession；保留真实 turn settlement 与 script cancellation 的不同超时语义 |
| 同上 schedule skill | 保留 script 字段和新 fresh/skip 说明，不恢复“clearContext 重置用户 agent”的旧描述；script timeout 杀进程，prompt timeout 仅停止等待 |
| 已合并 squash PR 与原 feature commits 交叉 | 对照行为和最终差异，不因提交 ID 不同就复制旧实现；gate 的 add/add 采用 #4879 的完整加固版 |

## 证据边界

本地组合曾在 `b56d972f37d9df78fd39fb17a5813fe931f8e1cc` 通过 4520 项测试与 90.4% statements/lines coverage；后续 `35177cc1b04203ed1cf1e3b28c9c7c1e29c3c645` 通过 4548 项测试。它们只证明各自 SHA，不能自动转用于后续接线补丁。

加入 #4878/#4879 后，`88f4c81768af9f5ff045c94807874c8af53d5d95` 的 210 文件 / 4554 测试与 coverage 通过（statements/lines 90.4%、branches 89.18%、functions 93.53%）；后续 app-server provider/命令尚未包含在此结果中。

最终组合 `353e24783f0ca2c9363cf8a18aa006c24e860964` 包含 #4877 `212b3c49` 与 #4880 `8e74f3bc`。`npm run type-check`（含 build）、`npm run lint`、`npm run test:coverage -- --silent` 全部退出 0；211 文件 / 4565 测试通过，statements/lines 90.35%、branches 88.97%、functions 93.43%。测试使用隔离 fixture，不调用真实模型或飞书。日志保留在本机 `/tmp/disclaude-050-parallel.FLfRz1/final-{type,lint,coverage}.log`；临时路径不是永久 CI artifact，最终候选仍须重新执行并归档证据。

一轮测试因 ENOSPC 未能启动，不计入通过或产品断言失败。已仅删除本次已完成临时 worktree 的可重装 node_modules，保留源码、提交与日志；释放空间后的组合测试重新执行。

当前 CI 的 pull_request base filter 只包含 main/master，stacked PR 无 checks。workflow 修复提交 `e2d301d8` 因 GitHub App 无 workflows 权限未推送、未开 PR。维护者需要带入该修复，或在前置合并后 retarget 并重新等待 CI；不可把缺检查当成功。

结构 gate 不执行测试，不证明任意 passed/observed 文本真实。最终候选需由可信 runner 生成记录及完整输出，由人工核对真实后端工具产物、渠道回执和隔离部署证据。外部验收缺口和 launchd 事故见 [PARALLEL-STATUS.md](PARALLEL-STATUS.md)。
