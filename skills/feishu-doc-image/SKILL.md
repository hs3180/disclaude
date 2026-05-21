---
name: 上传飞书文档图片
description: "Insert an image into a Feishu document at a specific position (not just appended at the end). Use when the agent needs to insert images inline in a Feishu doc, generate illustrated reports with proper image placement. Keywords: '上传飞书文档图片', '插入图片', '文档图片', '图片插入', 'image insertion', '飞书文档图片', 'feishu doc image', 'docx image'."
allowed-tools: [Bash, Read, Glob, Grep]
---

# 上传飞书文档图片 — Feishu Document Image Insertion

在飞书文档的**指定位置**插入图片。解决 `lark-cli docs +media-insert` 只能追加到文档末尾的限制。

**适用于**: 插入图片到指定位置、生成图文并茂的文档 | **不适用于**: 创建/删除文档、修改文档文字

## Single Responsibility

- ✅ Insert an image at a specific position in a Feishu document
- ✅ Validate inputs (document ID, image file, position)
- ✅ Handle the 3-step Lark API process (create block → upload → bind)
- ✅ Cleanup empty blocks on partial failure
- ❌ DO NOT create or delete documents
- ❌ DO NOT modify document text content
- ❌ DO NOT handle image editing/resizing

## Problem

`lark-cli docs +media-insert` only appends images to the end of a document. This skill uses the Lark API directly to insert images at arbitrary positions via a 3-step process:

1. **Create Block** — Create an empty image block (`block_type: 27`) at the desired index
2. **Upload Image** — Upload the image file via multipart/form-data (`parent_type: "docx_image"`)
3. **Bind Image** — Bind the uploaded file to the empty block via `replace_image`

## Context Variables

When invoked, you receive:
- **DOC_ID**: Feishu document ID (from doc URL, e.g. `https://xxx.feishu.cn/docx/DOCNMxxxxxx`)
- **IMAGE_PATH**: Absolute path to the image file
- **INSERT_INDEX**: 0-based position to insert at (-1 or omitted to append to end)

## Prerequisites

### Check lark-cli

```bash
lark-cli --version || { echo "ERROR: lark-cli not found. Install from https://github.com/larksuite/cli"; exit 1; }
```

### Check lark-cli authentication

```bash
lark-cli auth status || { echo "ERROR: lark-cli not authenticated. Run 'lark-cli auth init' first."; exit 1; }
```

If lark-cli is not authenticated, **stop and inform the user** to run `lark-cli auth init` first. Do NOT proceed.

## Step-by-Step Workflow

### Step 0: Read lark-cli credentials

Read the lark-cli config to get `app_id` and `app_secret`. The config is stored at one of these paths (check in order):

```bash
# Linux
cat ~/.config/lark-cli/config.json 2>/dev/null
# macOS
cat ~/Library/Application\ Support/lark-cli/config.json 2>/dev/null
# Alternative paths
cat ~/.config/lark/config.json 2>/dev/null
cat ~/.lark-cli/config.json 2>/dev/null
```

If no config file is found, check environment fallback:

```bash
# Some setups store credentials in env vars
echo "${FEISHU_APP_ID:-}"
echo "${FEISHU_APP_SECRET:-}"
```

Extract `app_id` and `app_secret` from the config JSON. The format is typically:

```json
{
  "app_id": "cli_xxxxx",
  "app_secret": "xxxxx",
  "domain": "feishu.cn"
}
```

If the config format differs, adapt by finding the `app_id` and `app_secret` fields.

### Step 1: Get tenant_access_token

```bash
curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\": \"${APP_ID}\", \"app_secret\": \"${APP_SECRET}\"}"
```

Parse the response and extract `tenant_access_token`. If `code` is not 0, report the error and stop.

```bash
TOKEN=$(echo "$RESPONSE" | grep -o '"tenant_access_token":"[^"]*"' | head -1 | cut -d'"' -f4)
```

### Step 2: Validate inputs

**DOC_ID**: Extract from Feishu document URL if a URL is provided. A valid DOC_ID is the alphanumeric segment after `/docx/` in the URL (may contain underscores or hyphens).

```bash
# Extract DOC_ID from URL if needed
if [[ "$DOC_ID" == *"feishu.cn"* ]]; then
  DOC_ID=$(echo "$DOC_ID" | grep -o '/docx/[A-Za-z0-9_-]*' | head -1 | cut -d'/' -f3)
fi
```

**IMAGE_PATH**: Verify the file exists and is a supported format (PNG, JPG, JPEG).

```bash
if [ ! -f "$IMAGE_PATH" ]; then
  echo "ERROR: Image file not found: ${IMAGE_PATH}"
  exit 1
fi

EXT="${IMAGE_PATH##*.}"
case "$EXT" in
  png|jpg|jpeg) ;;
  *) echo "ERROR: Unsupported image format '${EXT}'. Use PNG, JPG, or JPEG."; exit 1 ;;
esac

SIZE=$(stat -f%z "$IMAGE_PATH" 2>/dev/null || stat -c%s "$IMAGE_PATH" 2>/dev/null)
if [ "$SIZE" -eq 0 ]; then
  echo "ERROR: Image file is empty"
  exit 1
fi
if [ "$SIZE" -gt 20971520 ]; then
  echo "ERROR: Image file too large ($(echo "scale=1; $SIZE/1048576" | bc) MB, max: 20 MB)"
  exit 1
fi
```

