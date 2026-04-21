---
name: "Dogfood 自测"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-21T00:00:00.000Z"
---

# Dogfood 自测

每周一 10:00 自动检测版本变化，如有新版本则执行自我体验流程。

## 执行步骤

### 1. 版本检测

使用 dogfood skill 检测当前版本与上次测试版本的差异：

```bash
node -e "console.log(require('./package.json').version)"
cat workspace/data/dogfood-state.json 2>/dev/null || echo '{}'
```

**判断标准**：
- 当前版本 ≠ 上次测试版本 → 执行完整 dogfooding
- 当前版本 = 上次测试版本 → 跳过并报告状态

### 2. 执行 Dogfooding

请使用 dogfood skill 执行自我体验流程。

要求：
1. 读取 `package.json` 获取当前版本号
2. 读取 `workspace/data/dogfood-state.json` 获取上次测试版本
3. 如果版本未变化，简短报告 "当前版本 v{x.x.x} 已测试过，无版本变化" 后结束
4. 如果版本变化（或首次运行），执行以下活动：
   - **Skill Discovery**: 列出并验证所有 skills
   - **Schedule Health**: 检查所有 schedules 状态
   - **Code Quality**: 运行 type-check、lint、test
   - **Changes Review**: 审查最近的 git log 和 CHANGELOG
   - **Config Validation**: 验证配置文件
5. 生成结构化反馈报告（包含 ✅/❌ 状态、发现问题、改进建议）
6. 更新 `workspace/data/dogfood-state.json`：
   ```json
   {
     "lastTestedVersion": "当前版本",
     "lastTestedAt": "ISO时间戳",
     "lastReportSummary": "一行摘要"
   }
   ```
7. 使用 `send_user_feedback` 发送报告到当前 chatId

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整时间（默认每周一 10:00）

## 错误处理

1. 如果 type-check/lint/test 失败，记录错误详情到报告中
2. 如果 state 文件损坏，视为首次运行
3. 如果 send_user_feedback 失败，确保 state 文件已更新（下次可重试）

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（版本未变化时直接跳过）
2. **非侵入性**: 测试过程不修改源代码或配置
3. **状态持久化**: 使用 JSON 文件记录测试状态
4. **报告结构化**: 报告包含活动状态、发现问题、改进建议
5. **不创建新 Schedule**: 遵守定时任务执行环境的规则
