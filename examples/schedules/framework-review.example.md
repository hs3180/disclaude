---
name: "Agent Framework 服务质量评估"
cron: "0 9 * * 1"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-04-18T00:00:00.000Z"
---

# Agent Framework 服务质量评估

每周一 09:00 分析各个 chat 的历史聊天记录，评估并对比不同 Agent 框架/模型的服务质量。

**关联 Issue**: #1334

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 执行步骤

### 1. 获取所有聊天日志文件

```bash
ls workspace/logs/**/*.md 2>/dev/null || echo "No log files found"
```

如果 `workspace/logs/` 目录不存在或为空，跳过本次执行。

### 2. 读取聊天日志

使用 `Glob` 工具查找所有日志文件：
```
Glob workspace/logs/**/*.md
```

筛选最近 7 天的日志文件，使用 `Read` 工具读取内容。

### 3. 识别 Agent 框架信息

对每段对话，识别：
- **Provider**: `anthropic`, `openai`, `google` 等
- **Model**: 具体模型名称
- **Agent 类型**: skill agent, task agent, chat agent 等
- **任务类型**: 编码、分析、写作、问答等

### 4. 多维度评估

| 维度 | 指标 | 数据来源 |
|------|------|---------|
| ⚡ 响应效率 | 消息间隔时间 | 时间戳 |
| ✅ 任务完成度 | 完成率 | 对话轮次 + 结果 |
| 😊 用户满意度 | 正面/负面反馈 | 用户反馈关键词 |
| 🔧 工具使用效率 | 调用次数/相关性 | 工具调用记录 |
| ❌ 错误率 | 失败/重试 | 错误日志 |

### 5. 识别独特特性

分析各框架无法量化的独特能力和特殊交互风格。

### 6. 生成报告

按照 `framework-review` skill 中定义的格式生成评估报告。

### 7. 保存历史数据

追加到 `workspace/data/framework-review-history.json`。

### 8. 发送报告

使用 `send_user_feedback` 发送报告。

## 错误处理

1. 日志文件读取失败 → 跳过该文件
2. `send_user_feedback` 失败 → 重试一次
3. 历史数据文件损坏 → 创建新文件
4. 无可分析数据 → 发送简要状态报告

## 关联

- **Issue**: #1334 (Agent Framework 赛马)
- **Skill**: `framework-review`
- **参考**: `daily-chat-review` skill 模式
