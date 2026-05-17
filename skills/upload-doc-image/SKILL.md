---
name: upload-doc-image
description: Upload and insert an image into a Feishu document at a specific position. Use when the agent needs to add images to Feishu docs at specific locations (lark-cli +media-insert only appends). Keywords: "上传飞书文档图片", "文档插图", "insert image doc", "doc image", "飞书文档图片", "upload doc image".
allowed-tools: [Bash]
---

# Upload Feishu Document Image

Insert an image into a Feishu document at a specific position using the Lark API. Unlike `lark-cli docs +media-insert` (which only appends to the end), this skill supports inserting at any index.

## Single Responsibility

- ✅ Insert an image at a specific position in a Feishu document
- ✅ Validate document ID, image file, and position
- ✅ Handle the 3-step Lark API process (create block → upload → bind)
- ✅ Rollback empty blocks on partial failure
- ❌ DO NOT create or delete documents
- ❌ DO NOT modify document text content
- ❌ DO NOT handle image editing/resizing

## Problem

`lark-cli docs +media-insert` only appends images to the end of a document. This skill uses the Lark API directly to insert images at arbitrary positions, enabling properly formatted illustrated documents.

## Invocation

This skill is invoked by the agent when it needs to insert an image into a Feishu document at a specific position.

### Usage

```bash
DOC_ID="your_document_id" \
IMAGE_PATH="/path/to/image.png" \
INSERT_INDEX="3" \
npx tsx skills/upload-doc-image/upload-doc-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_ID` | Yes | Feishu document ID (from doc URL, alphanumeric with optional `_` and `-`) |
| `IMAGE_PATH` | Yes | Absolute path to the image file (PNG/JPG/JPEG/WEBP) |
| `INSERT_INDEX` | Yes | 0-based position to insert at (-1 to append to end) |
| `UPLOAD_SKIP_API` | No | Set to '1' to skip API calls (dry-run testing) |

### Context Variables

When invoked, you receive:
- **Document ID**: From the document URL or previous `lark-cli docs +create` output
- **Image path**: Local path to the generated chart/diagram image

## Execution Flow

```
1. Validate inputs (DOC_ID, IMAGE_PATH, INSERT_INDEX)
2. Check image file exists and size ≤ 20 MB
3. Verify lark-cli is available and authenticated
4. Step 1: Create empty image block (block_type: 27) at specified index via lark-cli api
5. Step 2: Upload image file via Drive Media Upload API (multipart/form-data)
6. Step 3: Bind uploaded file to image block via lark-cli api
7. On failure in steps 2/3: Rollback by deleting the empty block
8. Report block_id and file_token on success
```

## How It Works

### 3-Step Lark API Process

The Lark API requires 3 sequential calls to insert an image at a specific position:

1. **Create Block** — `lark-cli api POST /open-apis/docx/v1/documents/{docId}/blocks/{docId}/children`
   - Creates an empty image block (`block_type: 27`) at the desired index
   - Returns the new block's ID

2. **Upload Image** — `POST /open-apis/drive/v1/medias/upload_all` (direct fetch)
   - Uploads the image binary via multipart form-data
   - `parent_type: "docx_image"`, `parent_node: {docId}`
   - Returns a `file_token`

3. **Bind Image** — `lark-cli api PATCH /open-apis/docx/v1/documents/{docId}/blocks/{blockId}`
   - Uses `replace_image` to bind the uploaded file to the empty block

### Authentication

Steps 1 and 3 use `lark-cli api` which handles authentication automatically.
Step 2 (multipart upload) obtains auth credentials from lark-cli's config since `lark-cli api` does not support multipart/form-data uploads.

### Important: block_type 27 (not 4!)

The correct image block type is **27**. Using `block_type: 4` (which is actually Heading2) causes `invalid param` errors.

## When to Use

1. **Generating illustrated documents**: When creating reports with charts/diagrams that need proper placement
2. **Fixing image positions**: When images were appended but should be inline
3. **Combining with lark-cli**: Use `lark-cli docs +create --markdown` for text, then this skill for images

### Typical Workflow

```bash
# 1. Create document with text content
lark-cli docs +create --markdown @report.md
# → returns document_id

# 2. Generate chart/diagram
# (agent creates the image file)

# 3. Insert image at the right position
DOC_ID="xxx" IMAGE_PATH="./chart.png" INSERT_INDEX="3" \
  npx tsx skills/upload-doc-image/upload-doc-image.ts

# 4. Repeat for additional images
```

## Architecture

This skill uses a hybrid approach:
- **lark-cli api** for JSON API calls (steps 1 and 3) — handles auth automatically
- **Direct fetch()** for multipart upload (step 2) — lark-cli api does not support multipart/form-data

Authentication uses lark-cli's configured credentials, consistent with other skills (rename-group, chat).

## Safety Guarantees

- **Input validation**: DOC_ID must be alphanumeric (+`_`/`-`), image must be PNG/JPG/JPEG/WEBP, size ≤ 20 MB
- **Rollback**: If upload or bind fails, the empty block is automatically deleted
- **Filename sanitization**: Special characters in filenames are stripped to prevent header injection
- **Dry-run mode**: Set `UPLOAD_SKIP_API=1` to validate inputs without making API calls
