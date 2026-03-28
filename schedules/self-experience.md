---
name: "Self-Experience (Dogfooding)"
cron: "0 4 * * 1"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-03-28T00:00:00.000Z"
---

# Self-Experience - Weekly Dogfooding Check

每周自动执行一次自我体验检查，验证功能完整性和系统健康。

## 配置

- **执行频率**: 每周一凌晨 4:00
- **默认状态**: 关闭（需手动启用）
- **超时限制**: 15 分钟

## 执行步骤

请使用 self-experience skill 执行一次完整的自我体验检查。

要求：
1. 分析当前版本（从 package.json 和 CHANGELOG.md）
2. 运行自动化健康检查（测试、类型检查、lint、构建）
3. 扫描并验证所有 skill 定义的有效性
4. 验证 schedule 定义的有效性
5. 分析最近的聊天日志获取 UX 洞察
6. 生成结构化报告并发送到当前 chatId
7. 仅对严重问题创建 GitHub issue

## 注意事项

- **不要修改**任何源代码或配置文件
- **不要创建或修改**定时任务
- **不要部署或重启**任何服务
- 测试命令设置 10 分钟超时
- 优先关注功能完整性和用户体验
- 敏感信息（ID、token、密钥）必须脱敏后再报告
