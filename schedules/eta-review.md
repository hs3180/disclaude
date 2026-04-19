---
name: "ETA 估计规则回顾"
cron: "0 9 * * 1"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-19T00:00:00.000Z"
---

# ETA Estimation Rules Weekly Review

每周一上午 9 点分析过去一周的任务记录，更新估计规则。

## 执行步骤

### 1. 检查数据文件是否存在

```bash
ls workspace/data/task-records.md workspace/data/eta-rules.md 2>/dev/null
```

如果两个文件都不存在，跳过本次执行（尚未使用 ETA 预测系统）。

### 2. 执行 Review

使用 `eta-prediction` skill 的 `review` 模式：

1. 读取 `workspace/data/task-records.md` 中的所有任务记录
2. 读取 `workspace/data/eta-rules.md` 中的当前估计规则
3. 分析过去 7 天的任务记录：
   - 计算各类型任务的预测准确率
   - 识别系统性偏差（整体偏乐观或偏保守）
   - 找出预测误差最大的任务，分析原因
4. 更新 `eta-rules.md`：
   - 调整基准时间（如有系统性偏差）
   - 添加新发现的复杂性因子
   - 更新历史准确率记录
5. 使用 `send_user_feedback` 发送回顾报告到配置的 chatId

### 3. 错误处理

- 如果数据文件读取失败，跳过本次执行
- 如果 `send_user_feedback` 失败，记录日志
- 如果没有任何任务记录（新增 0 条），发送简短提示鼓励使用 ETA 预测
