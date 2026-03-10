---
type: blocking           # blocking | non-blocking
purpose: pr-review       # pr-review | offline-question | agent-confirm
channel:
  type: group            # group | private | existing
  name: "示例会话"        # 群名（type=group 时）
  chatId: null           # 现有chatId（type=existing 时）
  members: []            # 成员列表
context: {}              # 自定义上下文数据
expiresIn: 24h
---

# 🔔 示例会话标题

这里是会话的主要内容...

## 选项

- [option1] 选项1描述
- [option2] 选项2描述
- [option3] 选项3描述

---

*此会话由临时会话管理系统创建*
