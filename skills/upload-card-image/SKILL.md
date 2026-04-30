---
name: upload-card-image
description: Upload a local image to Feishu and return image_key for embedding in card messages. Use when the agent needs to embed an image (chart, diagram, screenshot) into a Feishu card message. Keywords: "upload image", "上传图片", "卡片图片", "image_key", "嵌入图片", "card image", "inline image".
allowed-tools: [Bash]
---

# Upload Card Image

Upload a local image to Feishu and return the `image_key` for embedding in card messages (`send_card` / `send_interactive`).

## Single Responsibility

- ✅ Upload a local image file to Feishu via lark-cli
- ✅ Return `image_key` for use in card `img` elements
- ✅ Validate image file (format, size, existence)
- ❌ DO NOT send card messages (use `send_card` / `send_interactive` tools instead)
- ❌ DO NOT upload images for Feishu documents (use `upload-docx-image` skill instead)
- ❌ DO NOT read FEISHU_APP_ID / FEISHU_APP_SECRET directly — always use lark-cli auth

## When to Use

Use this skill when:
1. The agent generates an image (chart, diagram, screenshot) and needs to **embed it in a card message**
2. The card `img` element requires an `img_key` (Feishu `image_key`)
3. The image is a **local file** on the agent's filesystem

**Do NOT use when:**
- Sending images as standalone messages → use `send_file` tool instead
- Inserting images into Feishu documents → use `upload-docx-image` skill instead
- The image is already hosted (has a URL) → use URL directly in card

## Invocation

```bash
UPLOAD_IMAGE_PATH="/path/to/image.png" \
npx tsx skills/upload-card-image/upload-card-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `UPLOAD_IMAGE_PATH` | Yes | Local file path to the image to upload |
| `UPLOAD_SKIP_LARK` | No | Set to `1` for dry-run / testing (skips all API calls) |

### Context Variables

When invoked, you receive:
- **Image Path**: Local path to the image file (from a previous tool output like chart generation)

## Execution Flow

```
1. Validate UPLOAD_IMAGE_PATH (exists, supported format, size ≤ 10 MB)
2. Check lark-cli availability and authentication status
3. Upload image via lark-cli (POST /open-apis/im/v1/images)
   → Multiple strategies: high-level command, raw API with --form
4. Extract image_key from response
5. Output image_key to stdout (for Agent to use in send_card)
```

## Output

On success, the script outputs:

```
OK: image_key=<image_key_value>
```

The Agent should extract the `image_key` value and use it in the card JSON:

```json
{
  "elements": [
    {
      "tag": "img",
      "img_key": "<image_key_value>"
    }
  ]
}
```

## Prerequisites

- **lark-cli** must be installed (`npm install -g @larksuite/cli`)
- **lark-cli** must be authenticated (`lark-cli auth login --recommend`)
- The app must have **im:image** scope

## Supported Image Formats

| Format | Extension |
|--------|-----------|
| PNG | `.png` |
| JPEG | `.jpg`, `.jpeg` |
| GIF | `.gif` |
| BMP | `.bmp` |
| WebP | `.webp` |
| TIFF | `.tiff` |
| ICO | `.ico` |

**Max file size**: 10 MB

## Architecture

All Feishu API calls use **lark-cli** for authentication — no direct credential handling. The script follows the same pattern as `skills/rename-group/rename-group.ts`:
- `lark-cli api METHOD /path --form key=value` for multipart form uploads
- Multiple fallback strategies for different lark-cli versions

## Error Handling

- **Validation failure**: Script exits immediately with descriptive error
- **lark-cli not found**: Script exits with installation instructions
- **Auth failure**: Script exits with login instructions
- **Upload failure**: Script exits with error details and troubleshooting hints

## Safety Guarantees

- **Input validation**: Image format whitelist, file size check, path existence check
- **Auth check**: Verifies lark-cli is authenticated before making API calls
- **No credential access**: Uses lark-cli's built-in auth exclusively
- **Idempotent**: Uploading the same image multiple times returns different `image_key`s (safe to retry)

## Example

### Agent Workflow

1. Agent generates a chart image:
   ```bash
   python3 -c "import matplotlib; ..." > /tmp/chart.png
   ```

2. Agent invokes this skill:
   ```bash
   UPLOAD_IMAGE_PATH="/tmp/chart.png" npx tsx skills/upload-card-image/upload-card-image.ts
   ```

3. Script outputs:
   ```
   OK: image_key=img_v3_xxxx_yyyy
   ```

4. Agent uses `image_key` in card:
   ```json
   {
     "elements": [
      {"tag": "markdown", "content": "## Monthly Report"},
      {"tag": "img", "img_key": "img_v3_xxxx_yyyy"},
      {"tag": "markdown", "content": "Revenue increased by 15%"}
    ]
  }
  ```

## DO NOT

- ❌ Read FEISHU_APP_ID or FEISHU_APP_SECRET from environment — use lark-cli auth
- ❌ Use the @larksuiteoapi/node-sdk directly — use lark-cli CLI
- ❌ Attempt to upload non-image files
- ❌ Cache image_keys (they may expire or be invalidated)
- ❌ Send card messages from this skill — only return the image_key
