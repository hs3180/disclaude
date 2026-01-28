# CLI 飞书输出模式

## 功能说明

CLI 模式默认输出到控制台。要发送消息到飞书,必须显式使用 `--feishu-chat-id` 参数。

## 使用方法

### 默认模式(控制台输出)

```bash
# 输出到屏幕(默认行为)
disclaude --prompt "分析代码"
npm start -- --prompt "帮我理解这个项目"
```

### 飞书模式 - 方式 1: 直接指定 chat_id

```bash
# 发送到指定的飞书群聊或私聊
disclaude --prompt "分析代码" --feishu-chat-id oc_xxxxxxxxxxxxx
disclaude --prompt "生成报告" --feishu-chat-id oc_xxxxxxxxxxxxx
```

### 飞书模式 - 方式 2: 使用环境变量(推荐)

```bash
# 1. 在 .env 中配置默认 chat_id
echo "FEISHU_CLI_CHAT_ID=oc_xxxxxxxxxxxxx" >> .env

# 2. 使用 --feishu-chat-id auto 来启用飞书发送
disclaude --prompt "分析代码" --feishu-chat-id auto
npm start -- --prompt "生成报告" --feishu-chat-id auto
```

**重要**: 即使配置了 `FEISHU_CLI_CHAT_ID` 环境变量,也必须加上 `--feishu-chat-id auto` 参数才会发送到飞书。

## Chat ID 配置说明

CLI 模式的飞书发送行为:

| 命令 | 行为 |
|------|------|
| `disclaude --prompt "test"` | 控制台输出 |
| `disclaude --prompt "test" --feishu-chat-id oc_xxx` | 发送到指定 chat_id |
| `disclaude --prompt "test" --feishu-chat-id auto` | 发送到 `FEISHU_CLI_CHAT_ID` 环境变量配置的 chat_id |

**设计理念**: 默认使用控制台输出,避免误发送到飞书。需要显式指定参数才启用飞书模式。

## 获取 Chat ID

### 方法 1: 从飞书 URL 获取
- 群聊 URL: `https://example.feishu.cn/messenger/chats/oc_xxxxxxxxxxxxx`
- 最后一段就是 `chat_id` (`oc_xxxxxxxxxxxxx`)

### 方法 2: 使用 Bot 接收
- 在飞书中向 bot 发送消息
- 查看 bot 日志中的 `chat_id`

### 方法 3: 从已有消息获取
- 使用飞书开放平台 API: `GET /api/v2/messages/:message_id`
- 返回结果中的 `chat_id` 即可使用

## 环境变量要求

使用飞书模式需要配置以下环境变量:

```bash
# 必需配置
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxx

# 可选配置 - 配合 --feishu-chat-id auto 使用
FEISHU_CLI_CHAT_ID=oc_your_default_chat_id
```

## 使用场景

1. **后台任务**: 定时任务结果发送到飞书群
2. **远程协作**: 在不同设备上查看 agent 响应
3. **团队共享**: 让团队看到 agent 的分析结果
4. **移动查看**: 在手机上查看长文本输出

## 限制与注意事项

1. **权限**: Bot 必须被添加到目标聊天中
2. **频率**: 飞书 API 有频率限制(300条/分钟)
3. **节流**: `tool_progress` 消息默认 2 秒节流
4. **错误处理**: 如果发送失败,错误会输出到 stderr

## 示例

```bash
# 场景 1: 代码分析发送到工作群
disclaude --prompt "分析 src/ 目录下的代码质量" \
  --feishu-chat-id oc_a0553eda9014c201e6969b478895c230

# 场景 2: 日志分析发送到运维群
disclaude --prompt "分析最近 100 行错误日志" \
  --feishu-chat-id oc_a0553eda9014c201e6969b478895c230

# 场景 3: 文档生成发送到文档群
disclaude --prompt "生成 API 文档" \
  --feishu-chat-id oc_a0553eda9014c201e6969b478895c230
```

## 调试

查看发送状态(输出到 stderr):

```bash
disclaude --prompt "test" --feishu-chat-id oc_xxx 2> send.log
cat send.log
```

示例输出:
```
[CLI] Output will be sent to Feishu chat: oc_xxx
[Feishu] Sent to oc_xxx: Starting analysis...
[Feishu] Sent to oc_xxx: Analysis complete...
```
