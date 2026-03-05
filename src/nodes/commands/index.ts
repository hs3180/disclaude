/**
 * Command System - DI-based command registration and discovery.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #696: 拆分 builtin-commands.ts
 */

// Types and registry
export * from './types.js';
export * from './command-registry.js';

// Session commands
export { ResetCommand, StatusCommand, HelpCommand } from './session-commands.js';

// Node commands
export { ListNodesCommand, SwitchNodeCommand, RestartCommand } from './node-commands.js';

// Group commands
export {
  CreateGroupCommand,
  AddGroupMemberCommand,
  RemoveGroupMemberCommand,
  ListGroupMembersCommand,
  ListGroupCommand,
  DissolveGroupCommand,
} from './group-commands.js';

// Passive command
export { PassiveCommand } from './passive-command.js';

// Debug commands
export { SetDebugCommand, ShowDebugCommand, ClearDebugCommand } from './debug-commands.js';

// Schedule command
export { ScheduleCommand } from './schedule-command.js';

// Task command
export { TaskCommand } from './task-command.js';

// Registration function
export { registerDefaultCommands } from './builtin-commands.js';
