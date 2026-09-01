# Bug: lark-cli 子命令 +resource-download 已改名为 +messages-resources-download，导致所有图片/文件下载失败

**优先级**: P0 (所有图片/文件下载完全不可用)
**发现日期**: 2026-06-08
**状态**: Open

---

## 问题描述

所有通过飞书发送的图片、文件、音频、媒体消息都无法下载，用户收到的是 "用户上传了一个图片，但下载失败" 的降级提示。

## 根因

lark-cli 更新后，子命令 `+resource-download` 被重命名为 `+messages-resources-download`，代码未同步更新。

## 日志证据

```
Error: Command failed: npx @larksuite/cli im +resource-download ...
{
  "ok": false,
  "error": {
    "type": "unknown_subcommand",
    "message": "unknown subcommand \"+resource-download\" for \"lark-cli im\"",
    "detail": {
      "available": [
        "+messages-resources-download",   ← 新名称
        ...
      ]
    }
  }
}
```

## 影响范围

- `packages/primary-node/src/channels/feishu/message-handler.ts:202` — `downloadResourceViaLarkCli()` 方法
- 影响所有 `image`、`file`、`media`、`audio` 类型消息的下载

## 修复方案

将 `message-handler.ts` 第 202 行的 `+resource-download` 改为 `+messages-resources-download`。

```diff
- '@larksuite/cli', 'im', '+resource-download',
+ '@larksuite/cli', 'im', '+messages-resources-download',
```

**注意**: 需确认新命令的参数格式（`--message-id`、`--file-key`、`--type`、`--output`、`--as`）是否与旧命令一致。

## 复现步骤

1. 在飞书群中发送任意图片或文件
2. 观察机器人端收到的消息为 "用户上传了一个图片，但下载失败"
3. 检查日志可见 `unknown_subcommand` 错误

## 建议

1. 修复后添加 lark-cli 版本兼容性检查，避免后续升级再出现类似问题
2. 可考虑在启动时验证子命令是否存在，提前报错而非运行时才发现
