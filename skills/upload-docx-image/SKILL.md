---
name: upload-docx-image
description: |
  在飞书文档指定位置插入图片。Use when the agent needs to insert an image into a Feishu document at a specific position (not just appended at the end).
  Keywords: "上传飞书文档图片", "飞书文档插入图片", "docx image", "inline image", "insert image feishu", "文档图片".
argument-hint: "<doc_id> <image_path> [index]"
allowed-tools: Bash
---

# 上传飞书文档图片

在飞书文档的指定位置插入图片。解决 `lark-cli docs +media-insert` 只能追加到文档末尾的限制。

## Single Responsibility

- ✅ 在飞书文档指定位置插入图片（PNG/JPG/JPEG，最大 20MB）
- ✅ 验证输入参数（文档 ID、图片路径、插入位置）
- ✅ 三步 API 流程（创建空块 → 上传图片 → 绑定图片）+ 失败回滚
- ❌ DO NOT 创建或删除文档
- ❌ DO NOT 修改文档文本内容
- ❌ DO NOT 处理图片编辑/缩放

## 问题背景

`lark-cli docs +media-insert` 只能将图片追加到文档末尾，无法插入到指定位置。本 Skill 通过以下流程实现位置插入：

1. **创建空图片块**：在目标位置创建 `block_type: 27` 的空块
2. **上传图片**：借助 `lark-cli docs +media-insert` 完成多部分上传（lark-cli 自动处理认证和 multipart/form-data）
3. **绑定并清理**：将上传的图片绑定到目标位置的空块，删除末尾的临时块

## Prerequisites

- `lark-cli` 已安装且已认证。运行 `lark-cli auth status` 检查。
- 如果未认证，提醒用户运行 `lark-cli auth login --recommend`，然后重试。

## Input Parameters

调用此 Skill 时，需要以下参数：

| Parameter | Required | Description |
|-----------|----------|-------------|
| `DOC_ID` | Yes | 飞书文档 ID（从文档 URL 中获取） |
| `IMAGE_PATH` | Yes | 图片文件的绝对路径（支持 PNG/JPG/JPEG） |
| `INDEX` | Yes | 0-based 插入位置（-1 表示追加到末尾） |

DOC_ID 格式：允许字母、数字、下划线和连字符（`^[a-zA-Z0-9_-]+$`）。

## Execution Flow

### Step 0: 验证输入

```bash
# 验证 DOC_ID（放宽正则以覆盖实际飞书文档 ID 格式）
echo "$DOC_ID" | grep -qE '^[a-zA-Z0-9_-]+$' || { echo "ERROR: Invalid DOC_ID"; exit 1; }

# 验证图片文件
test -f "$IMAGE_PATH" || { echo "ERROR: Image file not found: $IMAGE_PATH"; exit 1; }
FILE_SIZE=$(stat -f%z "$IMAGE_PATH" 2>/dev/null || stat -c%s "$IMAGE_PATH" 2>/dev/null)
FILE_EXT=$(echo "${IMAGE_PATH##*.}" | tr '[:upper:]' '[:lower:]')
echo "$FILE_EXT" | grep -qE '^(png|jpg|jpeg)$' || { echo "ERROR: Unsupported image format (use PNG/JPG/JPEG)"; exit 1; }
[ "$FILE_SIZE" -gt 20971520 ] && { echo "ERROR: Image too large (max 20MB)"; exit 1; }
[ "$FILE_SIZE" -eq 0 ] && { echo "ERROR: Image file is empty"; exit 1; }

# 验证 INDEX
echo "$INDEX" | grep -qE '^-?[0-9]+$' || { echo "ERROR: Invalid INDEX (must be integer >= -1)"; exit 1; }
[ "$INDEX" -lt -1 ] && { echo "ERROR: INDEX must be >= -1"; exit 1; }

# 验证 lark-cli 认证
lark-cli auth status > /dev/null 2>&1 || { echo "ERROR: lark-cli not authenticated. Run: lark-cli auth login --recommend"; exit 1; }
```

### Step 1: 在目标位置创建空图片块

