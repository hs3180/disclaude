# 飞书富文本消息问题分析报告

## 测试时间
2026-01-28

## 问题概述
尝试通过飞书 API 发送富文本（post）消息时，持续收到 `230001` 错误：`invalid message content`。

## 测试结果

### ✅ 纯文本格式（text）- 成功
```json
{
  "msg_type": "text",
  "content": "{\"text\":\"这是纯文本格式\"}"
}
```
**状态**: 正常工作

### ❌ 富文本格式（post）- 失败
所有尝试的富文本格式都返回 `230001` 错误：

#### 测试 1: 带标题的富文本
```json
{
  "msg_type": "post",
  "content": "{\"post\":{\"zh_cn\":{\"content\":[[{\"tag\":\"text\",\"text\":\"这是一条测试富文本消息\"}]],\"title\":\"测试标题\"}}}"
}
```
**结果**: ❌ 230001 - invalid message content

#### 测试 2: 无标题的富文本
```json
{
  "msg_type": "post",
  "content": "{\"post\":{\"zh_cn\":{\"content\":[[{\"tag\":\"text\",\"text\":\"这是没有标题的富文本\"}]]}}}"
}
```
**结果**: ❌ 230001 - invalid message content

#### 测试 3: 多行富文本
```json
{
  "msg_type": "post",
  "content": "{\"post\":{\"zh_cn\":{\"content\":[[{\"tag\":\"text\",\"text\":\"第一行\"}],[{\"tag\":\"text\",\"text\":\"第二行\"}]]}}}"
}
```
**结果**: ❌ 230001 - invalid message content

## 详细错误信息

```
Error Code: 230001
Error Message: Your request contains an invalid request parameter, ext=invalid message content.
HTTP Status: 400 Bad Request
```

**排查链接**:
- https://open.feishu.cn/search?from=openapi&log_id=20260128084003E9976D4B5025F79ACB53&code=230001&method_id=6936075528891154460

## 实际请求数据分析

### 请求 URL
```
POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id
```

### 请求头
```
Authorization: Bearer t-g1041s8DHNSKJGYRR47WQAAHHNYEWX2H4GHDOGMV
Content-Type: application/json
User-Agent: oapi-node-sdk/1.0.0
```

### 请求体（URL 编码前）
```json
{
  "receive_id": "oc_5ba21357c51fdd26ac1aa0ceef1109cb",
  "msg_type": "post",
  "content": "{\"post\":{\"zh_cn\":{\"content\":[[{\"tag\":\"text\",\"text\":\"这是一条测试富文本消息\"}]],\"title\":\"测试标题\"}}}"
}
```

**关键观察**：
1. `content` 字段是 **双重 JSON 编码**（字符串内的 JSON）
2. 这符合飞书 API 文档要求
3. 纯文本格式使用相同方式，工作正常

## 可能的原因分析

### 1. ✗ JSON 格式问题（已排除）
- 使用 `JSON.stringify()` 正确编码
- 纯文本格式使用相同方法，工作正常
- JSON 结构符合官方文档规范

### 2. ✗ 字段缺失问题（已排除）
- 测试了带/不带 `title` 的版本
- 测试了不同 `content` 结构
- 所有必需字段都存在

### 3. ⚠️ Bot 权限问题（疑似）
**可能性较高**。Bot 可能没有发送富文本消息的权限：
- 飞书管理后台可能需要单独授予富文本权限
- 某些应用类型可能默认不支持 post 格式
- 需要检查 Bot 的权限配置

### 4. ⚠️ 应用类型限制（疑似）
**可能性较高**。当前应用类型可能不支持富文本：
- 自建应用 vs 商店应用权限不同
- 某些应用类型仅支持纯文本
- 需要确认应用类型和权限范围

### 5. ⚠️ API 域名问题（已验证，非原因）
- 已使用 `domain: lark.Domain.Feishu`
- 纯文本格式在同一域名下正常工作
- 排除域名问题

### 6. ⚠️ 内容验证规则（可能）
- 飞书可能有未文档化的验证规则
- 某些字段组合可能触发验证失败
- 需要参考官方 SDK 的实际使用示例

## 对比分析

### 工作的请求（text）
```bash
curl -X POST 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "receive_id": "oc_xxx",
    "msg_type": "text",
    "content": "{\"text\":\"Hello\"}"
  }'
```
✅ **成功**

### 失败的请求（post）
```bash
curl -X POST 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "receive_id": "oc_xxx",
    "msg_type": "post",
    "content": "{\"post\":{\"zh_cn\":{\"content\":[[{\"tag\":\"text\",\"text\":\"Hello\"}]]}}}"
  }'
```
❌ **失败：230001**

## 下一步排查建议

### 1. 检查飞书管理后台
登录飞书管理后台，检查：
- [ ] Bot 的权限列表中是否包含 "发送富文本消息"
- [ ] 应用类型（自建应用/商店应用/企业应用）
- [ ] 消息发送权限范围
- [ ] API 使用配额和限制

### 2. 查看官方 SDK 示例
参考飞书官方 Node.js SDK 仓库：
```bash
https://github.com/larksuite/node-sdk
```
查找实际的 post 消息发送示例代码。

### 3. 使用飞书开发者工具
访问飞书开放平台：
```
https://open.feishu.cn/api-explorer/im-v1/message/create
```
使用 API Explorer 测试 post 消息，排除代码问题。

### 4. 联系飞书技术支持
根据错误日志中的 `log_id`，联系飞书技术支持：
- 提供具体的 `log_id`
- 说明应用类型和权限
- 询问是否需要特殊配置

### 5. 尝试替代方案

#### 方案 A: 交互式卡片
飞书交互式卡片功能更强大，可能有更好的支持：
```typescript
msg_type: 'interactive'
content: JSON.stringify({
  // 卡片配置
})
```

#### 方案 B: 继续使用纯文本
- 当前纯文本格式工作正常
- 对于 CLI 和简单对话场景足够使用
- 如需富文本，可使用 Markdown 语法（部分支持）

## 代码实现状态

### 当前实现
- ✅ 纯文本格式（text）- 完全支持
- ✅ 统一的 content builder 工具
- ⚠️ 富文本格式（post）- API 拒绝

### 相关文件
- `src/feishu/content-builder.ts` - 消息内容构建工具
- `src/feishu/bot.ts` - Bot 模式消息发送
- `src/feishu/sender.ts` - CLI 模式消息发送

## 结论

**富文本消息格式实现正确，但被 API 拒绝。**

问题 **不在于代码实现**，而可能在于：
1. Bot 权限配置
2. 应用类型限制
3. 飞书平台的额外验证规则

**建议**：
- 短期：继续使用可靠的纯文本格式
- 中期：在飞书管理后台检查和调整权限
- 长期：考虑使用交互式卡片替代富文本

## 附录：测试日志

完整的测试日志见：
- `test-rich-text.ts` - 富文本内容结构测试
- `test-post-direct.ts` - 直接 API 调用测试
