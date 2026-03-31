---
name: "Self-Dogfood"
cron: "0 3 * * *"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-01T00:00:00.000Z"
---

# Self-Dogfood 自动体验

每天凌晨 3:00 自动执行自我体验流程，以拟人化方式评估 disclaude 的各项功能。

## 执行步骤

### 1. 环境扫描

收集当前部署状态信息：

```bash
cat package.json | grep version
cat CHANGELOG.md | head -50
ls skills/
git log --oneline -20
```

### 2. 选择体验角色

根据当前小时数自动轮换体验角色（`current_hour % 5`）：

| 值 | 角色 | 行为风格 |
|----|------|----------|
| 0 | 好奇的新开发者 | 探索式提问，逐个尝试功能 |
| 1 | 高级用户 | 测试高级功能，挑战边界 |
| 2 | 极简主义者 | 期望快速响应，对复杂操作不耐烦 |
| 3 | 功能探索者 | 系统性尝试每个 skill |
| 4 | 边缘案例猎手 | 发送异常输入测试健壮性 |

### 3. 执行模拟体验

根据选定的角色执行 3-5 项体验活动：

- **Skill 发现测试**: 验证功能是否可被发现
- **Skill 调用测试**: 验证功能是否正常工作
- **对话质量测试**: 验证上下文维护和响应质量
- **边缘案例测试**: 验证异常输入的处理
- **文档准确性测试**: 验证文档与实际行为的一致性
- **错误恢复测试**: 验证异常情况下的恢复能力

### 4. 生成反馈报告

按照 self-dogfood skill 的模板生成结构化报告。

### 5. 发送报告

使用 `send_user_feedback` 发送报告到当前 chatId，同时保存到 `workspace/logs/self-dogfood/`。

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整时间（建议低峰期执行）

## 错误处理

1. 如果环境扫描失败，使用上一次已知信息继续
2. 如果 `send_user_feedback` 失败，将报告保存到本地日志
3. 如果执行超时，生成部分报告并记录中断原因