```bash
# 构建 request body
if [ "$INDEX" -ge 0 ]; then
  BODY="{\"children\":[{\"block_type\":27}],\"index\":$INDEX}"
else
  BODY="{\"children\":[{\"block_type\":27}]}"
fi

# 创建空图片块
STEP1_RESPONSE=$(lark-cli api POST "/open-apis/docx/v1/documents/$DOC_ID/blocks/$DOC_ID/children" \
  --data "$BODY" --format json)

# 检查响应
STEP1_CODE=$(echo "$STEP1_RESPONSE" | jq -r '.code // empty')
if [ "$STEP1_CODE" != "0" ] && [ "$STEP1_CODE" != "null" ]; then
  echo "ERROR: Step 1 failed (create block): $(echo "$STEP1_RESPONSE" | jq -r '.msg // "unknown error"')"
  exit 1
fi

TARGET_BLOCK_ID=$(echo "$STEP1_RESPONSE" | jq -r '.data.children[0].block_id // empty')
if [ -z "$TARGET_BLOCK_ID" ]; then
  echo "ERROR: Step 1 returned no block_id"
  exit 1
fi
echo "INFO: Created empty image block $TARGET_BLOCK_ID at index $INDEX"
```

### Step 2: 上传图片（借助 +media-insert 处理 multipart）

```bash
# 使用 lark-cli docs +media-insert 将图片追加到文档末尾
# 这一步 lark-cli 自动处理认证和 multipart/form-data 上传
lark-cli docs +media-insert "$DOC_ID" "$IMAGE_PATH" 2>&1
if [ $? -ne 0 ]; then
  echo "ERROR: Step 2 failed (upload image via +media-insert)"
  # 清理：删除步骤 1 创建的空块
  echo "INFO: Cleaning up empty block $TARGET_BLOCK_ID..."
  lark-cli api DELETE "/open-apis/docx/v1/documents/$DOC_ID/blocks/$TARGET_BLOCK_ID" --format json 2>/dev/null || true
  exit 1
fi
```

### Step 3: 获取上传图片的 file_token

```bash
# 获取文档所有块，找到末尾的图片块
BLOCKS_RESPONSE=$(lark-cli api GET "/open-apis/docx/v1/documents/$DOC_ID/blocks/$DOC_ID/children" --format json)

# 提取最后一个图片块的 file_token
LAST_BLOCK=$(echo "$BLOCKS_RESPONSE" | jq '.data.items[-1]')
APPENDED_BLOCK_ID=$(echo "$LAST_BLOCK" | jq -r '.block_id')
APPENDED_BLOCK_TYPE=$(echo "$LAST_BLOCK" | jq -r '.block_type')
FILE_TOKEN=$(echo "$LAST_BLOCK" | jq -r '.image.token // empty')

# 验证
if [ -z "$FILE_TOKEN" ] || [ "$APPENDED_BLOCK_TYPE" != "27" ]; then
  echo "ERROR: Step 3 failed (could not extract file_token from appended block)"
  # 清理
  echo "INFO: Cleaning up empty block $TARGET_BLOCK_ID..."
  lark-cli api DELETE "/open-apis/docx/v1/documents/$DOC_ID/blocks/$TARGET_BLOCK_ID" --format json 2>/dev/null || true
  exit 1
fi
echo "INFO: Got file_token $FILE_TOKEN from appended block $APPENDED_BLOCK_ID"
```

### Step 4: 将图片绑定到目标空块

```bash
lark-cli api PATCH "/open-apis/docx/v1/documents/$DOC_ID/blocks/$TARGET_BLOCK_ID" \
  --data "{\"replace_image\":{\"token\":\"$FILE_TOKEN\"}}" --format json

if [ $? -ne 0 ]; then
  echo "ERROR: Step 4 failed (bind image to block)"
  # 清理：删除空块和末尾多余的块
  echo "INFO: Cleaning up..."
  lark-cli api DELETE "/open-apis/docx/v1/documents/$DOC_ID/blocks/$TARGET_BLOCK_ID" --format json 2>/dev/null || true
  exit 1
fi
echo "INFO: Bound image to block $TARGET_BLOCK_ID"
```

### Step 5: 删除末尾多余的图片块

