/**
 * Built-in Commands - Default command implementations.
 *
 * This file re-exports all command classes from their respective modules
 * and provides a unified registration function.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #537: 完成所有指令的 DI 重构
 * Issue #696: 拆分 builtin-commands.ts
 */

import type { Command } from './types.js';

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
  PassiveCommand,
} from './group-commands.js';

// Debug commands
export { SetDebugCommand, ShowDebugCommand, ClearDebugCommand } from './debug-commands.js';

// Schedule command
export { ScheduleCommand } from './schedule-command.js';

// Task command
export { TaskCommand } from './task-command.js';

// Import for registration function
import { ResetCommand, StatusCommand, HelpCommand } from './session-commands.js';
import { ListNodesCommand, SwitchNodeCommand, RestartCommand } from './node-commands.js';
import {
  CreateGroupCommand,
  AddGroupMemberCommand,
  RemoveGroupMemberCommand,
  ListGroupMembersCommand,
  ListGroupCommand,
  DissolveGroupCommand,
  PassiveCommand,
} from './group-commands.js';
import { SetDebugCommand, ShowDebugCommand, ClearDebugCommand } from './debug-commands.js';
import { ScheduleCommand } from './schedule-command.js';
import { TaskCommand } from './task-command.js';

/**
 * Register default commands to a registry.
 */
export function registerDefaultCommands(
  registry: { register: (cmd: Command) => void },
  generateHelpText: () => string
): void {
  // Session commands
  registry.register(new ResetCommand());
  registry.register(new StatusCommand());
  registry.register(new HelpCommand(generateHelpText));

  // Node commands
  registry.register(new ListNodesCommand());
  registry.register(new SwitchNodeCommand());
  registry.register(new RestartCommand());

  // Group commands
  registry.register(new CreateGroupCommand());
  registry.register(new AddGroupMemberCommand());
  registry.register(new RemoveGroupMemberCommand());
  registry.register(new ListGroupMembersCommand());
  registry.register(new ListGroupCommand());
  registry.register(new DissolveGroupCommand());
  registry.register(new PassiveCommand());

  // Debug commands
  registry.register(new SetDebugCommand());
  registry.register(new ShowDebugCommand());
  registry.register(new ClearDebugCommand());

  // Schedule management command (Issue #469)
  registry.register(new ScheduleCommand());

  // Task control command (Issue #468)
  registry.register(new TaskCommand());
}
