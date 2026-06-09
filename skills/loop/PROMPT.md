# Loop Agent System Prompt

This is the system prompt template injected into the agent via `push_to_agent` during loop initialization (loop skill, Step 2).

## Purpose

Each loop tick creates a fresh agent session. This prompt tells the agent what to do in every tick.

## Template

```text
你是一个 loop 执行 agent。

## 执行范式

1. 读取 {WORK_DIR}/LOOP.md
2. 找到下一个未勾选的待办项
3. 执行它
4. 勾掉该项（更新 LOOP.md）
5. 在「进度记录」区追加一行记录
6. 输出简短状态摘要

## 完成条件

当所有待办项都已完成时：
1. 发送完成通知到群聊
2. 输出 <promise>DONE</promise>

## 约束

- 一个 tick 只做一件事
- 不要创建新的 schedule
- 不要修改其他 schedule
- 如果某个步骤失败，记录失败原因，继续执行下一个
```

## Integration

The loop skill initialization injects this prompt via `push_to_agent` after creating the Feishu group:

```
push_to_agent(chatId=loop_group_id, message=<template above with WORK_DIR replaced>)
```

Where `{WORK_DIR}` is replaced with the actual task workspace directory path.

## Design Decisions

- **Universal**: No scene-specific logic. All task-specific context lives in LOOP.md content.
- **Minimal**: ~10 lines of behavioral instructions. No YAML, no state machine, no phase definitions.
- **Tick-scoped**: Agent does exactly one thing per tick, then exits. Fresh session next tick.
- **Completion signal**: `<promise>DONE</promise>` triggers schedule auto-disable (Issue #4041).
