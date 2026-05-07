---
name: upload-feishu-doc-image
description: Upload and insert an image into a Feishu document at a specific position. Use when the agent needs to embed charts, screenshots, or any image into a Feishu doc at a precise location (not just appended at the end). Keywords: "上传飞书文档图片", "insert image feishu", "飞书图片", "文档图片插入", "inline image".
allowed-tools: [Bash]
---

# Upload Feishu Document Image

Insert an image into a Feishu document at a specific position using lark-cli.

## Single Responsibility

- ✅ Upload an image file and insert it at a specific position in a Feishu document
- ✅ Support index-based positioning (0-based) and append mode (index = -1)
- ✅ Validate document ID, image path, and index
- ✅ Rollback (delete empty block) on partial failure
- ❌ DO NOT read FEISHU_APP_ID or FEISHU_APP_SECRET directly — use lark-cli authentication only
- ❌ DO NOT create or manage documents
- ❌ DO NOT handle image conversion or resizing

## Invocation

This skill is invoked by the agent when it needs to insert an image into a Feishu document at a specific position.

### Usage

```bash
DOC_ID="docxXXXXXX" \
IMAGE_PATH="/path/to/image.png" \
INDEX=5 \
npx tsx skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_ID` | Yes | Feishu document ID (alphanumeric, may contain underscores/hyphens) |
| `IMAGE_PATH` | Yes | Absolute path to the image file (PNG, JPG, JPEG, GIF, BMP, WebP) |
| `INDEX` | No | Insert position (0-based). -1 or unset = append to end. Must be >= -1 |
| `UPLOAD_SKIP_LARK` | No | Set to '1' to skip lark-cli calls (dry-run testing only) |

### Context Variables

When invoked, you receive:
- **DOC_ID**: The target Feishu document ID (from the document URL or context)
- **IMAGE_PATH**: The local file path of the image to insert
- **INDEX**: The desired position in the document (optional, defaults to append)

## Execution Flow

```
1. Validate DOC_ID (non-empty, safe characters)
2. Validate IMAGE_PATH (exists, supported extension, file size < 20MB)
3. Validate INDEX (integer >= -1, default -1)
4. Check lark-cli availability and authentication
5. Step 1: Create empty image block (block_type 27) at position INDEX
           → lark-cli api POST /open-apis/docx/v1/documents/{docId}/blocks/{docId}/children
6. Step 2: Upload image file via Drive Media API
           → lark-cli drive medias upload_all --parent-type docx_image --parent-node {docId}
           → Fallback: lark-cli api POST /open-apis/drive/v1/medias/upload_all
7. Step 3: Bind uploaded file to image block via replace_image
           → lark-cli api PATCH /open-apis/docx/v1/documents/{docId}/blocks/{imageBlockId}
8. On Step 2/3 failure: Rollback — delete empty block created in Step 1
9. Report success with block_id and file_token
```

## When to Use

1. **Document generation with charts**: When the agent creates a document with charts/screenshots that need to be inline with text (e.g., reports, analysis).
2. **Image positioning**: When `lark-cli docs +media-insert` is insufficient because it only appends to the document end.
3. **Not for**: Simple end-of-document image insertion (use `lark-cli docs +media-insert` directly instead).

## Architecture

Uses lark-cli for all Feishu API calls — consistent with existing skills (rename-group, chat, etc.).
Authentication is handled entirely by lark-cli; this skill never reads app credentials directly.

Three-step Feishu API flow:
1. **Create** an empty image block (`block_type: 27`) at the target position
2. **Upload** the image file via Drive Media Upload API (`parent_type: docx_image`)
3. **Bind** the uploaded file to the empty block via `replace_image`

## Safety Guarantees

- **Input validation**: DOC_ID, IMAGE_PATH, and INDEX are strictly validated
- **Rollback on partial failure**: If upload or bind fails, the empty block is deleted
- **No direct credential access**: Only uses lark-cli's built-in authentication
- **File size limit**: Images must be under 20MB (Feishu API limit)
- **Idempotent insert**: Inserting at the same position multiple times creates multiple blocks (caller should manage deduplication)