**INSERT_INDEX**: Default to -1 (append) if not specified.

### Step 3: Create empty image block

```bash
# Build request body
if [ "$INSERT_INDEX" -ge 0 ]; then
  BODY="{\"children\":[{\"block_type\":27}],\"index\":${INSERT_INDEX}}"
else
  BODY='{"children":[{"block_type":27}]}'
fi

STEP1_RESPONSE=$(curl -s -X POST \
  "https://open.feishu.cn/open-apis/docx/v1/documents/${DOC_ID}/blocks/${DOC_ID}/children" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$BODY")
```

**Important**: Use `block_type: 27` (image block). Do NOT use `block_type: 4` (which is Heading2).

Parse the response to extract `block_id`:

```bash
BLOCK_ID=$(echo "$STEP1_RESPONSE" | grep -o '"block_id":"[^"]*"' | head -1 | cut -d'"' -f4)
```

If the response `code` is not 0, or `BLOCK_ID` is empty, report the error and stop.

### Step 4: Upload image file

```bash
STEP2_RESPONSE=$(curl -s -X POST \
  "https://open.feishu.cn/open-apis/drive/v1/medias/upload_all" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "parent_type=docx_image" \
  -F "parent_node=${DOC_ID}" \
  -F "file=@${IMAGE_PATH}")
```

Parse the response to extract `file_token`:

```bash
FILE_TOKEN=$(echo "$STEP2_RESPONSE" | grep -o '"file_token":"[^"]*"' | head -1 | cut -d'"' -f4)
```

If the response `code` is not 0, or `FILE_TOKEN` is empty:
1. **Cleanup**: Delete the empty block created in Step 3
2. Report the error and stop

```bash
# Cleanup: delete empty block
curl -s -X DELETE \
  "https://open.feishu.cn/open-apis/docx/v1/documents/${DOC_ID}/blocks/${BLOCK_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json"
```

### Step 5: Bind image to block

```bash
STEP3_RESPONSE=$(curl -s -X PATCH \
  "https://open.feishu.cn/open-apis/docx/v1/documents/${DOC_ID}/blocks/${BLOCK_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"replace_image\":{\"token\":\"${FILE_TOKEN}\"}}")
```

If the response `code` is not 0:
1. **Cleanup**: Delete the empty block created in Step 3
2. Report the error and stop

### Step 6: Report success

```
Image inserted successfully.
  Document: {DOC_ID}
  Block ID: {BLOCK_ID}
  File Token: {FILE_TOKEN}
  Position: index {INSERT_INDEX} (or "end (append)" if -1)
```

## Cleanup on Partial Failure

If **Step 4** (upload) or **Step 5** (bind) fails, you MUST clean up the empty image block created in Step 3:

```bash
curl -s -X DELETE \
  "https://open.feishu.cn/open-apis/docx/v1/documents/${DOC_ID}/blocks/${BLOCK_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json"
```

This prevents leaving orphaned empty blocks in the document.

## Typical Workflow

```bash
# 1. Create document with text content using lark-cli
lark-cli docs +create --markdown @report.md
# → returns document_id

# 2. Generate chart/diagram (agent creates the image file)

# 3. Insert image at the right position using this skill
# Follow steps 0-6 above

# 4. Repeat for additional images
```

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not in PATH | Report: "lark-cli 未安装，请先安装 https://github.com/larksuite/cli" |
| `lark-cli` not authenticated | Report: "lark-cli 未认证，请先运行 `lark-cli auth init`" |
| Config file not found | Report: "找不到 lark-cli 配置文件，请确认已运行 `lark-cli auth init`" |
| Auth API returns non-zero code | Report error details, suggest checking credentials |
| Step 3 fails (create block) | Report error, no cleanup needed (no block created) |
| Step 4 fails (upload) | Delete empty block, report error |
| Step 5 fails (bind) | Delete empty block, report error |
| Invalid DOC_ID format | Report: "无效的文档 ID" |
| Image file not found | Report: "图片文件不存在" |
| Image too large (>20 MB) | Report: "图片文件过大" |

## Design Principles

1. **Auth via lark-cli only** — No separate FEISHU_APP_ID/FEISHU_APP_SECRET env vars; use lark-cli's configured credentials
2. **Always cleanup on failure** — Never leave orphaned empty blocks
3. **Correct block_type** — Always use `block_type: 27` for image blocks
4. **Idempotent reads** — Reading config and checking auth are safe to repeat
5. **Report actionable errors** — Tell users what to do, not just what went wrong

## Key API Reference

- [Create document block children](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block-children/create)
- [Upload file](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all) (`parent_type: "docx_image"`)
- [Update block](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block/update) (`replace_image`)
- [Document FAQ - How to insert images](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/faq)
- [lark-cli issue #130](https://github.com/larksuite/cli/issues/130) (upstream `--index` support)
