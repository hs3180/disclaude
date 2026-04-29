---
name: "PR Scanner"
cron: "*/30 * * * *"
enabled: false
blocking: true
chatId: "oc_control_channel_placeholder"
createdAt: "2026-04-30T00:00:00.000Z"
---

# PR Scanner — 定时扫描

每 30 分钟扫描仓库的 open PR，通过映射表追踪已创建的讨论群，为新 PR 创建群并写入映射。

## 配置

| 参数 | 值 | 说明 |
|------|-----|------|
| 仓库 | hs3180/disclaude | 监控的 GitHub 仓库 |
| 并发上限 | 3 | 最多同时 review 的 PR 数 |

## 执行步骤

### 1. 读取映射表

读取 `workspace/bot-chat-mapping.json`：

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

提取所有 `purpose: 'pr-review'` 条目的 PR number 和 chatId。
文件不存在则视为空映射表，从零开始。

### 2. 获取 Open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open --json number,title,author,headRefName
```

如果 `gh` 命令失败，记录错误并终止本次扫描。

### 3. 过滤与分类

将获取到的 PR 分为两类：

- **新 PR**：映射表中不存在 `pr-{number}` key
- **已有群的 PR**：映射表中存在 `pr-{number}` key 且有 chatId

### 4. 已有群的 PR — 状态变更检测

对每个已有群的 PR，检查其当前状态：

```bash
gh pr view {number} --repo hs3180/disclaude --json state,mergedAt,closedAt
```

根据结果：
- **merged** → 记录日志："PR #{number} 已合并"，不自动解散群
- **closed (not merged)** → 记录日志："PR #{number} 已关闭"，不自动解散群
- **open** → 跳过（正常状态）

> 注意：群解散由用户驱动，Bot 不主动解散。

### 5. 新 PR — 创建讨论群

#### 5a. 并发检查

统计映射表中 `purpose: 'pr-review'` 的条目数。
如果 ≥ 3（并发上限），跳过新 PR 创建，记录日志："并发上限已满，跳过本次新 PR 处理"。

#### 5b. 逐个处理新 PR

对每个新 PR（按 number 升序排列）：

**创建群**：
```bash
lark-cli im chat create --name "PR #{number} · {title前30字}" --description "PR #{number} 审查讨论群"
```

如果群创建失败，跳过该 PR，继续处理下一个。

**写入映射**：将 `pr-{number}` 条目追加到 `workspace/bot-chat-mapping.json`：

```json
{
  "pr-{number}": {
    "chatId": "{新群的chatId}",
    "createdAt": "{ISO时间戳}",
    "purpose": "pr-review"
  }
}
```

原子写入：先写入临时文件，再 rename 替换。

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| `gh` 命令失败 | 记录错误，终止本次扫描 |
| 映射文件读取失败 | 视为空映射表，从零开始 |
| 映射文件写入失败 | 记录错误（可通过群名重建） |
| 群创建失败 | 跳过该 PR，继续处理下一个 |
| 并发上限已满 | 跳过新 PR 创建，下一轮再处理 |

## 设计原则

1. **映射表是缓存** — 可通过 `lark-cli im chats list --as bot` 从飞书 API 重建
2. **用户驱动解散** — Bot 不自主解散群
3. **幂等操作** — 映射表过滤防止重复创建群
4. **无 Label 依赖** — 状态全在映射表中

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的控制频道 chatId
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整扫描频率（默认每 30 分钟）
