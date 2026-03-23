---
name: "ETA Review"
cron: "0 */30 * * * *"
enabled: false
blocking: false
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# ETA Review - 任务执行记录自动采集

每 30 分钟扫描已完成的任务，自动记录执行数据到 `.claude/task-records.md`。

## 配置

- **扫描间隔**: 每 30 分钟
- **数据存储**: `.claude/task-records.md`（非结构化 Markdown）
- **规则存储**: `.claude/eta-rules.md`

## 执行步骤

### 1. 扫描已完成的任务

查找所有包含 `final_result.md` 的任务目录：

```bash
find tasks/ -name "final_result.md" -exec dirname {} \;
```

### 2. 筛选未记录的任务

对于每个已完成的任务：

1. 提取 task ID（目录名）
2. 检查是否已记录：
   ```bash
   grep -c "{taskId}" .claude/task-records.md 2>/dev/null || echo "0"
   ```
3. 如果 count = 0，说明尚未记录，进入步骤 3

### 3. 记录任务执行数据

对于每个未记录的已完成任务：

1. **读取任务定义**:
   ```
   Read tasks/{taskId}/task.md
   ```

2. **读取完成结果**:
   ```
   Read tasks/{taskId}/final_result.md
   ```

3. **读取执行历史**:
   ```
   Read tasks/{taskId}/iterations/final-summary.md
   ```
   如果 final-summary.md 不存在，遍历各迭代目录读取 execution.md。

4. **分析任务特征**:
   - 从 task.md 提取任务标题、类型、需求数量
   - 从 task.md 的 Created 时间和 final_result.md 的时间计算执行时长
   - 统计迭代次数
   - 分类任务类型（bugfix / feature-small / feature-medium / refactoring / docs / test / chore / research）

5. **追加记录到 task-records.md**:

   如果 `.claude/task-records.md` 不存在，先创建文件头：

   ```markdown
   # 任务记录

   此文件记录项目中的任务执行情况，用于积累经验数据，支持未来的 ETA 预测。

   ---
   ```

   然后追加任务记录：

   ```markdown

   ## {YYYY-MM-DD} {task_title}

   - **Task ID**: {taskId}
   - **类型**: {classified_type}
   - **估计时间**: {如果 task.md 中有时间估计则记录，否则写"未提供"}
   - **估计依据**: {如果 task.md 中有估计推理则记录，否则写"未提供"}
   - **实际时间**: {从时间戳计算或根据迭代次数估算}
   - **迭代次数**: {N}
   - **复杂度指标**: {requirements_count} 个需求
   - **复盘**: {对比估计与实际，记录偏差原因和经验}
   ```

### 4. 定期规则更新（每周日执行）

如果是周日（或 task-records.md 中记录数较上次分析增加了 5 条以上），执行规则分析：

1. **读取所有记录**:
   ```
   Read .claude/task-records.md
   ```

2. **按类型统计**:
   - 各类型任务的平均实际时间
   - 估计偏差（有估计时间的任务）
   - 常见复杂度因素

3. **更新 eta-rules.md**:

   如果 `.claude/eta-rules.md` 不存在，创建默认模板：

   ```markdown
   # ETA 估计规则

   此文件记录从历史任务执行中积累的估计规则，随经验不断进化。

   ## 任务类型基准时间

   | 类型 | 基准时间 | 备注 |
   |------|---------|------|
   | bugfix | 15-30分钟 | 取决于复现难度 |
   | feature-small | 30-60分钟 | 单一功能点 |
   | feature-medium | 2-4小时 | 需要多个组件配合 |
   | feature-large | 半天-1天 | 跨模块变更 |
   | refactoring | 视范围而定 | 需要评估影响面 |
   | docs | 30-60分钟 | 文档编写 |
   | test | 30-60分钟 | 单元测试编写 |
   | research | 1-2小时 | 调研分析 |

   ## 经验规则

   (待从任务记录中积累)

   ## 历史偏差分析

   (待从任务记录中积累)

   ## 最近更新

   - {date}: 初始规则模板创建
   ```

   根据分析结果更新：
   - 调整基准时间（基于实际数据的平均值）
   - 添加新的经验规则
   - 更新偏差分析
   - 记录更新日期

## 错误处理

- 如果 tasks/ 目录不存在或为空，跳过本次执行
- 如果某个任务的文件读取失败，跳过该任务继续处理其他任务
- 如果 `.claude/` 目录不存在，自动创建

## 注意事项

1. **非结构化存储**: 所有数据以自由格式 Markdown 存储，不使用结构化数据格式
2. **增量追加**: 每次只追加新记录，不修改已有记录
3. **幂等性**: 通过检查 task-records.md 中是否已包含 taskId 来避免重复记录
4. **轻量执行**: 每次 scan 只处理新完成的任务，不做全量分析
5. **默认禁用**: 此 schedule 默认 `enabled: false`，用户可手动启用
