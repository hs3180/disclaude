---
name: upload-feishu-doc-image
description: Upload and insert an image into a Feishu document at a specific position. Use when the agent needs to embed charts, screenshots, or any image into a Feishu doc at a precise location (not just appended at the end). Keywords: "上传飞书文档图片", "insert image feishu", "飞书图片", "文档图片插入", "inline image".
allowed-tools: [Bash]
---

# Upload Feishu Doc Image

Insert an image into a Feishu document at a specific position using lark-cli.

## Single Responsibility

- ✅ Insert an image at a specified index in a Feishu document
- ✅ Validate document ID and image file
- ✅ Automatic rollback on partial failure
- ❌ DO NOT create or manage documents
- ❌ DO NOT handle lark-cli authentication (must be pre-configured)
- ❌ DO NOT modify existing blocks

## Invocation

This skill is invoked when the agent needs to insert an image into a Feishu document at a specific position, typically after generating a chart or screenshot that should appear inline with text content.

### Usage

```bash
FEISHU_DOC_ID="doccnxxxxxx" \
FEISHU_IMAGE_PATH="/tmp/chart.png" \
FEISHU_IMAGE_INDEX="3" \
npx tsx skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FEISHU_DOC_ID` | Yes | Feishu document ID |
| `FEISHU_IMAGE_PATH` | Yes | Local path to the image file (PNG, JPG, WEBP, GIF, BMP) |
| `FEISHU_IMAGE_INDEX` | No | Insert position (0-based integer, `-1` or omit to append to end) |
| `FEISHU_SKIP_LARK` | No | Set to `1` for dry-run testing |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)

## Execution Flow

```
1. Validate FEISHU_DOC_ID and FEISHU_IMAGE_PATH
2. Check lark-cli availability and authentication
3. Step 1: Create empty image block (block_type: 27) at specified index
4. Step 2: Upload image file via Drive Media API
5. Step 3: Bind uploaded file to image block (replace_image)
6. On failure in step 2/3: automatically delete the empty block (rollback)
```

## When to Use

1. **Document with charts/reports**: After generating a chart image, insert it at the correct position alongside explanatory text
2. **Screenshot documentation**: Insert screenshots at specific locations in a Feishu doc
3. **Any inline image**: When you need precise control over where the image appears in the document

## Prerequisites

- **lark-cli** must be installed and authenticated (`lark-cli token --access` returns a valid token)
- The Feishu document must already exist
- The bot must have edit access to the target document

## Architecture

This skill uses **lark-cli** for API calls (create block, bind image) and **curl** for multipart file upload (lark-cli does not support file uploads). Authentication is handled entirely by lark-cli's built-in mechanism.

### Three-Step API Flow

1. **Create empty image block**: `POST /open-apis/docx/v1/documents/{id}/blocks/{id}/children` with `block_type: 27`
2. **Upload image**: `POST /open-apis/drive/v1/medias/upload_all` with `parent_type: docx_image`
3. **Bind image**: `PATCH /open-apis/docx/v1/documents/{id}/blocks/{block_id}` with `replace_image`

## Safety Guarantees

- **Input validation**: Document ID format, image file existence/size/format
- **Rollback**: If upload or bind fails, the empty block is automatically deleted
- **Idempotent blocks**: Feishu API handles duplicate block creation gracefully
- **No credential handling**: Relies entirely on lark-cli's authentication
