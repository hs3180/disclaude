---
name: "智能推荐分析"
cron: "0 3 * * *"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-03-01T00:00:00.000Z"
---

# 智能定时任务推荐分析

每天凌晨 3 点分析用户交互记录，发现重复任务模式并推荐定时任务。

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 执行步骤

### 1. 获取所有聊天记录文件

```bash
ls workspace/chat/*.md 2>/dev/null || echo "No chat files found"
```

如果 `workspace/chat/` 目录不存在或为空，跳过本次执行。

### 2. 分析每个聊天的交互记录

对于每个聊天记录文件：

1. 读取文件内容：
   ```
   Read workspace/chat/{chatId}.md
   ```

2. 分析过去 30 天的交互记录，识别：
   - **重复性任务**: 用户多次请求的相同或相似任务
   - **时间模式**: 任务通常在什么时间被请求
   - **任务特征**: 任务是否适合自动化（自包含、有明确成功标准、可独立运行）

3. 筛选条件：
   - 至少出现 3 次的相似请求
   - 请求发生在相似的时间段
   - 任务适合定时执行（信息检索、报告生成、监控等）

### 3. 生成推荐

对于每个检测到的模式，生成推荐消息：

```markdown
## 💡 定时任务推荐

**任务类型**: [Task type]
**检测到的模式**: [Pattern description]
**建议时间**: [Recommended schedule]
**置信度**: [High/Medium/Low]
**出现次数**: [Count]

**建议的定时任务内容**:
"""
[The prompt that should be executed on schedule]
"""
```

### 4. 发送推荐消息

使用 `send_user_feedback` 将推荐消息发送到配置的 chatId。

如果检测到多个模式，合并为一条消息发送：

```markdown
## 📋 智能定时任务推荐报告

分析完成！发现以下可自动化的任务模式：

---

[推荐 1]

---

[推荐 2]

---

💡 提示：回复「创建定时任务」来设置推荐的定时任务。
```

### 5. 记录分析结果

将分析结果追加到 `workspace/data/recommend-history.json`：

```json
{
  "history": [
    {
      "date": "2026-03-01T03:00:00.000Z",
      "chatId": "oc_xxx",
      "patterns": 2,
      "recommendations": ["任务类型1", "任务类型2"]
    }
  ]
}
```

## 不推荐的情况

跳过以下类型的任务：
- 一次性任务
- 需要用户交互的任务
- 依赖上下文的任务
- 需要实时决策的任务

## 错误处理

1. 如果聊天记录文件读取失败，跳过该文件继续处理其他文件
2. 如果 `send_user_feedback` 失败，记录日志并重试一次
3. 如果没有任何可推荐的模式，不发送消息

## 数据文件

`workspace/data/recommend-history.json` 用于跟踪历史推荐，避免重复推荐相同模式。

## 示例输出

```
## 📋 智能定时任务推荐报告

分析完成！发现以下可自动化的任务模式：

---

## 💡 定时任务推荐

**任务类型**: GitHub Issues 检查
**检测到的模式**: 用户每天早上 9:00-9:30 之间查询新的 GitHub issues
**建议时间**: 每天 09:00
**置信度**: High
**出现次数**: 5 次

**建议的定时任务内容**:
"""
检查 hs3180/disclaude 仓库中所有 open 状态的 issues，排除已有 open PR 关联的 issues，按优先级排序后发送摘要报告。
"""

---

💡 提示：回复「创建定时任务」来设置推荐的定时任务。
```
