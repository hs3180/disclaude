# 群聊管理可选 E2E 集成测试设计

本方案为 Issue #4756 定义一套默认不执行、显式启用的群聊管理端到端测试。测试覆盖资源创建、消息归属、agent 生命周期和清理；不改变默认单元测试或现有集成测试。

## 运行模式与安全门禁

测试分为两层：

| 层级 | 外部依赖 | 默认状态 | 目的 |
| --- | --- | --- | --- |
| contract/mock | 无 Feishu 凭据；HTTP/channel 使用 stub | 默认运行 | 验证请求参数、状态机、重试和清理编排 |
| Feishu smoke | 隔离租户/测试群；真实 channel API | 默认跳过 | 验证真实群、thread、消息和 agent 闭环 |

真实 smoke 只有在同时满足以下条件时运行：

```bash
DISCLAUDE_GROUP_E2E=1
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
FEISHU_E2E_PARENT_CHAT_ID=...
```

`FEISHU_E2E_PARENT_CHAT_ID` 必须指向专用测试群。测试启动时为每次运行生成带 run ID 的子群/资源前缀；禁止使用生产群，也不接受默认 chat ID。CI 中建议把 smoke 放在手动 workflow 或 nightly job，并将凭据存为 secret。

## 测试矩阵

| 场景 | 层级 | 主要断言 | 诊断关联 |
| --- | --- | --- | --- |
| 创建隔离群并识别 | mock + smoke | chat 创建成功，返回 chatId 可复用 | runId、chatId |
| 配置成员 | mock + smoke | 成员添加/重复添加/权限拒绝均有明确结果 | runId、chatId、memberId、errorCode |
| 普通消息 | mock + smoke | 文本发送到正确 chat，保存 outgoing messageId | chatId、messageId |
| thread/topic 消息 | mock + smoke | parentMessageId 原样传递且不串群 | chatId、messageId、parentMessageId |
| agent 生命周期 | mock + smoke | start → progress → final 的状态与 channel 投递一致 | runId、agentId、sourceMessageId |
| 独立执行群 | mock + smoke | 创建、发布上下文、完成后清理均可追踪 | runId、chatId、agentId |
| 超时后重试 | mock + smoke | 首次超时分类明确，重试只产生一个最终结果 | attempt、idempotencyKey |
| 重复投递 | mock | 相同 source message 只 dispatch 一次 | sourceMessageId、dedupKey |
| 权限不足 | mock + smoke | 错误可见、主流程结束、清理仍执行 | errorCode、cleanupStatus |
| 清理失败 | mock + smoke | 尽力清理并输出残留资源清单 | chatId、resourceId、cleanupStatus |

## 稳定 happy path

1. 生成 `runId` 和幂等键，创建隔离执行群。
2. 添加测试 bot 与最小测试成员集合，读取并断言成员列表。
3. 发送普通消息，记录返回的 `messageId`。
4. 发送带 `parentMessageId` 的 thread 消息，断言父子消息属于同一 chat/thread。
5. 启动 agent，注入固定 mock 响应，等待 terminal 状态。
6. 断言最终 channel 投递成功，且实际 outgoing messageId 已记录。
7. 按逆序删除消息、移除成员、解散执行群；每一步都写入 cleanup ledger。

任何断言失败都保留 `runId`、chatId、messageId、agentId 和服务日志；cleanup 使用 `try/finally`，并在失败时继续后续清理步骤。

## 失败与重试场景

contract 测试模拟 channel 在首次发送时返回 timeout，第二次成功：

- 使用固定 `idempotencyKey = runId + operation`，重试不得创建第二个群或第二条最终消息。
- 记录每次 attempt 的开始时间、目标、错误分类和 fallback 路径。
- 若达到重试上限，agent 必须收到明确失败结果，测试仍进入清理阶段。
- 模拟无权限添加成员和解散群失败，断言主流程返回可诊断错误，且最终报告包含未清理资源。

## 输出契约

每个 case 输出一行结构化事件，至少包含：

```text
runId, caseId, phase, chatId, threadId, parentMessageId,
sourceMessageId, outgoingMessageId, agentId, attempt,
status, errorCode, cleanupStatus
```

`sourceMessageId` 是输入消息，`outgoingMessageId` 是 channel 成功返回的消息；两者不可混用。敏感凭据、access token 和完整消息正文不得写入输出。

## 实现边界与清理协议

- mock 层只验证 adapter/编排契约，不依赖网络或本机运行中的生产服务。
- smoke 层复用 channel REST/CLI 的公开入口，不直接调用内部 Feishu SDK。
- 每个资源注册到 test resource tracker；测试退出、超时和异常时统一执行 cleanup。
- 清理操作必须幂等：资源不存在视为已清理，权限错误则记录为 `cleanup_failed`。
- 测试 runner 在退出前打印清理摘要；有残留资源时返回非零退出码，但不隐藏原始断言失败。
- 默认 runner 不读取真实凭据；只有 `DISCLAUDE_GROUP_E2E=1` 且所有门禁满足时才加载 smoke 配置。

## 建议的落地入口

建议新增 `tests/e2e/group-management/`，包含：

- `contract.test.ts`：mock channel、agent 和资源 tracker，覆盖 happy path、超时重试、重复投递、权限失败和清理失败。
- `smoke.test.ts`：复用同一 case 表，仅在显式门禁满足时执行真实 Feishu smoke。
- `vitest.config.ts`：单独配置超时、串行执行和 `tests/setup.ts` 清理钩子。
- `README.md`：记录权限、隔离群准备、运行命令、日志字段和残留资源处理。

推荐命令：

```bash
npx vitest --config tests/e2e/group-management/vitest.config.ts --run
DISCLAUDE_GROUP_E2E=1 npx vitest --config tests/e2e/group-management/vitest.config.ts --run
```

第一条命令只运行 contract/mock；第二条命令仍需通过全部凭据与隔离群门禁才会执行 smoke。