```bash
# 获取块数量，删除末尾的临时块
TOTAL=$(echo "$BLOCKS_RESPONSE" | jq '.data.items | length')
LAST_INDEX=$((TOTAL - 1))

lark-cli api POST "/open-apis/docx/v1/documents/$DOC_ID/blocks/$DOC_ID/children/batch_delete" \
  --data "{\"start_index\":$LAST_INDEX,\"end_index\":$((LAST_INDEX + 1))}" --format json 2>&1

if [ $? -ne 0 ]; then
  echo "WARN: Step 5 failed (delete appended block) — document may have duplicate image at end"
  echo "WARN: Please manually remove the extra image block at the end of the document"
else
  echo "INFO: Cleaned up temporary block at the end"
fi
```

### 输出结果

```
OK: Image inserted successfully
  doc_id: {DOC_ID}
  block_id: {TARGET_BLOCK_ID}
  file_token: {FILE_TOKEN}
  position: index {INDEX}
```

## Complete One-Shot Script

**Always run this as the primary method** — 将以下脚本写入临时文件并执行：

```bash
cat > /tmp/upload-docx-image.sh << 'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

DOC_ID="${1:?Usage: upload-docx-image.sh <doc_id> <image_path> [index]}"
IMAGE_PATH="${2:?Usage: upload-docx-image.sh <doc_id> <image_path> [index]}"
INDEX="${3:--1}"

# --- Input validation ---
echo "$DOC_ID" | grep -qE '^[a-zA-Z0-9_-]+$' || { echo "ERROR: Invalid DOC_ID"; exit 1; }
[ -f "$IMAGE_PATH" ] || { echo "ERROR: Image file not found: $IMAGE_PATH"; exit 1; }
FILE_EXT=$(echo "${IMAGE_PATH##*.}" | tr '[:upper:]' '[:lower:]')
echo "$FILE_EXT" | grep -qE '^(png|jpg|jpeg)$' || { echo "ERROR: Unsupported format (PNG/JPG/JPEG)"; exit 1; }
FILE_SIZE=$(stat -c%s "$IMAGE_PATH" 2>/dev/null || stat -f%z "$IMAGE_PATH" 2>/dev/null)
[ "$FILE_SIZE" -gt 20971520 ] && { echo "ERROR: Image too large (max 20MB)"; exit 1; }
[ "$FILE_SIZE" -eq 0 ] && { echo "ERROR: Image file is empty"; exit 1; }
echo "$INDEX" | grep -qE '^-?[0-9]+$' || { echo "ERROR: Invalid INDEX"; exit 1; }
[ "$INDEX" -lt -1 ] && { echo "ERROR: INDEX must be >= -1"; exit 1; }

# --- Check lark-cli auth ---
lark-cli auth status > /dev/null 2>&1 || { echo "ERROR: lark-cli not authenticated. Run: lark-cli auth login --recommend"; exit 1; }

# --- Step 1: Create empty image block at target position ---
if [ "$INDEX" -ge 0 ]; then
  BODY="{\"children\":[{\"block_type\":27}],\"index\":$INDEX}"
else
  BODY="{\"children\":[{\"block_type\":27}]}"
fi

STEP1=$(lark-cli api POST "/open-apis/docx/v1/documents/$DOC_ID/blocks/$DOC_ID/children" --data "$BODY" --format json 2>&1) || {
  echo "ERROR: Step 1 failed (create block): $STEP1"
  exit 1
}

STEP1_CODE=$(echo "$STEP1" | jq -r '.code // empty' 2>/dev/null)
if [ "$STEP1_CODE" != "0" ] && [ "$STEP1_CODE" != "null" ]; then
  echo "ERROR: Step 1 API error: $(echo "$STEP1" | jq -r '.msg // "unknown"' 2>/dev/null)"
  exit 1
fi

TARGET_BLOCK_ID=$(echo "$STEP1" | jq -r '.data.children[0].block_id // empty' 2>/dev/null)
[ -z "$TARGET_BLOCK_ID" ] && { echo "ERROR: No block_id returned from Step 1"; exit 1; }
echo "INFO: Created empty block $TARGET_BLOCK_ID at index $INDEX"

# --- Step 2: Upload image via +media-insert ---
lark-cli docs +media-insert "$DOC_ID" "$IMAGE_PATH" > /dev/null 2>&1 || {
  echo "ERROR: Step 2 failed (upload image)"
  echo "INFO: Cleaning up empty block..."
  lark-cli api DELETE "/open-apis/docx/v1/documents/$DOC_ID/blocks/$TARGET_BLOCK_ID" --format json > /dev/null 2>&1 || true
  exit 1
}

# --- Step 3: Get file_token from appended block ---
BLOCKS=$(lark-cli api GET "/open-apis/docx/v1/documents/$DOC_ID/blocks/$DOC_ID/children" --format json 2>&1)
LAST_BLOCK=$(echo "$BLOCKS" | jq '.data.items[-1]' 2>/dev/null)
FILE_TOKEN=$(echo "$LAST_BLOCK" | jq -r '.image.token // empty' 2>/dev/null)
APPENDED_ID=$(echo "$LAST_BLOCK" | jq -r '.block_id // empty' 2>/dev/null)

if [ -z "$FILE_TOKEN" ]; then
  echo "ERROR: Could not extract file_token from appended block"
  echo "INFO: Cleaning up..."
  lark-cli api DELETE "/open-apis/docx/v1/documents/$DOC_ID/blocks/$TARGET_BLOCK_ID" --format json > /dev/null 2>&1 || true
  exit 1
fi
echo "INFO: Got file_token from appended block"

# --- Step 4: Bind image to target block ---
lark-cli api PATCH "/open-apis/docx/v1/documents/$DOC_ID/blocks/$TARGET_BLOCK_ID" \
  --data "{\"replace_image\":{\"token\":\"$FILE_TOKEN\"}}" --format json > /dev/null 2>&1 || {
  echo "ERROR: Step 4 failed (bind image)"
  echo "INFO: Cleaning up..."
  lark-cli api DELETE "/open-apis/docx/v1/documents/$DOC_ID/blocks/$TARGET_BLOCK_ID" --format json > /dev/null 2>&1 || true
  exit 1
}
echo "INFO: Bound image to block $TARGET_BLOCK_ID"

# --- Step 5: Delete appended block at end ---
TOTAL=$(echo "$BLOCKS" | jq '.data.items | length' 2>/dev/null)
LAST_IDX=$((TOTAL - 1))
lark-cli api POST "/open-apis/docx/v1/documents/$DOC_ID/blocks/$DOC_ID/children/batch_delete" \
  --data "{\"start_index\":$LAST_IDX,\"end_index\":$((LAST_IDX + 1))}" --format json > /dev/null 2>&1 || {
  echo "WARN: Could not delete temporary block at end — please remove manually"
}

# --- Done ---
POSITION="end (append)"
[ "$INDEX" -ge 0 ] && POSITION="index $INDEX"
echo "OK: Image inserted successfully"
echo "  doc_id: $DOC_ID"
echo "  block_id: $TARGET_BLOCK_ID"
echo "  file_token: $FILE_TOKEN"
echo "  position: $POSITION"
SCRIPT
chmod +x /tmp/upload-docx-image.sh
```

