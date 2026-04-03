---
name: "Framework 赛马报告"
cron: "0 9 * * 1"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-03T00:00:00.000Z"
---

# Agent Framework 赛马 — 每周分析

每周一 9:00 自动分析所有聊天记录，对比不同模型/Provider 的服务质量，生成赛马报告。

## 执行步骤

### 1. 发现聊天记录

```bash
ls workspace/logs/ 2>/dev/null || echo "No logs directory"
```

如果 `workspace/logs/` 目录不存在或为空，跳过本次执行。

### 2. 使用 framework-race skill 执行分析

按照 `framework-race` skill 的流程执行完整分析：

1. 扫描所有聊天记录文件（`workspace/logs/**/*.md`）
2. 提取服务质量指标（响应效率、任务完成度、用户满意度、工具效率、错误率）
3. 识别各模型/Provider 的独特优势
4. 生成结构化对比报告

### 3. 发送报告

使用 `send_user_feedback` 将报告发送到配置的 chatId：

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{race_report}"
})
```

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的接收报告的群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整执行时间（默认每周一 9:00）

## 分析周期

| 周次 | 分析范围 | 说明 |
|------|---------|------|
| 每周一 | 最近 7 天 | 默认周报 |
| 每月末 | 最近 30 天 | 如需月报，可手动调整 `--period=30d` |

## 错误处理

1. 如果聊天记录读取失败，跳过该文件继续处理
2. 如果 `send_user_feedback` 失败，记录日志并重试一次
3. 如果数据量不足（< 5 次对话），发送简略报告并标注"数据量不足"
4. 如果无法识别模型信息，发送整体服务质量报告（无模型对比）

## 示例输出

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: 2026-04-07 09:00
**分析范围**: 2026-04-01 ~ 2026-04-07
**分析聊天数**: 42
**涉及模型**: Claude Sonnet 4, GPT-4o

---

### 📊 综合评分
| 模型 | 响应效率 | 任务完成度 | 用户满意度 | 工具效率 | 错误率 | 综合 |
|------|---------|-----------|-----------|---------|-------|------|
| Claude Sonnet 4 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | 🥇 |
| GPT-4o | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 🥈 |

...（完整报告）
```
