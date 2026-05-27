---
name: lark-docs
description: "Feishu/Lark document operations via lark-cli. Read, upload, import, export, and manage Feishu docs. Keywords: '飞书文档', '上传文档', '读飞书文档', 'lark cli', '导入文档', '导出文档', 'upload to feishu', 'feishu doc', 'lark doc', 'lark-cli', 'feishu.cn', '读文档'."
argument-hint: "<action> [file|url] -- [lark-cli flags]"
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Skill: Lark Docs (飞书文档操作)

通过 lark-cli 操作飞书文档。所有命令使用 `--as bot`，token 由环境自动注入。

## 触发条件

- prompt 含飞书文档链接 → 用 `docs +fetch` 读取
- 上传/导入/导出/权限管理 → 用对应 lark-cli 命令

## 核心操作速查

| 操作 | 命令 |
|------|------|
| 读取文档 | `docs +fetch --doc "$URL_OR_TOKEN" --as bot` |
| 导入 MD | `drive +import --file ./file.md --type docx --as bot` |
| 上传文件 | `drive +upload --file ./file.png --as bot` |
| 导出文档 | `drive +export --token $TOKEN --doc-type docx --file-extension pdf --as bot` |
| 创建文件夹 | `drive +create-folder --name "名称" --as bot` |
| 通用 API | `api GET /open-apis/xxx --params '{}' --as bot` |

**通用规则：** `--file` 必须是相对路径（先 `cd` 到文件目录）。

## 导入后授权（必须）

bot 创建的文档用户无法访问，导入后必须授权：

```bash
lark-cli drive permission.members create \
  --params '{"token":"'$DOC_TOKEN'","type":"docx","need_notification":false}' \
  --data '{"member_type":"openid","member_id":"'$USER_OPEN_ID'","perm":"full_access"}' \
  --as bot --yes
```

用 `full_access` 而非 `transfer_owner`：bot 保持 owner 保留全部权限，用户获得完整操作权限。

## 创建带图表的飞书文档

用户写自然 Markdown，Skill 自动处理图片插入。

### 流程（4 步）

**Step 1: 解析 MD，提取本地图片路径，替换为文本标记**

```python
import re, os, json
md = open('report.md').read()
images = []
def replace(m):
    alt, path = m.group(1), m.group(2)
    if path.startswith(('http', 'data:')): return m.group(0)
    abs_path = os.path.normpath(os.path.join(os.path.dirname('report.md'), path))
    images.append({'path': abs_path, 'rel': path})
    return f'\n\n[IMG:{path}]\n\n'  # 路径本身作为标记，精准且自描述
md = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', replace, md)
md = re.sub(r'\n{3,}', '\n\n', md)
open('report_clean.md', 'w').write(md)
# images 列表后续用于逐张插入
```

**Step 2: 导入转换后的 MD（不含图片语法，只有 `[IMG:路径]` 文本标记）**

```bash
lark-cli docs +create --title "标题" --markdown @report_clean.md --as bot
# → 得到 DOC_ID
```

**Step 3: 逐张插入图片并删除标记**

```bash
# 对每张图片执行 2 步：插入 + 删除标记
lark-cli docs +media-insert --doc "$DOC_ID" \
  --file ./charts/chart.png --type image \
  --caption "图表说明" \
  --selection-with-ellipsis "[IMG:./charts/chart.png]" \
  --align center --as bot --before

lark-cli docs +update --doc "$DOC_ID" \
  --mode delete_range \
  --selection-with-ellipsis "[IMG:./charts/chart.png]" \
  --as bot
```

**Step 4: 授权用户（见上方授权模板）**

### 关键原理

- `[IMG:./charts/chart.png]` 使用**本地路径作为标记文本**，精准且自描述
- 导入后成为独立文本 block，`--selection-with-ellipsis` 精准匹配（路径不会与正文重复）
- `--before` 在标记前插入图片 → `delete_range` 删除标记 → 图片留在正确位置
- **不要**跳过 `delete_range`，否则标记文本残留在文档中

### 注意事项

- `--file` 必须是相对路径，先 `cd` 到文件目录
- 定位失败时用 `docs +fetch --scope outline` 确认标记文本存在
- 多张图片按顺序处理（index 会随插入递增，但标记文本唯一所以不受影响）

## 错误排查

| 错误 | 原因 | 解决 |
|------|------|------|
| unsafe file path | `--file` 用了绝对路径 | `cd` 到目录后用 `./filename` |
| permission denied | bot 文档用户无权限 | 调用 `permission.members create` |
| 1063001 (transfer_owner) | `--data` 字段嵌套了 | `member_type/member_id` 必须顶层 |
| --as bot not supported | 部分 search 命令仅支持 user | 改用 `api` 通用调用 |

## DO NOT

- **不要** 用绝对路径作 `--file` 参数
- **不要** 用 Playwright/curl 访问飞书文档链接 — 用 `docs +fetch --as bot`
- **不要** 在 MD 中用 `![alt](local_path)` 直接导入期望图片出现 — 会变空白占位符，必须先替换为文本标记再插入
- **不要** 跳过 `delete_range` 删除标记 — 标记文本会残留在文档中
