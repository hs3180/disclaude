---
name: insert-docx-image
description: Insert an image at a specific position in a Feishu document. Use when generating documents with inline images, charts, or diagrams that need to appear at precise locations (not just at the end). Keywords: "插入图片", "文档图片", "inline image", "docx image", "飞书文档图片", "insert image".
allowed-tools: [Bash]
---

# Insert Docx Image Skill

Insert an image at a specific position in a Feishu document using the 3-step Feishu Document API flow.

## Single Responsibility

- ✅ Insert an image at a precise position in a Feishu document
- ✅ Validate document ID, image path, and index parameters
- ✅ Handle the 3-step API flow (create block → upload → bind)
- ❌ DO NOT create or manage documents (use lark-cli docs commands)
- ❌ DO NOT send messages or cards
- ❌ DO NOT handle non-image media types

## Problem This Solves

`lark-cli docs +media-insert` only appends images to the **end** of documents, causing images and their related text to be separated. This skill inserts images at the correct position, enabling properly formatted reports, research documents, and data analyses.

## Usage

```bash
DOCX_DOCUMENT_ID="your_doc_id" \
DOCX_IMAGE_PATH="/path/to/image.png" \
DOCX_INSERT_INDEX="5" \
npx tsx skills/insert-docx-image/insert-docx-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOCX_DOCUMENT_ID` | Yes | Feishu document ID (from URL or `docs +create` output) |
| `DOCX_IMAGE_PATH` | Yes | Local path to the image file (png, jpg, gif, bmp) |
| `DOCX_INSERT_INDEX` | No | Position index (0-based). Default: `-1` (append to end) |
| `DOCX_SKIP_API` | No | Set to `1` for dry-run testing (validates inputs only) |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from message header) — not used directly, but context awareness

You need to provide:
- **Document ID**: The target Feishu document ID (usually obtained from `lark-cli docs +create`)
- **Image Path**: Path to the image file on disk
- **Insert Index**: Where to insert (0 = beginning, -1 = end, N = after Nth block)

## How It Works

The script performs 3 Feishu API calls:

1. **Create empty image block** at the desired position
   - `POST /open-apis/docx/v1/documents/{id}/blocks/{id}/children`
   - Creates a `block_type: 27` (image) block at the specified `index`

2. **Upload the image file** to Feishu Drive
   - `POST /open-apis/drive/v1/medias/upload_all`
   - Multipart upload with `parent_type: "docx_image"`

3. **Bind the uploaded file** to the empty image block
   - `PATCH /open-apis/docx/v1/documents/{id}/blocks/{image_block_id}`
   - Uses `replace_image` to associate the file with the block

## Typical Workflow

When generating a document with images:

```bash
# 1. Create the document with initial text
lark-cli docs +create --markdown @report.md

# 2. Extract document_id from output (e.g., "okcnAbcDef123")

# 3. Insert images at specific positions
DOCX_DOCUMENT_ID="okcnAbcDef123" \
DOCX_IMAGE_PATH="./charts/sales_chart.png" \
DOCX_INSERT_INDEX="3" \
npx tsx skills/insert-docx-image/insert-docx-image.ts

# 4. Insert more images as needed
DOCX_DOCUMENT_ID="okcnAbcDef123" \
DOCX_IMAGE_PATH="./charts/growth.png" \
DOCX_INSERT_INDEX="8" \
npx tsx skills/insert-docx-image/insert-docx-image.ts
```

## Architecture

Document operations use **lark-cli** and **Node.js fetch** to call Feishu API directly — NOT through IPC Channel. This follows the same pattern as:
- `rename-group.ts` (group operations via lark-cli)
- `chat-timeout.ts` (group dissolution via lark-cli)

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `Invalid document ID` | Wrong format | Verify document ID from URL |
| `Image file not found` | Path doesn't exist | Check file path |
| `Unsupported image format` | Non-image file | Use png/jpg/gif/bmp |
| `API error: invalid param` | Invalid index or block | Check document structure |
| `Auth failed` | lark-cli not configured | Run `lark-cli auth` |

## Safety Guarantees

- **Input validation**: Document ID format, image file existence, supported format
- **Index bounds check**: Warns if index is negative (except -1) or exceeds reasonable bounds
- **Idempotent**: Running twice creates two image blocks (expected behavior)
- **No IPC**: Direct API calls, no worker→primary message passing
- **Atomic-ish**: If step 3 fails, the empty image block remains (can be manually deleted)
