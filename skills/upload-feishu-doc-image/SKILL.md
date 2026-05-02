---
name: upload-feishu-doc-image
description: "Upload and insert an image into a Feishu document at a specific position. Use when the agent needs to embed charts, screenshots, or any image into a Feishu doc at a precise location (not just appended at the end). Keywords: \"上传飞书文档图片\", \"insert image feishu\", \"飞书图片\", \"文档图片插入\", \"inline image\"."
allowed-tools: [Bash]
---

# Upload Feishu Doc Image

Insert an image into a Feishu document at a **specific position** using the Lark API 3-step process.

## Single Responsibility

- ✅ Insert an image at a specific position in a Feishu document
- ✅ Support `index` parameter for position control
- ✅ Clean up empty blocks on partial failure
- ✅ Use lark-cli's own authentication (no separate credential setup)
- ❌ DO NOT create or manage Feishu documents
- ❌ DO NOT read FEISHU_APP_ID / FEISHU_APP_SECRET from disclaude config
- ❌ DO NOT append images to document end (use `lark-cli docs +media-insert` for that)

## When to Use

1. **Agent generates a chart/image and needs to insert it into a specific position** in a Feishu document
2. **Creating illustrated reports** where images must appear alongside relevant text, not at the end
3. Keywords in user request: "在文档第N个位置插入图片", "图片插到正文里", "图表放到报告中"

## Invocation

```bash
DOC_ID="docxXXXXX" \
IMAGE_PATH="./chart.png" \
INSERT_INDEX="3" \
npx tsx skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_ID` | Yes | Feishu document ID (the string after `/docx/` in the URL) |
| `IMAGE_PATH` | Yes | Local path to the image file (PNG, JPG, JPEG, GIF, BMP, WEBP) |
| `INSERT_INDEX` | No | Position to insert at (0-based). Omit or `-1` to append at end |

### Context Variables

When invoked, you receive:
- **DOC_ID**: from the Feishu document URL or context
- **IMAGE_PATH**: the local file path of the image to upload

### Authentication

This skill uses **lark-cli's own authentication** — the same credentials lark-cli uses for API calls. Ensure lark-cli is installed and authenticated before using this skill.

## Execution Flow

```
1. Validate inputs (DOC_ID, IMAGE_PATH, file size ≤ 20MB)
2. Check lark-cli availability
3. Obtain tenant_access_token from lark-cli credentials
4. Step 1: Create empty image block (block_type: 27) at INSERT_INDEX
5. Step 2: Upload image file via multipart/form-data
6. Step 3: Bind uploaded image to block via replace_image
7. On failure in step 2/3: delete the empty block to prevent garbage
```

## Output

On success: `OK: Image inserted at index {N}, block_id={id}`
On failure: `ERROR: {message}` with exit code 1

## Architecture

Uses direct Lark API calls via Node.js `fetch` (not `lark-cli api`) because:
- Step 2 requires `multipart/form-data` upload which `lark-cli api` does not support
- The 3-step process requires coordination between block creation and file upload

### 3-Step Lark API Process

1. **Create Block** — `POST /open-apis/docx/v1/documents/{docId}/blocks/{docId}/children`
   - Creates empty image block (`block_type: 27`) at desired index

2. **Upload Image** — `POST /open-apis/drive/v1/medias/upload_all`
   - Uploads image via multipart/form-data (`parent_type: "docx_image"`)
   - Returns a `file_token`

3. **Bind Image** — `PATCH /open-apis/docx/v1/documents/{docId}/blocks/{blockId}`
   - Uses `replace_image` to bind uploaded file to the empty block

### Partial Failure Handling

If step 1 succeeds but step 2 or 3 fails:
- The empty image block is deleted via `DELETE /open-apis/docx/v1/documents/{docId}/blocks/{blockId}/children`
- This prevents leaving gray placeholder blocks in the document

## Safety Guarantees

- **Input validation**: DOC_ID format, file extension whitelist, file size limit (20MB)
- **Auth via lark-cli**: Uses same credential source as other skills (rename-group, etc.)
- **Atomic cleanup**: Empty blocks are removed on failure
- **No external dependencies**: Uses only Node.js built-ins (`fetch`, `Buffer`, `fs`)
- **Idempotent blocks**: Creating an image block at the same index is safe (API handles ordering)
