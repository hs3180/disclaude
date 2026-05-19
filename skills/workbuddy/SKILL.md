---
name: workbuddy
description: Remote control WorkBuddy instances for local development operations
user-invocable: true
argument-hint: "[project-name] [command] [args...]"
---

# WorkBuddy Remote Control

## Context

You have access to WorkBuddy — a lightweight agent running on the user's local development machine. WorkBuddy can execute local commands like building, previewing, and publishing WeChat mini programs.

## Capabilities

- Execute commands on a remote WorkBuddy instance
- Check WorkBuddy health status
- List configured WorkBuddy projects
- Support for WeChat DevTools CLI operations

## Workflow

1. Check available WorkBuddy projects by reading the configuration
2. If the user specifies a project name, target that instance
3. If the user's current chatId is bound to a WorkBuddy, use that instance
4. Execute the requested command via HTTP
5. Report results back to the user

## Available Commands

### WeChat DevTools

| Command | Description |
|---------|-------------|
| `preview` | Generate preview QR code |
| `upload` | Upload code to WeChat backend |
| `open` | Open project in devtools |
| `close` | Close project |
| `build-npm` | Build npm packages |
| `cache clean` | Clean devtools cache |

### General

| Command | Description |
|---------|-------------|
| `health` | Check WorkBuddy instance health |
| `exec <cmd>` | Execute arbitrary shell command |

## Important Notes

- WorkBuddy runs on the user's local machine, not the server
- Communication happens over HTTP; ensure the WorkBuddy URL is accessible
- If a command fails, check WorkBuddy health first
- For file operations (like QR code images), the result will include file paths on the local machine
- Always confirm before executing destructive operations (upload, cache clean)
