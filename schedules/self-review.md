---
name: "Self-Review (Dogfooding)"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-15T00:00:00.000Z"
---

# Self-Review (Dogfooding) Schedule

每周一 10:00 自动执行系统自检，生成健康报告并发送到指定群聊。

这是 Issue #1560 的 Phase 1 实现：**自动自检 + 报告生成**。

## 执行步骤

### 1. 调用 self-review Skill

使用 `self-review` skill 执行完整的系统自检：

```
/self-review
```

或通过 prompt 触发：

```
请执行系统自检，检查版本信息、技能可用性、日志错误和配置状态，生成健康报告并发送到当前 chatId。
```

### 2. 报告审阅

Self-review skill 会自动：
1. 收集版本信息
2. 发现所有可用 skills
3. 分析最近 24 小时的日志错误
4. 验证配置完整性
5. 检查定时任务状态
6. 生成结构化健康报告
7. 通过 `send_user_feedback` 发送报告

### 3. 异常处理

如果 self-review 过程中发现严重问题（如配置缺失、大量错误），skill 会在报告中标注 🔴 Critical 状态，并给出具体建议。

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的群聊 ID（用于接收健康报告）
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整频率（默认每周一 10:00）

## 后续 Phase 计划

| Phase | 功能 | 状态 |
|-------|------|------|
| Phase 1 | 系统自检 + 报告生成 | ✅ 当前实现 |
| Phase 2 | 拟人化模拟交互（自动调用 skills） | 🔮 未来 |
| Phase 3 | 自动反馈闭环（自动提交 issue） | 🔮 未来 |
| Phase 4 | 版本对比 + 回归检测 | 🔮 未来 |

## 错误处理

1. 如果 `send_user_feedback` 失败，记录日志但不重试
2. 如果配置文件缺失，在报告中标注并建议修复
3. 如果日志文件不存在，跳过日志分析步骤
4. 如果 skill 发现在运行时出错，生成简化报告
