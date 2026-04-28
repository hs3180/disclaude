---
name: upload-docx-image
description: 上传图片到飞书文档指定位置。Use when agent needs to insert an image into a Feishu document at a specific position. Keywords: "上传图片", "插入图片", "文档图片", "upload docx image", "insert image".
allowed-tools: [Bash]
---

# Upload Docx Image

Insert an image into a Feishu document at a specified position via lark-cli.

## Single Responsibility

- ✅ Upload an image file to a Feishu document at a specific index
- ✅ Validate document ID, image path, and index
- ✅ Handle partial failures with cleanup (remove orphaned blocks)
- ❌ DO NOT read FEISHU_APP_ID / FEISHU_APP_SECRET directly
- ❌ DO NOT create or delete documents
- ❌ DO NOT handle image format conversion

## Invocation

This skill is invoked by the agent when it needs to insert an image into a Feishu document at a specific position.

### Usage

```bash
DOCX_DOC_ID="doxcnXXXXXX" \
DOCX_IMAGE_PATH="/path/to/image.png" \
DOCX_IMAGE_INDEX="3" \
npx tsx skills/upload-docx-image/upload-docx-image.ts
```

Append mode (insert at end):

```bash
DOCX_DOC_ID="doxcnXXXXXX" \
DOCX_IMAGE_PATH="/path/to/image.png" \
DOCX_IMAGE_INDEX="-1" \
npx tsx skills/upload-docx-image/upload-docx-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOCX_DOC_ID` | Yes | Feishu document ID |
| `DOCX_IMAGE_PATH` | Yes | Local path to the image file |
| `DOCX_IMAGE_INDEX` | Yes | Insert position (0-based). Use -1 for append (end of document). |
| `DOCX_SKIP_LARK` | No | Set to '1' to skip lark-cli check (testing only) |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from message header)
- **Message ID**: Message ID (from message header)

## Execution Flow

```
Append mode (index = -1):
  1. Validate inputs
  2. Check lark-cli availability
  3. Call lark-cli docs +media-insert to upload image (appended at end)
  4. Done

Positional mode (index >= 0):
  1. Validate inputs
  2. Check lark-cli availability
  3. Upload image via lark-cli docs +media-insert (appended at end)
  4. Read document blocks to find the uploaded image's file_token
  5. Create empty image block (block_type: 27) at target index
  6. Bind file_token to empty block via replace_image
  7. Delete the extra image block at the end (cleanup)
  8. If any step fails after image upload: attempt cleanup of orphaned blocks
```

## When to Use

1. **Agent generates a report with images**: After creating a document and generating charts, insert images at the correct positions.
2. **Image positioning in documents**: When the default append behavior of `lark-cli docs +media-insert` is insufficient.

## Architecture

Uses **lark-cli** for all Feishu API calls — NOT through direct HTTP with custom auth. This follows the same pattern as:
- `rename-group` (group rename via `lark-cli api`)
- `chat-timeout` (group dissolution via `lark-cli api`)

The upload uses `lark-cli docs +media-insert` which handles authentication internally. Block manipulation uses `lark-cli api` for JSON API calls.

## Supported Image Formats

| Format | Extension | Max Size |
|--------|-----------|----------|
| PNG | `.png` | 20 MB |
| JPEG | `.jpg`, `.jpeg` | 20 MB |
| GIF | `.gif` | 20 MB |
| BMP | `.bmp` | 20 MB |
| WebP | `.webp` | 20 MB |

## Safety Guarantees

- **Input validation**: Document ID, image path, index are validated before any API calls
- **Partial failure cleanup**: If block creation or binding fails after image upload, orphaned blocks are deleted
- **Idempotent**: Re-running with the same inputs creates additional image blocks (Feishu API behavior)
- **No custom auth**: All API calls go through lark-cli's built-in authentication