运行：
```bash
bash /tmp/upload-docx-image.sh <DOC_ID> <IMAGE_PATH> [INDEX]
```

## 错误处理与回滚

| 失败步骤 | 回滚操作 |
|---------|---------|
| Step 1 (创建空块) | 无需回滚（API 调用失败，无副作用） |
| Step 2 (上传图片) | DELETE 目标空块 |
| Step 3 (获取 file_token) | DELETE 目标空块 + 可能需要手动删除末尾图片 |
| Step 4 (绑定图片) | DELETE 目标空块 |
| Step 5 (删除末尾块) | 警告用户手动删除末尾多余图片 |

## 典型使用场景

```bash
# 1. 创建文档（文本内容）
lark-cli docs +create --api-version v2 --doc-format markdown --content '<title>Report</title>...'

# 2. 生成图表
# (agent 创建图片文件)

# 3. 在第 3 个位置插入图片
bash /tmp/upload-docx-image.sh "doccnxxxxx" "/path/to/chart.png" 3

# 4. 在末尾追加图片
bash /tmp/upload-docx-image.sh "doccnxxxxx" "/path/to/chart.png" -1
```

## DO NOT

- ❌ DO NOT 直接读取 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 环境变量 — 统一使用 lark-cli 认证
- ❌ DO NOT 在 Skill 脚本中添加单元测试 — 作为 Skill 级别脚本不需要 `__tests__/` 目录
- ❌ DO NOT 使用 `block_type: 4`（那是 Heading2）— 图片块必须使用 `block_type: 27`
- ❌ DO NOT 忽略部分失败 — 步骤 2-4 失败时必须清理已创建的空块
