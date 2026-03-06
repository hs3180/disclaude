---
name: "TTFR Report"
cron: "0 0 * * *"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-03-06T00:00:00.000Z"
---

# TTFR (Time To First Response) Report

每天凌晨统计用户消息的第一响应时间，生成 TTFR 报告。

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## TTFR 定义

TTFR (Time To First Response) 是用户发送消息到 Bot 首次响应的时间差。用于衡量 Bot 的响应速度。

**计算规则**:
- 用户发送消息 (📥 User) -> Bot 首次响应 (📤 Bot) 的时间差
- 如果用户连续发送多条消息，只计算第一条到首次响应的时间
- 忽略 Bot 主动发起的对话

## 执行步骤

### 1. 获取聊天记录目录

```bash
ls -d workspace/chat/$(date -d "yesterday" +%Y-%m-%d)/*.md 2>/dev/null || echo "No chat logs found for yesterday"
```

如果目录不存在，跳过本次执行。

### 2. 读取每个聊天的记录

对于每个聊天记录文件：

```
Read workspace/chat/{YYYY-MM-DD}/{chatId}.md
```

### 3. 解析消息时间戳

聊天记录格式示例：
```markdown
## [2026-03-05T10:30:15.123Z] 📥 User (message_id: cli-xxx)

**Sender**: ou_xxx
**Type**: text

用户消息内容

---

## [2026-03-05T10:30:45.456Z] 📤 Bot (message_id: cli-yyy)

**Sender**: bot
**Type**: text

Bot 响应内容

---
```

**解析逻辑**:
1. 使用正则提取每条消息的时间戳和方向标记
2. 时间戳格式: `[YYYY-MM-DDTHH:MM:SS.sssZ]`
3. 方向标记: `📥 User` (用户消息) 或 `📤 Bot` (Bot 响应)

### 4. 计算 TTFR

**算法**:
```
1. 遍历消息序列
2. 当遇到 📥 User 消息时，记录用户消息时间 (user_time)
3. 当遇到 📤 Bot 消息时，如果有 pending 的 user_time:
   - 计算 ttfr = bot_time - user_time
   - 记录该次交互的 TTFR
   - 清除 pending user_time
4. 如果连续多条 📥 User 消息，只使用第一条的时间
```

### 5. 统计指标计算

对于每个聊天，计算：
- **平均 TTFR**: 所有 TTFR 的平均值
- **最小 TTFR**: 最快响应时间
- **最大 TTFR**: 最慢响应时间
- **中位数 TTFR**: 排序后的中间值
- **响应次数**: 统计周期内的交互次数

### 6. 生成报告

```markdown
## ⏱️ TTFR Daily Report

**统计日期**: {YYYY-MM-DD}
**统计周期**: 24 小时

---

### 📊 整体统计

| 指标 | 数值 |
|------|------|
| 活跃聊天数 | {chat_count} |
| 总交互次数 | {total_interactions} |
| 平均 TTFR | {avg_ttfr} |
| 最小 TTFR | {min_ttfr} |
| 最大 TTFR | {max_ttfr} |
| 中位数 TTFR | {median_ttfr} |

---

### 📋 各聊天详情

#### Chat: {chat_id}

| 指标 | 数值 |
|------|------|
| 交互次数 | {interaction_count} |
| 平均 TTFR | {avg_ttfr} |
| 最小 TTFR | {min_ttfr} |
| 最大 TTFR | {max_ttfr} |

---

💡 提示：TTFR 目标建议 < 5 秒。如超过 10 秒，建议检查系统性能。
```

### 7. 发送报告

使用 `send_user_feedback` 将报告发送到配置的 chatId。

### 8. 记录历史数据

将统计结果追加到 `workspace/data/ttfr-history.json`：

```json
{
  "history": [
    {
      "date": "2026-03-05",
      "generatedAt": "2026-03-06T00:00:00.000Z",
      "summary": {
        "chatCount": 5,
        "totalInteractions": 42,
        "avgTTFR": 3.2,
        "minTTFR": 1.1,
        "maxTTFR": 8.5,
        "medianTTFR": 2.8
      },
      "details": [
        {
          "chatId": "oc_xxx",
          "interactions": 10,
          "avgTTFR": 2.5
        }
      ]
    }
  ]
}
```

## 时间格式化

将毫秒转换为易读格式：
- `< 1s`: 显示毫秒，如 `450ms`
- `< 60s`: 显示秒，如 `3.2s`
- `< 1h`: 显示分钟，如 `2m 30s`
- `>= 1h`: 显示小时，如 `1h 15m`

## 错误处理

1. 如果聊天记录目录不存在，跳过本次执行
2. 如果单个聊天文件解析失败，记录错误并继续处理其他文件
3. 如果 `send_user_feedback` 失败，记录日志但保留历史数据
4. 如果历史文件损坏，创建新文件

## 示例输出

```
## ⏱️ TTFR Daily Report

**统计日期**: 2026-03-05
**统计周期**: 24 小时

---

### 📊 整体统计

| 指标 | 数值 |
|------|------|
| 活跃聊天数 | 3 |
| 总交互次数 | 15 |
| 平均 TTFR | 2.8s |
| 最小 TTFR | 850ms |
| 最大 TTFR | 8.2s |
| 中位数 TTFR | 2.1s |

---

### 📋 各聊天详情

#### Chat: oc_71e5f41a029f3a120988b7ecb76df314

| 指标 | 数值 |
|------|------|
| 交互次数 | 8 |
| 平均 TTFR | 2.1s |
| 最小 TTFR | 850ms |
| 最大 TTFR | 5.3s |

#### Chat: oc_another_chat_id

| 指标 | 数值 |
|------|------|
| 交互次数 | 7 |
| 平均 TTFR | 3.6s |
| 最小 TTFR | 1.2s |
| 最大 TTFR | 8.2s |

---

💡 提示：TTFR 目标建议 < 5 秒。如超过 10 秒，建议检查系统性能。
```

## 扩展建议

1. **趋势分析**: 可以读取 `ttfr-history.json` 生成 7 天/30 天趋势图
2. **告警机制**: 当平均 TTFR 超过阈值时发送告警
3. **分时段统计**: 区分高峰/低谷时段的响应时间
