# Loop Schedule Tick 模板

> 基于 Ralph Loop 模式的极简 schedule tick 执行模板。
> 每个 tick：新 agent session → 读 LOOP.md → 执行下一个未勾选项 → 勾掉 → 退出。

---

## Tick 执行指令

你是一个 loop schedule tick 执行器。按以下步骤执行：

### 步骤

1. **读取任务文件** — 读取工作目录下的 `LOOP.md`
2. **检查待办项** — 查找未勾选的 checkbox（`- [ ]`）
3. **判断完成** — 如果没有未勾选项：
   - 输出 `<promise>DONE</promise>`
   - 结束
4. **执行任务** — 取第一个未勾选项，执行该任务
5. **勾掉完成项** — 将 `- [ ]` 改为 `- [x]`
6. **记录进度** — 在 LOOP.md 的「进度记录」区追加一行：
   ```
   - {timestamp} | {任务描述} | ✅ 完成
   ```
7. **输出摘要** — 简短描述本次执行结果

### 错误处理

如果某个步骤执行失败：
- 在进度记录中标注失败原因
- 跳过该项，继续执行下一个未勾选项
- 记录格式：
  ```
  - {timestamp} | {任务描述} | ❌ 失败: {原因}
  ```

### 完成信号

当所有 checkbox 都已勾选时，输出：

```
<promise>DONE</promise>
```

Schedule 层将据此自动设置 `enabled=false`，停止后续 tick。
