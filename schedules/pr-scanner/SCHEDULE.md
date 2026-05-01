---
name: "PR Scanner"
cron: "*/30 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-05-01T00:00:00.000Z"
---

# PR Scanner — 定时扫描

每 30 分钟扫描 `hs3180/disclaude` 仓库的 Open PR，为新 PR 创建讨论群，检测已有群的 PR 状态变更。

## 参数

| 参数 | 值 |
|------|-----|
| **仓库** | `hs3180/disclaude` |
| **并发上限** | 3 |
| **映射文件** | `workspace/bot-chat-mapping.json` |

## 执行步骤

### 1. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

提取所有 `purpose: 'pr-review'` 条目的 PR number 和 chatId。文件不存在或为空则视为空映射表。

记录当前 `pr-review` 条目数，用于并发检查。

### 2. 获取 Open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open --json number,title,author,headRefName
```

如果 `gh` 命令失败，记录错误日志并**终止本次扫描**（不继续后续步骤）。

### 3. 过滤与分类

将获取到的 PR 分为两类：

- **新 PR**：PR number 不在映射表中（`pr-{number}` key 不存在）
- **已有群的 PR**：PR number 在映射表中存在

### 4. 已有群的 PR — 状态变更检测

获取最近关闭的 PR 列表：

```bash
gh pr list --repo hs3180/disclaude --state closed --json number,state,title
```

对每个已有群的 PR（在映射表中的），检查是否出现在关闭列表中：

- **merged** → 记录日志：`PR #{number} 已合并`。不自动解散群。
- **closed (not merged)** → 记录日志：`PR #{number} 已关闭`。不自动解散群。
- **仍 open** → 跳过，无需处理。

> **设计原则**: Bot 不自主解散群。状态变更仅记录日志，群由用户驱动解散。

### 5. 新 PR — 并发检查

检查映射表中 `purpose: 'pr-review'` 的条目数：

- 如果 **≥ 3**（并发上限）→ 记录日志 `并发已达上限，跳过新 PR`，**跳过步骤 5a/5b**。
- 如果 **< 3** → 继续为新 PR 创建群。

### 6. 新 PR — 创建讨论群（按 number 升序处理）

对每个新 PR（按 number 升序排列），逐一执行：

**6a. 创建群**:

```bash
lark-cli im chat create --name "PR #{number} · {title前30字}" --description "PR #{number} 审查讨论群"
```

- 群名截断：`title` 取前 30 个字符，总群名不超过 64 字符
- 如果群名含特殊字符需要转义

**6b. 写入映射**:

解析 `lark-cli` 返回的 `chatId`（`oc_xxx` 格式），追加映射条目：

```
Key: pr-{number}
Value: { chatId: "oc_xxx", createdAt: "ISO时间戳", purpose: "pr-review" }
```

原子写入映射文件（读取 → 修改 → 写入临时文件 → 重命名）：

```bash
# 读取当前映射
cat workspace/bot-chat-mapping.json

# 使用 jq 追加新条目并原子写入
# 示例（替换 {number} 和 {chatId}）:
tmp=$(mktemp) && cat workspace/bot-chat-mapping.json | jq '. + {("pr-{number}"): {chatId: "{chatId}", createdAt: "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'", purpose: "pr-review"}}' > "$tmp" && mv "$tmp" workspace/bot-chat-mapping.json
```

**6c. 并发检查（每次创建后重新评估）**:

创建一个群后，重新检查 `pr-review` 条目数。如果已达上限（≥ 3），停止处理剩余新 PR。

**6d. 错误处理**:

- `lark-cli` 群创建失败 → 记录错误日志 `群创建失败: PR #{number}`，跳过该 PR，继续处理下一个
- 映射文件写入失败 → 记录错误日志 `映射写入失败: PR #{number}`（可通过群名重建）

### 7. 输出扫描报告

扫描完成后，输出简要报告：

```
📊 PR Scanner 扫描报告:
- Open PR: {count}
- 新 PR: {count}（已创建群: {count}，跳过: {count}）
- 已有群 PR: {count}（状态变更: {count}）
- 并发: {current}/{max}
```

## 错误处理总览

| 错误场景 | 处理方式 |
|----------|----------|
| `gh` 命令失败 | 记录错误，终止本次扫描 |
| 映射文件读取失败 | 视为空表，继续执行 |
| 映射文件写入失败 | 记录错误（可通过群名重建） |
| `lark-cli` 群创建失败 | 跳过该 PR，继续处理下一个 |
| 网络超时 | 记录错误，终止本次扫描 |

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **用户驱动解散** — Bot 不自主解散群
3. **幂等操作** — 映射表过滤防重复创建
4. **无 Label 依赖** — 状态全在映射表
5. **原子写入** — 映射文件更新使用临时文件+重命名

## 关联

- Parent Issue: #2945
- Related: #2982
