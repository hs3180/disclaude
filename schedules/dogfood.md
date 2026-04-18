---
name: "自动体验测试 (Dogfood)"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "oc_your_dogfood_chat_id"
createdAt: "2026-04-19T00:00:00.000Z"
---

# 自动体验测试 — Dogfooding Schedule

每周一上午 10:00 自动执行 dogfooding 体验测试。

## 执行步骤

### 1. 环境准备

确保报告目录存在：

```bash
mkdir -p workspace/dogfood-reports
```

### 2. 调用 Dogfood Skill

使用 `dogfood` skill 执行自动体验测试：

按照 dogfood skill 的流程执行：
1. **Phase 1**: 环境感知 — 读取版本信息、可用 Skills、最近变更
2. **Phase 2**: 场景生成 — 基于环境信息自主生成 3-5 个测试场景
3. **Phase 3**: 体验执行 — 模拟真实用户行为，测试各功能
4. **Phase 4**: 报告生成 — 将结果写入 `workspace/dogfood-reports/dogfood-report-{date}.md`

### 3. 结果通知

使用 `send_user_feedback` 将报告摘要发送到当前 chatId：

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{report_summary}"
})
```

**摘要格式**:
```markdown
## 🐛 Dogfooding Report — v{version}

总体评分: {avg_score}/5
场景数: {count}
发现问题: {issue_count}

### 主要发现
- {finding_1}
- {finding_2}

详细报告: workspace/dogfood-reports/dogfood-report-{date}.md
```

### 4. 异常处理

- 如果上次报告已存在且日期相同，跳过本次执行
- 如果 dogfood 执行失败，记录错误日志但不创建 Issue
- 如果发现严重 bug，可使用 `/feedback` 提交 Issue

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的通知群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整频率（默认每周一）

## 频率建议

| 频率 | cron 表达式 | 适用场景 |
|------|-------------|----------|
| 每日 | `0 10 * * *` | 活跃开发期 |
| 每周 | `0 10 * * 1` | 稳定维护期（默认） |
| 每两周 | `0 10 1,15 * *` | 低频维护期 |
