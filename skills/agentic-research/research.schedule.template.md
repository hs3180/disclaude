# Research Schedule Template

> **Research 场景的 Schedule 执行模板**
> 基于通用 Loop Schedule 模板（`skills/schedule/loop.schedule.template.md`），增加研究专用阶段定义和用户反馈收集机制。

## 核心机制

```
Schedule tick → 收集用户反馈 → 读取状态 → 确定研究阶段 → 执行一步 → 更新状态 → 推送进度 → 结束 tick
```

---

## 研究阶段定义

| 阶段 | phase 值 | 说明 |
|------|----------|------|
| 规划 | `planning` | 定义研究问题、确定数据源、规划步骤 |
| 收集 | `gathering` | 收集数据和信息 |
| 分析 | `analyzing` | 分析数据、发现模式、得出结论 |
| 报告 | `reporting` | 组织发现、生成报告 |
| 完成 | `completed` | 研究完成 |

阶段转换：`planning` → `gathering` → `analyzing` → `reporting` → `completed`

每个阶段可能有多个 tick。Agent 自行判断何时推进到下一阶段。

---

## Tick 执行流程

### 0. 收集用户反馈（每个 tick 第一步）

在执行研究步骤之前，先检查是否有用户反馈：

1. 读取群聊中最近的消息（过滤掉 agent 自己的消息）
2. 识别用户指令、建议、纠正
3. 评估反馈是否需要调整研究方向
4. 如果需要调整：更新 STATE.md 中的研究方向，在进度中注明

**反馈处理原则：**
- 用户消息是**建议**，不是命令——Agent 自行判断是否采纳
- 采纳时在进度卡片中注明"已根据反馈调整"
- 不采纳时继续原方向，可在备注中记录未采纳的原因
- 重大方向变更应推送通知

### 1. 读取状态

```bash
cat {WORK_DIR}/STATE.md
```

解析 frontmatter 获取 `status`、`phase`、`tickCount`。

### 2. 判断是否完成

- `status == completed`：禁用 schedule，输出完成摘要，结束
- `status == error`：评估是否可恢复，否则禁用 schedule

### 3. 执行一步

根据当前 `phase` 执行对应操作：

**planning 阶段：**
- 明确研究问题
- 确定数据源和搜索策略
- 定义研究范围
- 输出研究计划到 STATE.md 正文

**gathering 阶段：**
- 从一个数据源收集信息
- 清洗和验证数据
- 记录来源和引用
- 更新待办列表

**analyzing 阶段：**
- 执行一种分析方法
- 发现模式和趋势
- 对比不同数据源
- 记录发现到 STATE.md

**reporting 阶段：**
- 选择报告模板（参考 report-templates.md）
- 组织研究发现
- 生成报告章节
- 引用所有来源

### 4. 更新状态

执行完成后更新 STATE.md：
- `tickCount` +1
- `updatedAt` 更新
- `phase` 根据进展推进
- `status` 在 completed 阶段设为 `completed`
- 正文更新待办列表和研究笔记

### 5. 推送进度

在以下节点通过 `send_card` 推送：
- 阶段切换时（"进入分析阶段"）
- 重要发现时（"发现关键数据点"）
- 反馈被采纳时（"已根据反馈调整研究方向"）
- 错误发生时
- 任务完成时

### 6. 结束 tick

输出简短状态摘要。

---

## STATE.md 结构

```yaml
---
status: planning | gathering | analyzing | reporting | completed | error
phase: string
tickCount: number
createdAt: ISO_timestamp
updatedAt: ISO_timestamp
topic: string
---

## 研究问题

{原始研究问题}

## 数据源

- [ ] {数据源 1}
- [ ] {数据源 2}

## 发现

{研究过程中的发现}

## 待办

- [ ] {当前阶段待办}
- [x] {已完成}

## 用户反馈记录

{记录采纳的用户反馈}
```

---

## 完成条件

当所有研究步骤执行完毕时：
1. 将 `status` 设为 `completed`
2. 在正文写入最终研究摘要
3. 禁用 schedule（`SCHEDULE.md` 设置 `enabled: false`）
4. 发送包含研究结论摘要的完成通知

---

## 错误处理

- **数据源不可用**：记录错误，尝试备选数据源，不阻塞
- **分析失败**：记录错误原因，调整分析方法
- **反馈矛盾**：用户先后给出矛盾反馈时，以最新为准
- **连续失败**：tickCount 超过 50 仍未完成时，自动禁用 schedule

---

## 设计原则

- **基于通用模板**：遵循 loop.schedule.template.md 的执行范式
- **非阻塞反馈**：用户消息是建议，不暂停执行
- **Agent 自主判断**：Agent 决定是否采纳反馈和何时推进阶段
- **透明**：采纳反馈时明确说明
- **一个 tick 一步**：保持步骤粒度在 5-15 分钟
