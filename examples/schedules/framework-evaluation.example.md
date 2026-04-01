---
name: "Agent Framework 周度评估"
cron: "0 9 * * 1"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-04-02T00:00:00.000Z"
---

# Agent Framework 周度评估

每周一 09:00 分析过去一周的聊天记录，评估 Agent 服务质量，生成对比报告。

**关联 Issue**: #1334

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 执行步骤

### 1. 收集聊天日志

使用 `Glob` 工具查找最近 7 天的日志文件：

```
Glob workspace/logs/**/*.md
```

过滤出最近 7 天的日志文件（根据文件名中的日期判断）。

如果 `workspace/logs/` 目录不存在或为空，跳过本次执行并发送通知。

### 2. 加载 framework-evaluation Skill

在分析开始前，加载 `framework-evaluation` skill：

```
使用 framework-evaluation skill 进行分析
```

### 3. 执行分析

按照 `framework-evaluation` skill 的指引执行分析：

1. 读取所有相关日志文件
2. 按聊天分组分析
3. 提取各维度指标
4. 生成跨聊天对比报告

### 4. 发送报告

使用 `send_user_feedback` 将评估报告发送到配置的 chatId。

## 评估维度

| 维度 | 指标 | 数据来源 |
|------|------|----------|
| 响应效率 | 平均响应时间 | 消息时间戳 |
| 任务完成度 | 完成率 | 任务结束信号 |
| 用户满意度 | 好评/差评比 | 反馈关键词 |
| 工具使用效率 | 平均调用次数/任务 | 工具调用记录 |
| 错误率 | 错误占比 | 错误消息 |
| 多轮效率 | 平均轮次/任务 | 消息计数 |

## 自定义配置

### 调整评估周期

修改 prompt 中的时间范围：
- 周报（默认）: "分析过去 7 天"
- 双周报: "分析过去 14 天"
- 月报: "分析过去 30 天"

### 添加关注重点

在 prompt 中指定需要重点关注的维度：
- "重点关注响应效率和错误率"
- "重点关注用户满意度趋势"
- "对比不同聊天类型的表现差异"

## 验收标准 (来自 Issue #1334)

- [x] 零代码侵入 — 不修改 BaseAgent 或核心代码
- [x] 基于聊天记录分析 — 复用现有日志
- [x] 定时执行 — 通过 scheduler 机制
- [x] 多维度评估 — 响应效率、完成度、满意度等
- [x] AI 驱动分析 — 由 Agent 自主解读数据
- [x] 可扩展 — 评估标准和维度可灵活调整

## 关联

- **Issue**: #1334 (Agent Framework 赛马)
- **依赖 Skill**: framework-evaluation
- **参考 Skill**: daily-chat-review
