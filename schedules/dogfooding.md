---
name: "Dogfooding 自检"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-17T00:00:00.000Z"
---

# Dogfooding Periodic Self-Test

每周一 10:00 自动执行系统自检，发现能力、检查健康状态、生成报告。

## 执行步骤

### 1. 调用 dogfooding skill

使用 `dogfooding` skill 执行完整的自我检测流程：

skill 会自动执行以下检查：
1. 发现所有已注册的 skills 和 schedules
2. 评估每个 skill 的质量（描述、工具、指令完整性）
3. 检查构建和 lint 状态
4. 模拟用户场景测试能力匹配
5. 生成结构化报告

### 2. 报告发送

skill 会通过 `send_user_feedback` 自动将报告发送到当前 chatId。

## 配置说明

使用前需要修改：
1. `chatId`: 替换为接收报告的聊天 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整频率（建议不低于每周一次）

## 频率建议

| 频率 | Cron 表达式 | 适用场景 |
|------|------------|----------|
| 每日 | `0 10 * * *` | 活跃开发期 |
| 每周 | `0 10 * * 1` | 稳定维护期（默认） |
| 每两周 | `0 10 1,15 * *` | 低活跃期 |

## 错误处理

1. 如果 skill 调用失败，记录日志并跳过本次
2. 如果构建检查失败，在报告中标记为 critical
3. 如果发送报告失败，记录到 workspace/logs/
