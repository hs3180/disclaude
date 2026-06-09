---
name: deep-task
description: "[DEPRECATED] Use the `loop` skill instead. Loop 系统提供更简洁的自主任务执行模式。请使用 loop skill 替代。"
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Deep Task — DEPRECATED

> **此 Skill 已废弃。** 请使用 `loop` skill 替代。
>
> Loop 系统提供更简洁的自主任务执行模式：
> - `loop` skill：创建 LOOP.md + 飞书群 + schedule，自动循环执行
> - 进度跟踪通过 LOOP.md checkbox 实现
> - 完成判断通过 `<promise>DONE</promise>` 信号自动停止
>
> 用法：向 agent 说「创建一个 loop 任务」或「循环执行 xxx」即可。

## Migration Guide

| Deep Task | Loop |
|-----------|------|
| deep-task → evaluator → executor 循环 | loop skill → schedule tick 循环 |
| evaluation.md + execution.md | LOOP.md checkbox |
| evaluator agent 判断完成 | checkbox 全勾完 + DONE signal |
| Task.md 规范 | LOOP.md 待办清单 |

如需使用旧版 Deep Task 系统，请参考 git 历史中的 evaluator 和 executor skill。
