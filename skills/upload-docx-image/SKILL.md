---
name: upload-docx-image
description: Upload and insert an image into a Feishu document at a specific position. Uses three-step API flow: create empty image block → upload via Drive Media API → bind image to block. Keywords: "上传图片", "插入图片", "文档图片", "upload image", "insert image", "docx image".
allowed-tools: [Bash]
---

# Upload Docx Image

Insert an image into a Feishu document at a specified position using a three-step API flow via lark-cli.

## Single Responsibility

- ✅ Insert an image into a Feishu document at a specific index
- ✅ Upload image file via Drive Media Upload API (`parent_type: docx_image`)
- ✅ Rollback on partial failure (delete empty block if upload/bind fails)
- ❌ DO NOT create or delete documents
- ❌ DO NOT manage document text content
- ❌ DO NOT use IPC Channel for document operations

## Invocation

This skill is invoked by the agent when it needs to insert an image into a Feishu document at a specific position (not just append to the end).

### Usage

```bash
UPLOAD_DOC_ID="xxxxxx" \
UPLOAD_IMAGE_PATH="/path/to/image.png" \
UPLOAD_INDEX="3" \
npx tsx skills/upload-docx-image/upload-docx-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `UPLOAD_DOC_ID` | Yes | Feishu document ID |
| `UPLOAD_IMAGE_PATH` | Yes | Local file path to the image (max 20 MB) |
| `UPLOAD_INDEX` | No | Insertion position index (default: append to end) |
| `UPLOAD_SKIP_LARK` | No | Set to '1' to skip lark-cli check (testing only) |

### Context Variables

When invoked, you receive:
- **Document ID**: Feishu document ID (from the document being edited)

Use the Document ID as `UPLOAD_DOC_ID`.

## Execution Flow

```
1. Validate UPLOAD_DOC_ID, UPLOAD_IMAGE_PATH
2. Check lark-cli availability
3. If appending (no UPLOAD_INDEX), count existing block children to determine index
4. Create empty image block (block_type: 27) at target index
   → lark-cli api POST /open-apis/docx/v1/documents/{docId}/blocks/{docId}/children
5. Upload image file via Drive Media Upload API (multipart/form-data)
   → POST /open-apis/drive/v1/medias/upload_all (parent_type: docx_image)
6. Bind uploaded image to block (replace_image)
   → lark-cli api PATCH /open-apis/docx/v1/documents/{docId}/blocks/{blockId}
7. On step 5/6 failure: rollback by deleting the empty block
```

## When to Use

1. **Agent generates a document with images**: After writing markdown content to a Feishu document, insert chart/diagram images at specific positions within the document body.
2. **Image requirements**:
   - Supported formats: jpg, jpeg, png, gif, webp, bmp, svg, tiff
   - Max size: 20 MB
   - Images are uploaded as `docx_image` type

## Architecture

This skill implements a three-step API flow because `lark-cli docs +media-insert` only appends images to the end of a document. To insert at a specific position:

1. **Create empty block**: Uses `lark-cli api` to create an empty image block (`block_type: 27`) at the target index
2. **Upload image**: Reads the tenant access token from lark-cli's cached config, then manually constructs multipart/form-data to upload via the Drive Media Upload API
3. **Bind image**: Uses `lark-cli api` to update the empty block with the uploaded image token (`update_image`)

**Authentication**: Uses lark-cli's built-in authentication — reads the cached tenant access token from `~/.config/lark/config.json`. Does NOT read `FEISHU_APP_ID`/`FEISHU_APP_SECRET` from environment variables.

## Safety Guarantees

- **Input validation**: Document ID must be non-empty, image file must exist and be under 20 MB
- **Position control**: Supports explicit index for precise positioning
- **Rollback**: If upload or bind fails, the empty image block is deleted (best-effort)
- **Auth via lark-cli**: No direct credential management — reuses lark-cli's tenant token
