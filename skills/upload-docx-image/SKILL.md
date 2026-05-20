---
name: upload-docx-image
description: 在飞书文档指定位置插入图片（非末尾追加）。当 Agent 需要在飞书文档正文中插入图表、截图等图片时使用。Keywords: "上传飞书文档图片", "插入图片", "文档图片", "图片插入", "飞书文档", "inline image", "docx image".
allowed-tools: Bash
disable-model-invocation: true
---

# 上传飞书文档图片

在飞书文档的**指定位置**插入图片，解决 `lark-cli docs +media-insert` 只能追加到文档末尾的限制。

## 核心原理

`lark-cli docs +media-insert` 只能将图片追加到文档末尾。本 Skill 通过直接调用飞书 API 实现三步图片插入流程，支持在任意位置插入。

### 三步 API 流程

1. **创建空图片块** — `POST /open-apis/docx/v1/documents/{docId}/blocks/{docId}/children`
   - 在目标位置创建 `block_type: 27` 的空图片块
   - 返回新块的 `block_id`

2. **上传图片文件** — `POST /open-apis/drive/v1/medias/upload_all`
   - 通过 multipart/form-data 上传图片（`parent_type: "docx_image"`）
   - 返回 `file_token`

3. **绑定图片** — `PATCH /open-apis/docx/v1/documents/{docId}/blocks/{blockId}`
   - 通过 `replace_image` 将上传的文件绑定到空图片块

> **重要**: 图片块类型必须是 `block_type: 27`（不是 4，4 是 Heading2）

## 认证方式

本 Skill 使用 `lark-cli` 自带的认证方式：
- 从 `~/.lark-cli/config.json` 读取 `app_id` 和 `app_secret`
- 通过飞书 Auth API 获取 `tenant_access_token`
- **不自行处理凭据**，依赖 `lark-cli` 已完成的认证配置

如果 `lark-cli` 未认证，Skill 会提示用户先运行 `lark-cli config init`。

## 使用方法

```bash
DOC_ID="your_document_id" \
IMAGE_PATH="/path/to/image.png" \
INSERT_INDEX="3" \
npx tsx skills/upload-docx-image/upload-docx-image.ts
```

### 参数

| 参数 | 必需 | 说明 |
|------|------|------|
| `DOC_ID` | 是 | 飞书文档 ID（从文档 URL 中获取） |
| `IMAGE_PATH` | 是 | 图片文件绝对路径（支持 PNG/JPG/JPEG，最大 20MB） |
| `INSERT_INDEX` | 是 | 插入位置（0-based，-1 表示追加到末尾） |

### 典型工作流

```bash
# 1. 用 lark-cli 创建包含文本的文档
lark-cli docs +create --markdown @report.md
# → 返回 document_id

# 2. Agent 生成图表图片

# 3. 在指定位置插入图片
DOC_ID="xxx" IMAGE_PATH="./chart.png" INSERT_INDEX="3" \
  npx tsx skills/upload-docx-image/upload-docx-image.ts

# 4. 如有多张图片，重复步骤 2-3
```

## 错误处理

- **输入验证失败**: 立即退出并报告具体错误
- **认证失败**: 提示运行 `lark-cli config init`
- **步骤 2 或 3 失败**: 自动删除已创建的空图片块（回滚），防止文档中残留灰色占位符
- **文件不存在**: 提示检查路径

## 安全保证

- 文档 ID 验证（允许字母、数字、连字符、下划线）
- 图片文件扩展名白名单（PNG/JPG/JPEG）
- 文件大小限制（20MB）
- 路径解析为绝对路径，防止目录遍历

## 依赖

`lark-cli`（已认证） · Node.js（内置 fetch） · 无额外 npm 依赖

## 关联

- Issue: #2278
