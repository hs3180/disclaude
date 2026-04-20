---
name: "Dogfooding 自测"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-21T00:00:00.000Z"
---

# Dogfooding 自动自测

每周一 10:00 自动执行 self-test skill，以拟人化方式体验 disclaude 自身功能并生成反馈报告。

## 执行步骤

### 1. 触发 self-test skill

使用 `self-test` skill 执行自测流程：

该 skill 会自动：
1. 收集当前版本和最近变更信息
2. 基于时间轮换选择测试角色（Persona）
3. 设计并执行 3-5 个测试场景
4. 生成结构化自测报告
5. 通过 send_user_feedback 发送报告

### 2. 报告处理

报告将自动发送到配置的 chatId。如果发现高严重性问题，self-test skill 会自动创建 GitHub Issue。

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际接收报告的群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整频率（默认每周一 10:00）

## 角色轮换

self-test skill 通过当前分钟数 % 5 自动轮换测试角色：

| 余数 | 角色 | 测试重点 |
|------|------|----------|
| 0 | P1 - 好奇新手 | 基础体验、引导流程 |
| 1 | P2 - 高级用户 | 高级功能、边界情况 |
| 2 | P3 - 非技术用户 | 自然语言理解、容错 |
| 3 | P4 - 开发者 | 技术准确性、代码相关 |
| 4 | P5 - 报告者 | 数据处理、格式化 |

## 示例输出

```markdown
## 🐕 Dogfooding Self-Test Report

**Test Time**: 2026-04-21T10:00:00Z
**Version**: 0.4.0
**Persona**: P1 - Curious Newcomer

### Test Results Summary
| Scenario | Result | Details |
|----------|--------|---------|
| Basic greeting | ✅ | Friendly and informative |
| Feature discovery | ✅ | Listed available skills |
| Error handling | ⚠️ | Could improve guidance on invalid input |

### Recommendations
1. **Medium**: Add command suggestions when receiving unrecognized input
```
