---
name: "自我体验 (Dogfooding)"
cron: "0 20 * * 1"
enabled: false
blocking: true
chatId: "oc_your_dev_group_id"
createdAt: "2026-05-03T00:00:00.000Z"
---

# 自我体验自动化

每周一 20:00 自动以新用户视角体验 disclaude 功能，生成结构化反馈报告。

## 执行步骤

### 1. 发现当前功能

检查可用的 Skills 和最近变更：

```bash
ls skills/
git log --since="7 days ago" --oneline --name-only | head -40
```

### 2. 选择体验目标

从以下类别中选择 3-5 个功能进行体验：

| 类别 | 示例 |
|------|------|
| 基础对话 | 多轮交互、模糊需求理解 |
| Skill 调用 | 各 Skill 功能验证 |
| 边界场景 | 超长输入、空消息、多语言混合 |
| 错误恢复 | 无效操作、错误参数 |
| 功能组合 | 多功能串联使用 |

### 3. 模拟体验

以"新用户"视角自由探索选定功能，记录：
- 响应质量和速度
- 错误处理表现
- 用户体验感受
- 意外的亮点或问题

### 4. 生成报告

使用 `self-experience` skill 生成结构化反馈报告：

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{report_content}"
})
```

### 5. 提交问题（如需要）

如果发现高严重性 Bug，创建 GitHub Issue：

```bash
gh issue create --repo {repo} \
  --title "[dogfooding] {issue_title}" \
  --body "{issue_description}" \
  --label "bug"
```

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的开发群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整频率（默认每周一次）
