---
name: "Weekly Framework Race Report"
cron: "0 9 * * 1"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Weekly Framework Race Report

每周一 9:00 自动分析过去一周的聊天记录，对比不同 Agent Framework/模型的表现，生成赛马报告。

## 配置

- **分析频率**: 每周一 09:00
- **分析范围**: 过去 7 天的聊天记录
- **数据来源**: `workspace/logs/`
- **默认禁用**: `enabled: false`（需手动启用）

## 使用说明

1. 将 `enabled` 改为 `true` 以启用
2. 将 `chatId` 改为目标群聊 ID
3. 确保日志目录中有足够的任务数据

## 执行指令

请使用 agent-framework-race skill 分析过去一周的聊天记录，对比不同模型的表现，生成赛马报告。

要求：
1. 读取 workspace/logs/ 目录下的最近 7 天日志
2. 识别使用的不同模型/Provider
3. 提取性能指标进行对比
4. 识别各模型的独特优势
5. 使用 send_user_feedback 发送到当前 chatId
