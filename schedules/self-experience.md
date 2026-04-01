---
name: "自我体验 (Dogfooding)"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-02T00:00:00.000Z"
---

# 自我体验定时任务

每周一上午 10:00 自动执行一次自我体验，模拟用户交互并生成体验报告。

## 执行步骤

### 1. 发现可用功能

读取所有可用的 skill 和 MCP 工具：

```bash
ls skills/
ls packages/mcp-server/src/tools/
```

构建功能清单，确定测试优先级。

### 2. 设计测试场景

基于功能清单设计 3-5 个测试场景，覆盖：
- 正常使用路径（Happy Path）
- 边缘情况（Edge Cases）
- 多功能组合
- 用户体验评估

**重要**: 检查 `workspace/data/self-experience-history.jsonl` 避免重复测试。

### 3. 执行模拟体验

对每个场景：
- 分析相关 skill/tool 的实现代码
- 检查最近的交互日志中的类似场景
- 评估响应质量（准确性、完整性、清晰度、错误处理）

### 4. 生成体验报告

按照 self-experience skill 的报告模板生成结构化报告。

### 5. 发送报告

使用 `send_user_feedback` 发送报告到当前 chatId：

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{experience_report}"
})
```

### 6. 处理发现的问题

- 🟡 中等问题：记录在报告中，建议改进方向
- 🔴 严重问题：通过 `gh issue create` 创建 GitHub Issue（需脱敏）

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的聊天群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整时间（默认每周一 10:00）

## 错误处理

1. 如果功能发现失败，基于 git log 近期变更确定测试范围
2. 如果日志读取失败，跳过日志分析环节，直接基于代码分析
3. 如果 `send_user_feedback` 失败，将报告写入 `workspace/data/self-experience-report-latest.md`
