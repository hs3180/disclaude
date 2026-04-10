# 5 分钟接入飞书

> 用最少的步骤，让 Disclaude 机器人跑起来。

## 前置条件

- Node.js ≥ 20
- 飞书开放平台账号（[open.feishu.cn](https://open.feishu.cn)）

## 第 1 步：安装

```bash
git clone https://github.com/hs3180/disclaude.git
cd disclaude
npm install
npm run build
```

## 第 2 步：创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn) → 创建企业自建应用
2. 记下 **App ID** 和 **App Secret**（凭证与基础信息页面）
3. 开启「应用功能 → 机器人」
4. 添加权限（搜索 Scope 名称）：

| 权限 | 用途 |
|------|------|
| `im:message` | 收发消息 |
| `im:message:send_as_bot` | 以机器人身份发消息 |
| `im:message:readonly` | 读取消息 |
| `im:resource` | 获取消息中的文件 |
| `im:image` | 上传图片 |
| `im:file` | 上传文件 |
| `im:chat` | 群组信息 |
| `im:chat:member` | 群组成员 |
| `im:chat:readonly` | 读取群组信息 |

5. 事件订阅 → 选择「**使用长连接接收事件**」→ 添加 `im.message.receive_v1`
6. 创建版本 → 申请发布 → 等待审批

## 第 3 步：配置

```bash
cp disclaude.config.example.yaml disclaude.config.yaml
```

编辑 `disclaude.config.yaml`，只需填两行：

```yaml
feishu:
  appId: "cli_xxxxxxxxxxxxxxxx"      # 你的 App ID
  appSecret: "xxxxxxxxxxxxxxxxxxxx"  # 你的 App Secret

glm:
  apiKey: "your_glm_api_key_here"   # 智谱 AI Key（推荐）
  # 或者用 Anthropic：
  # agent:
  #   provider: "anthropic"
  #   model: "claude-sonnet-4-20250514"
```

> 💡 如果同时配置了 `glm.apiKey` 和 `ANTHROPIC_API_KEY`，GLM 优先。

## 第 4 步：启动

```bash
# 开发模式（自动重载）
npm run dev

# 生产模式 — macOS（推荐，解决 TCC 权限问题）
npm run launchd:install

# 生产模式 — Linux（使用 PM2）
npm run pm2:start
```

> ⚠️ **macOS 用户注意**: 推荐使用 `launchd` 而非 PM2。PM2 的进程链会导致 macOS TCC 系统拒绝麦克风等权限。[详细说明](./macos-launchd.md)

## 第 5 步：验证

1. 飞书群聊 → 群设置 → 群机器人 → 添加你的机器人
2. 在群里 `@机器人 你好`
3. 收到回复 ✅

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `/reset` | 重置对话 |
| `/status` | 查看状态 |
| `/help` | 帮助信息 |

## 常见问题

**❌ 收不到消息** → 确认事件订阅选择了「长连接」且添加了 `im.message.receive_v1`

**❌ 权限不足** → 确认权限已审批生效，重新发布应用版本

**❌ 连接失败** → 检查 App ID / App Secret 是否正确，查看日志 `npm run pm2:logs`

---

> 📖 完整配置参考：[disclaude.config.example.yaml](../disclaude.config.example.yaml)
>
> 📖 详细飞书配置指南：[feishu-setup.md](./feishu-setup.md)
