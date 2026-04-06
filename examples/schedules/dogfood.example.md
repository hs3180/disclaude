---
name: "Dogfood 自我体验"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-04-06T00:00:00.000Z"
---

# Dogfood 自我体验

每周一 10:00 执行一次自我体验，以新用户视角审查系统功能并生成改进报告。

**关联 Issue**: #1560
**Milestone**: TBD

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 执行步骤

### 1. 环境发现

```bash
# 获取当前版本
cat package.json | grep '"version"' | head -1

# 查看最近变更
git log --oneline --since="7 days ago" | head -30
```

### 2. 能力审查

使用 `Glob` 发现所有 Skill 定义：
```
skills/*/SKILL.md
```

对每个 Skill 检查完整性：
- YAML frontmatter 是否包含 name、description、allowed-tools
- 是否有明确的 Workflow 步骤
- 是否有 DO NOT 安全护栏
- trigger keywords 是否与其他 Skill 冲突

### 3. 交互质量分析

使用 `Glob` 查找最近 7 天的聊天日志：
```
workspace/logs/**/*.md
```

分析以下维度：
- 响应是否准确理解用户意图
- 是否存在未处理的错误
- 用户是否需要反复纠正
- 功能请求和投诉模式

### 4. 非确定性探索

根据执行日期选择探索焦点，确保每次运行覆盖不同角度：

| 星期焦点 | 探索角度 |
|----------|----------|
| 周一 | Skill 深度审查 |
| 周二 | 日志考古分析 |
| 周三 | 边缘案例猎寻 |
| 周四 | 文档一致性审计 |
| 周五 | 新用户旅程模拟 |

### 5. 生成报告

按以下格式生成结构化报告：

```markdown
## 🐕 Disclaude 自我体验报告

**版本**: {version}
**体验时间**: {timestamp}
**体验范围**: {skills_count} 个 Skill, {days} 天日志

---

### ✅ 运行良好的方面
{列表}

### ⚠️ 发现的问题
{问题列表，含严重程度和修复建议}

### 💡 改进建议
{可执行的改进建议}

### 🎯 新用户视角评分
{各维度评分}
```

### 6. 保存并发送报告

```bash
# 保存报告
mkdir -p workspace/reports
```

将报告保存到 `workspace/reports/dogfood-{YYYY-MM-DD}.md`

使用 `send_user_feedback` 发送报告摘要到配置的 chatId。

## 错误处理

1. 如果日志目录不存在，跳过日志分析，仅审查 Skill 定义
2. 如果 `send_user_feedback` 失败，确保报告已保存到本地文件
3. 如果没有发现问题，生成正面报告说明系统运行良好

## 验收标准 (来自 Issue #1560)

- [x] 能以新用户视角审查系统功能
- [x] 能生成结构化的体验报告
- [x] 能通过定时任务自动触发
- [x] 探索焦点非确定性，每次运行覆盖不同角度
- [ ] 能自动创建 Issue 反馈问题 (需用户确认)

## 关联

- **核心功能**: #1560 (自我体验)
- **相关 Skill**: daily-chat-review, feedback, schedule-recommend
