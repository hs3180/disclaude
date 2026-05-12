---
name: upload-feishu-doc-image
description: Upload and insert an image into a Feishu document at a specific position. Use when the agent needs to embed charts, screenshots, or any image into a Feishu doc at a precise location (not just appended at the end). Keywords: "上传飞书文档图片", "insert image feishu", "飞书图片", "文档图片插入", "inline image".
allowed-tools: [Bash]
---

# Upload Feishu Doc Image

Insert an image into a Feishu document at a specific position (not just appended at the end).

## Single Responsibility

- ✅ Upload a local image and insert it into a Feishu document at a specified index
- ✅ Validate inputs (doc ID, image path, file size)
- ✅ Handle partial failures gracefully
- ❌ DO NOT create or modify documents
- ❌ DO NOT use direct FEISHU_APP_ID/FEISHU_APP_SECRET credentials
- ❌ DO NOT append images to the end (use index parameter for positioning)

## Invocation

This skill is invoked by the agent when it needs to embed an image into a Feishu document at a specific position.

### Usage

```bash
FEISHU_DOC_ID="your_doc_id" \
FEISHU_DOC_IMAGE_PATH="/path/to/image.png" \
FEISHU_DOC_IMAGE_INDEX="3" \
npx tsx skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FEISHU_DOC_ID` | Yes | Feishu document ID (alphanumeric, underscores/hyphens allowed) |
| `FEISHU_DOC_IMAGE_PATH` | Yes | Local file path to the image (max 20 MB) |
| `FEISHU_DOC_IMAGE_INDEX` | No | 0-based position to insert at; omit to append at end |
| `FEISHU_DOC_SKIP_LARK` | No | Set to '1' for dry-run (skip lark-cli calls, testing only) |

### Context Variables

When invoked, you receive:
- **Feishu document ID**: The target document to insert the image into
- **Image path**: The local path to the image file (chart, screenshot, etc.)
- **Insert position**: The desired position in the document (optional)

## Execution Flow

```
1. Validate FEISHU_DOC_ID (alphanumeric + hyphens/underscores)
2. Validate FEISHU_DOC_IMAGE_PATH (exists, is file, size ≤ 20 MB)
3. Validate FEISHU_DOC_IMAGE_INDEX (non-negative integer, if provided)
4. Check lark-cli availability and auth status
5. Upload image → get file_token (POST /open-apis/drive/v1/medias/upload_all)
6. Create image block with file_token at index (POST /open-apis/docx/v1/documents/{id}/blocks/{id}/children)
7. Report success with block_id
```

## Architecture

All API calls use **lark-cli** for authentication and HTTP requests:

- `lark-cli api POST ...` for JSON API calls
- `lark-cli api POST ... --file ...` for multipart/form-data uploads

No direct credential handling — lark-cli manages auth tokens internally.

## Error Handling

- **Upload fails**: No cleanup needed — nothing was created in the document
- **Block creation fails**: The uploaded image is orphaned but harmless
- **lark-cli not authenticated**: Clear error message asking user to run `lark-cli auth login`

## When to Use

1. **Generated charts/reports**: After generating a chart image, insert it at the correct position in a report document
2. **Screenshots**: Insert screenshots at specific locations in documentation
3. **Illustrated documents**: Add images to specific positions in illustrated documents

## Safety Guarantees

- **Input validation**: Doc ID, image path, and file size are validated before any API calls
- **No credential exposure**: Uses lark-cli's built-in auth, never reads FEISHU_APP_ID/FEISHU_APP_SECRET
- **Size limit**: Images over 20 MB are rejected
- **Idempotent-ish**: Re-running with the same image creates a new block (not a duplicate insert)
