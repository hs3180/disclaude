---
name: upload-feishu-doc-image
description: Upload and insert an image at a specific position in a Feishu document. Use when the agent needs to embed charts, screenshots, or any image into a Feishu doc at a precise location (not just appended at the end). Keywords: "上传飞书文档图片", "insert image feishu", "飞书图片", "文档图片插入", "inline image".
allowed-tools: [Bash]
---

# Upload Feishu Document Image

Insert an image at a specific position in a Feishu document via a 3-step Lark API process.

## Single Responsibility

- ✅ Insert an image at a specific index in a Feishu document
- ✅ Validate document ID, image file path, and insertion index
- ✅ Roll back on partial failure (clean up empty image blocks)
- ✅ Use lark-cli for authentication and API calls
- ❌ DO NOT create documents (use `lark-cli docs +create` instead)
- ❌ DO NOT append text blocks
- ❌ DO NOT handle document creation or markdown rendering

## When to Use This Skill

1. **Agent generates a report with charts**: After creating a Feishu document with `lark-cli docs +create --markdown`, use this skill to insert chart images at the correct positions.
2. **Inserting screenshots or diagrams**: When the agent needs to place visual content at a specific location in a document.
3. **Correcting image positions**: When `lark-cli docs +media-insert` (which always appends to the end) places images incorrectly.

## Invocation

### Usage

```bash
DOC_ID="your_doc_id" \
IMAGE_PATH="./chart.png" \
INSERT_INDEX="3" \
npx tsx skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_ID` | Yes | Feishu document ID (from URL or `lark-cli docs +create` output) |
| `IMAGE_PATH` | Yes | Local path to the image file (PNG, JPG, JPEG, GIF, BMP, WEBP) |
| `INSERT_INDEX` | No | Insertion position (0-based index). Default: -1 (append to end) |
| `UPLOAD_SKIP_LARK` | No | Set to '1' to skip actual API calls (dry-run for testing) |

### Context Variables

When invoked, you receive:
- **DOC_ID**: from the URL of the Feishu document (e.g., `https://xxx.feishu.cn/docx/DOC_ID`)
- **IMAGE_PATH**: path to the image file that needs to be inserted
- **INSERT_INDEX**: the desired position in the document (count existing blocks from 0)

## Execution Flow

```
1. Validate inputs (DOC_ID, IMAGE_PATH, INSERT_INDEX)
2. Check lark-cli availability and authentication
3. Step 1: Create empty image block at index via lark-cli api
4. Step 2: Upload image file via Drive Media Upload API
5. Step 3: Bind uploaded file to the image block via lark-cli api
6. Report success with block_id and file_token
```

### Error Recovery

- If Step 1 succeeds but Step 2 or 3 fails → delete the empty image block (rollback)
- If image upload fails after 3 retries → abort and report error
- If lark-cli is not authenticated → exit with clear message to run `lark-cli auth` first

## Architecture

### 3-Step Lark API Process

1. **Create Block**: `POST /open-apis/docx/v1/documents/{docId}/blocks/{docId}/children`
   - Creates an empty image block (`block_type: 27`) at the specified `index`
   - Returns the new block's ID

2. **Upload Image**: `POST /open-apis/drive/v1/medias/upload_all`
   - Uploads image binary via multipart/form-data (`parent_type: "docx_image"`)
   - Uses lark-cli's authentication (reads credentials from lark-cli config)
   - Returns a `file_token`

3. **Bind Image**: `PATCH /open-apis/docx/v1/documents/{docId}/blocks/{blockId}`
   - Uses `replace_image` to bind the uploaded file to the empty block

### Authentication

- Steps 1 and 3 use `lark-cli api` (handles auth internally)
- Step 2 uses the same credentials from lark-cli's config for the multipart upload
- No direct reading of `FEISHU_APP_ID`/`FEISHU_APP_SECRET` environment variables

## Safety Guarantees

- **Input validation**: DOC_ID format check, image file existence and format check, index range validation
- **Rollback on failure**: Empty image blocks are cleaned up if the upload or bind step fails
- **Idempotent**: Re-inserting at the same position creates a new block (not destructive)
- **No IPC**: Direct lark-cli calls, consistent with other skills (rename-group, etc.)
- **File size limit**: Maximum 20MB per image (Feishu API limit)
