---
name: upload-docx-image
description: Upload and insert an image into a Feishu document at a specific position. Use when the agent needs to insert a local image file into a Feishu docx document at a given block index. Keywords: "上传文档图片", "插入图片", "文档插图", "upload image", "insert image", "docx image".
allowed-tools: [Bash]
---

# Upload Docx Image

Upload a local image file and insert it into a Feishu document at a specific position using lark-cli.

## Single Responsibility

- ✅ Upload a local image to Feishu Drive as document media
- ✅ Create an image block at a specific index in the document
- ✅ Bind the uploaded file_token to the image block
- ✅ Clean up empty blocks on partial failure (rollback)
- ✅ Validate document ID, image path, and insert index
- ❌ DO NOT create or delete documents
- ❌ DO NOT modify document text or other block types
- ❌ DO NOT handle image URL insertion (use `lark-cli docs +update` for URL images)

## Invocation

This skill is invoked by the agent when it needs to insert a local image into a Feishu docx document at a specific position.

### Usage

```bash
DOC_ID="doxcnXXXXXX" \
IMAGE_PATH="/path/to/image.png" \
INSERT_INDEX="3" \
npx tsx skills/upload-docx-image/upload-docx-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_ID` | Yes | Feishu document ID (e.g. doxcnXXX, docxXXX) |
| `IMAGE_PATH` | Yes | Absolute or relative path to the image file |
| `INSERT_INDEX` | Yes | 0-based index of where to insert the image block among the document's children |
| `UPLOAD_SKIP_LARK` | No | Set to '1' to skip lark-cli check (testing/dry-run only) |

### Context Variables

When invoked, you receive:
- **Document ID**: From "doc_id" or "document_id" in the task context
- **Image path**: Local file path to the image
- **Insert index**: Position where the image should be inserted (0 = first child, -1 = append to end)

## Execution Flow

```
1. Validate DOC_ID (must be non-empty, alphanumeric with underscores)
2. Validate IMAGE_PATH (file must exist and be a supported image format)
3. Validate INSERT_INDEX (must be a non-negative integer)
4. Check lark-cli availability and authentication
5. Create empty image block at INSERT_INDEX via lark-cli api POST
   POST /open-apis/docx/v1/apps/{docId}/blocks/{docId}/children
   Body: {"children":[{"block_type":27}],"index":N}
6. Upload image file as document media via lark-cli drive +upload --as-media
   lark-cli drive +upload --as-media --doc {docId} --file {imagePath}
7. Bind file_token to the image block via lark-cli api PATCH
   PATCH /open-apis/docx/v1/apps/{docId}/blocks/{blockId}
   Body: {"replace_image":{"token":"{file_token}"}}
8. On step 6 or 7 failure: rollback by deleting the empty block
   POST /open-apis/docx/v1/apps/{docId}/blocks/{docId}/children/batch_delete
   Body: {"start_index":N,"end_index":N+1}
9. Report success or failure
```

## When to Use

1. **Document content generation**: After generating a report or article, insert charts/diagrams at specific positions
2. **Screenshot insertion**: Insert screenshots or captured images into documentation
3. **Image enrichment**: Add visual content to existing Feishu documents
4. **Index reference**: 0-based index counts children of the document root block (usually the page block)

## Architecture

Image insertion uses a 3-step approach with **lark-cli** for all operations:

1. **Block creation** — `lark-cli api` (JSON body, no multipart)
2. **Image upload** — `lark-cli drive +upload --as-media` (handles multipart internally)
3. **Block binding** — `lark-cli api` (JSON body, no multipart)

Authentication is handled entirely by lark-cli's built-in auth system (keychain-based). No separate credentials needed.

## Supported Image Formats

- PNG (`.png`)
- JPEG (`.jpg`, `.jpeg`)
- GIF (`.gif`)
- BMP (`.bmp`)
- WebP (`.webp`)

Maximum file size: 20 MB (Feishu Drive media upload limit)

## Safety Guarantees

- **Input validation**: Document ID validated against allowed pattern, image path checked for existence and format
- **Rollback on failure**: Empty blocks created in step 1 are cleaned up if upload or bind fails
- **Index bounds**: Insert index validated as non-negative integer
- **Filename sanitization**: File basename extracted, path traversal characters stripped
- **No credential handling**: All auth delegated to lark-cli, no FEISHU_APP_ID/SECRET needed
- **Idempotent cleanup**: Best-effort rollback; logs warning if cleanup also fails
