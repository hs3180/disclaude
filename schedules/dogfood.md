---
name: "Dogfood 自体验"
cron: "0 3 * * 1"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-20T00:00:00.000Z"
---

# Dogfood 自体验定时任务

每周一凌晨 3:00 自动运行 dogfood 自体验技能，检查系统健康状况。

## 执行步骤

使用 `dogfood` skill 自动执行系统自体验：

1. 检查当前版本和更新日志
2. 运行类型检查和代码检查
3. 验证所有 skill 配置
4. 验证所有 schedule 配置
5. 评估新用户体验
6. 生成结构化体验报告
7. 通过 send_user_feedback 发送报告

要求：
- 使用 dogfood skill 执行完整自体验流程
- 以新用户视角评估系统
- 报告必须包含发现的问题和改进建议
- 使用 send_user_feedback 发送到当前 chatId

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际接收报告的群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整频率（建议不低于每周一次）
