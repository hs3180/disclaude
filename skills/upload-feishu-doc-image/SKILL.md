---
name: upload-feishu-doc-image
description: Upload and insert an image into a Feishu document at a specific position. Use when the agent needs to embed charts, screenshots, or any image into a Feishu doc at a precise location (not just appended at the end). Keywords: "上传飞书文档图片", "insert image feishu", "飞书图片", "文档图片插入", "inline image".
allowed-tools: Bash
---

# Upload Feishu Doc Image

Insert an image into a Feishu document at a specific position using the three-step Lark API flow.

## Single Responsibility

- ✅ Upload a local image file into a Feishu document at a specified position (index)
- ✅ Validate inputs (document ID, image path, index)
- ✅ Handle partial failures with rollback (delete empty block on upload/bind failure)
- ❌ DO NOT create or modify documents (use lark-cli docs commands for that)
- ❌ DO NOT send images in chat messages (use send-file for that)
- ❌ DO NOT read FEISHU_APP_ID / FEISHU_APP_SECRET from environment variables

## Invocation

This skill is invoked by the agent when it needs to insert an image into a Feishu document at a specific position.

### Usage

```bash
DOC_ID="doccnxxxxxx" \
IMAGE_PATH="/path/to/chart.png" \
IMAGE_INDEX="3" \
npx tsx skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_ID` | Yes | Feishu document ID (from URL or lark-cli output) |
| `IMAGE_PATH` | Yes | Local file path to the image |
| `IMAGE_INDEX` | No | Insert position (0-based). Default: -1 (append to end) |
| `SKIP_LARK` | No | Set to '1' to skip lark-cli calls (dry-run testing) |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)

## Execution Flow

```
1. Validate inputs: DOC_ID format, IMAGE_PATH exists and is valid image, INDEX range
2. Check lark-cli availability and authentication
3. Create empty image block (block_type: 27) at desired index via lark-cli api
4. Upload image file to Drive via Lark Media Upload API (multipart)
5. Bind uploaded file to image block via lark-cli api (replace_image)
6. On step 4 or 5 failure: rollback by deleting the empty block
7. Report success with block ID or failure with details
```

## Three-Step API Flow

### Step 1: Create Empty Image Block

```
POST /open-apis/docx/v1/documents/{doc_id}/blocks/{doc_id}/children
Body: { "children": [{ "block_type": 27 }], "index": N }
```

Returns the new block's `block_id`.

### Step 2: Upload Image (multipart)

```
POST /open-apis/drive/v1/medias/upload_all?parent_type=docx_image&parent_node={doc_id}
Content-Type: multipart/form-data
Body: file binary
```

Returns `file_token` for the uploaded image.

### Step 3: Bind Image to Block

```
PATCH /open-apis/docx/v1/documents/{doc_id}/blocks/{block_id}
Body: { "replace_image": { "token": "{file_token}" } }
```

Binds the uploaded image to the empty block.

### Rollback

If step 2 or 3 fails, the empty block created in step 1 is deleted:

```
DELETE /open-apis/docx/v1/documents/{doc_id}/blocks/{block_id}/children/batch_delete
Body: { "start_index": N, "end_index": N + 1 }
```

## When to Use

1. **Generating reports with charts**: After creating a Feishu doc with text, insert chart images at specific positions
2. **Inserting screenshots**: Add screenshots between text paragraphs in a document
3. **Any inline image insertion**: When the image must appear at a specific position, not just at the end

## Architecture

This skill uses **lark-cli** for Feishu API authentication and JSON API calls. For the multipart file upload (step 2), it reads lark-cli's stored credentials to obtain a tenant_access_token and uses Node.js native `fetch`.

- Steps 1, 3, and rollback: `lark-cli api` (handles auth internally)
- Step 2: Node.js `fetch` with token from lark-cli config

## Safety Guarantees

- **Input validation**: DOC_ID format, image file existence/size/type, index range
- **Rollback on failure**: Empty blocks are cleaned up if upload or bind fails
- **No credential exposure**: Uses lark-cli's auth mechanism, never reads FEISHU_APP_ID/FEISHU_APP_SECRET env vars
- **Idempotent**: Re-running with the same inputs inserts a new image (does not deduplicate)
