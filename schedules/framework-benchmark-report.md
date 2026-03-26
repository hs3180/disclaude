---
name: "Agent Framework 赛马报告"
cron: "0 9 * * 1"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-03-27T00:00:00.000Z"
---

# Agent Framework 赛马周报

每周一早上 9 点分析过去一周的聊天记录，生成 Agent Framework/Model 性能对比报告。

> **设计原则**: 零代码侵入 — 不修改核心 Agent 代码，完全基于外部分析。

## 执行步骤

### 1. 收集聊天记录

```bash
ls workspace/logs/ 2>/dev/null || echo "No logs directory found"
```

如果 `workspace/logs/` 目录不存在或为空，跳过本次执行。

### 2. 读取并分析聊天记录

使用 `framework-benchmark` skill 的分析流程：

1. 使用 `Glob` 查找所有日志文件: `workspace/logs/**/*.md`
2. 使用 `Read` 读取最近 7 天的日志文件
3. 从聊天记录中提取以下维度：
   - **响应效率**: 从消息时间戳计算响应时间、多轮交互效率
   - **任务完成度**: 分析任务是否被成功完成（测试通过、PR 创建、答案被接受等）
   - **用户满意度**: 识别正面反馈（"谢谢"、"可以了"）和负面反馈（"不对"、"重来"）
   - **工具使用效率**: 统计工具调用次数与任务复杂度的关系
   - **错误率**: 统计任务失败、重试、超时等异常情况
   - **独特特性**: 识别各模型独有的优势（无法量化的定性差异）

### 3. 识别 Provider/Model 信息

从聊天记录中提取或推断使用的模型信息：
- 查找模型名称引用（"Claude"、"GPT"、"GLM"、"Gemini" 等）
- 从响应风格和模式推断模型类型
- 如果无法确定具体模型，报告整体 Agent 表现

### 4. 生成赛马报告

按照 `framework-benchmark` skill 的报告模板生成结构化报告，包含：
- 各模型在各维度的量化对比表格
- 独特特性分析（非赛马部分）
- 与上周的趋势对比（如有历史数据）
- 模型选择建议

### 5. 发送报告

使用 `send_user_feedback` 将报告发送到配置的 chatId。

### 6. 记录分析结果

将分析结果追加到 `workspace/data/benchmark-history.json`：

```json
{
  "history": [
    {
      "date": "2026-03-27T09:00:00.000Z",
      "chatsAnalyzed": 12,
      "messagesAnalyzed": 350,
      "models": ["claude", "gpt-4o"],
      "topPerformer": {
        "coding": "claude",
        "research": "gpt-4o",
        "overall": "claude"
      },
      "completionRate": 0.85,
      "satisfactionScore": 0.78
    }
  ]
}
```

## 数据不足时的处理

如果聊天记录不足以生成有意义的对比：
- 至少需要 3 个包含 Agent 交互的聊天
- 如果数据不足，发送简要说明并建议扩大分析范围
- 如果只检测到单一模型，生成单模型表现报告

## 错误处理

1. 如果日志文件读取失败，跳过该文件继续处理其他文件
2. 如果 `send_user_feedback` 失败，记录日志并重试一次
3. 如果历史数据文件损坏，重新初始化空结构
